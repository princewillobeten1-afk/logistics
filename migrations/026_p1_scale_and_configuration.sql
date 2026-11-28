-- P1 Scalability, Distributed Rate Limiting & Intelligent Business Configuration
-- Non-destructive additive migration compatible with existing multi-tenant RLS.

BEGIN;

-- 1. Workspace Business Classification, Approved Configuration & Independent Feature Entitlements
CREATE TABLE IF NOT EXISTS workspace_configurations (
  org_id UUID PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  classification JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  entitlements JSONB NOT NULL DEFAULT '{}'::jsonb,
  growth_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE workspace_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_configurations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_configurations_tenant_isolation ON workspace_configurations;
CREATE POLICY workspace_configurations_tenant_isolation
  ON workspace_configurations
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logistics_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_configurations TO logistics_app;
  END IF;
END
$$;

-- 2. Distributed Per-Tenant Sliding-Window Rate Limiting Table
CREATE TABLE IF NOT EXISTS tenant_rate_limits (
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL,
  window_start_ms BIGINT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, bucket, window_start_ms)
);

CREATE INDEX IF NOT EXISTS idx_tenant_rate_limits_expires
  ON tenant_rate_limits (expires_at);

ALTER TABLE tenant_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_rate_limits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_rate_limits_tenant_isolation ON tenant_rate_limits;
CREATE POLICY tenant_rate_limits_tenant_isolation
  ON tenant_rate_limits
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logistics_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_rate_limits TO logistics_app;
  END IF;
END
$$;

-- 3. Server-Side Pagination Leading-Column Composite Indexes
CREATE INDEX IF NOT EXISTS idx_shipments_org_updated_desc
  ON shipments (org_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_shipments_org_state_updated_desc
  ON shipments (org_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_org_ordered_desc
  ON orders (org_id, ordered_at DESC);

CREATE INDEX IF NOT EXISTS idx_customers_org_active_name
  ON customers (org_id, active DESC, name ASC);

COMMIT;
