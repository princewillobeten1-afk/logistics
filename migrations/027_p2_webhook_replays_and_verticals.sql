-- P2 Distributed Webhook Replay TTL, Secondary Module Pagination Indexes,
-- 3PL Multi-Client Segregation & International Freight Customs Tracking
-- Non-destructive additive migration compatible with multi-tenant PostgreSQL RLS.

BEGIN;

-- 1. Add TTL expiry support to webhook_deliveries for distributed multi-instance replay cleanup
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours');

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_expires
  ON webhook_deliveries (expires_at);

-- 2. Third-Party Logistics (3PL) Client Accounts (strictly scoped within a 3PL's own workspace)
CREATE TABLE IF NOT EXISTS third_party_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  client_code TEXT NOT NULL,
  client_name TEXT NOT NULL,
  contact_email TEXT,
  sla_hours INTEGER NOT NULL DEFAULT 48,
  billing_model TEXT NOT NULL DEFAULT 'PER_PALLET_MONTH',
  dedicated_warehouses TEXT[] NOT NULL DEFAULT '{}',
  sku_prefixes TEXT[] NOT NULL DEFAULT '{}',
  monthly_storage_rate_usd NUMERIC(12, 2) NOT NULL DEFAULT 18.50,
  per_order_pick_fee_usd NUMERIC(12, 2) NOT NULL DEFAULT 3.25,
  active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, client_code)
);

CREATE INDEX IF NOT EXISTS idx_third_party_clients_org_active
  ON third_party_clients (org_id, active DESC, client_name ASC);

ALTER TABLE third_party_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE third_party_clients FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS third_party_clients_tenant_isolation ON third_party_clients;
CREATE POLICY third_party_clients_tenant_isolation
  ON third_party_clients
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logistics_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON third_party_clients TO logistics_app;
  END IF;
END
$$;

-- 3. International Freight & Customs Consignment Records (Air, Sea, Road, Rail)
CREATE TABLE IF NOT EXISTS international_freight_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  shipment_reference TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'EXPORT',
  transport_mode TEXT NOT NULL DEFAULT 'SEA',
  incoterm TEXT NOT NULL DEFAULT 'FOB',
  container_or_waybill TEXT NOT NULL,
  origin_country TEXT NOT NULL,
  destination_country TEXT NOT NULL,
  port_of_loading TEXT,
  port_of_discharge TEXT,
  hs_codes TEXT[] NOT NULL DEFAULT '{}',
  declared_value_usd NUMERIC(14, 2) NOT NULL DEFAULT 0,
  estimated_duty_usd NUMERIC(14, 2) NOT NULL DEFAULT 0,
  customs_broker TEXT,
  clearance_status TEXT NOT NULL DEFAULT 'PENDING_DOCS',
  commercial_invoice_ready BOOLEAN NOT NULL DEFAULT false,
  packing_list_ready BOOLEAN NOT NULL DEFAULT false,
  certificate_of_origin_ready BOOLEAN NOT NULL DEFAULT false,
  milestone_note TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, shipment_reference)
);

CREATE INDEX IF NOT EXISTS idx_intl_freight_org_status_updated
  ON international_freight_records (org_id, clearance_status, updated_at DESC);

ALTER TABLE international_freight_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE international_freight_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS international_freight_tenant_isolation ON international_freight_records;
CREATE POLICY international_freight_tenant_isolation
  ON international_freight_records
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logistics_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON international_freight_records TO logistics_app;
  END IF;
END
$$;

-- 4. Leading-Column Pagination Indexes for Secondary Modules
CREATE INDEX IF NOT EXISTS idx_carriers_org_name
  ON carriers (org_id, name ASC);

CREATE INDEX IF NOT EXISTS idx_conveyances_org_active
  ON conveyances (org_id, active DESC);

CREATE INDEX IF NOT EXISTS idx_drivers_org_active_name
  ON drivers (org_id, active DESC, name ASC);

CREATE INDEX IF NOT EXISTS idx_warehouses_org_active_code
  ON warehouses (org_id, active DESC, code ASC);

CREATE INDEX IF NOT EXISTS idx_exceptions_org_created_desc
  ON exceptions (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approvals_org_requested_desc
  ON approvals (org_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_documents_org_created_desc
  ON documents (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created_desc
  ON audit_logs (org_id, created_at DESC);

COMMIT;
