-- 024_enterprise_multi_tenancy.sql
-- Enterprise multi-tenant isolation hardening:
--   1. Department & branch-level access control columns on users
--   2. Per-workspace webhook routing tokens & intake API key hashes on organisations
--   3. Tenant-isolated team_invitations, tactics_state, and webhook_deliveries tables with FORCE RLS
--   4. FORCE RLS on integration_connectors and integration_events
--   5. Composite tenant foreign keys (org_id, id) closing PostgreSQL's FK RLS-bypass gap
--   6. org_id immutability trigger preventing tenant reassignment during UPDATE
--   7. Leading-column (org_id, ...) indexes for RLS query performance

-- ----------------------------------------- 1. Granular member scoping on users

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS departments  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS branch_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ----------------------------------------- 2. Per-workspace webhook & intake credentials

ALTER TABLE organisations
    ADD COLUMN IF NOT EXISTS webhook_token              TEXT,
    ADD COLUMN IF NOT EXISTS intake_api_key_hash        TEXT,
    ADD COLUMN IF NOT EXISTS intake_api_key_prefix      TEXT,
    ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id   TEXT,
    ADD COLUMN IF NOT EXISTS whatsapp_verify_token      TEXT,
    ADD COLUMN IF NOT EXISTS whatsapp_app_secret_sealed TEXT,
    ADD COLUMN IF NOT EXISTS telegram_webhook_secret_hash TEXT;

UPDATE organisations
   SET webhook_token = encode(gen_random_bytes(18), 'hex')
 WHERE webhook_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organisations_webhook_token_idx
    ON organisations (webhook_token)
    WHERE webhook_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organisations_intake_key_hash_idx
    ON organisations (intake_api_key_hash)
    WHERE intake_api_key_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organisations_wa_phone_id_idx
    ON organisations (whatsapp_phone_number_id)
    WHERE whatsapp_phone_number_id IS NOT NULL;

-- ----------------------------------------- 3. Team invitations (tenant-scoped)

CREATE TABLE IF NOT EXISTS team_invitations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE
                 DEFAULT nullif(current_setting('app.current_org', true), '')::uuid,
    token_hash   TEXT        NOT NULL UNIQUE,
    email        TEXT        NOT NULL,
    role         TEXT        NOT NULL DEFAULT 'VIEWER'
                 CHECK (role IN ('VIEWER', 'DISPATCHER', 'APPROVER', 'ADMIN')),
    departments  TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    branch_codes TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    invited_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    accepted_at  TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_invitations_org_idx
    ON team_invitations (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS team_invitations_email_idx
    ON team_invitations (org_id, lower(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE team_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON team_invitations;
CREATE POLICY tenant_isolation ON team_invitations
    USING (
        org_id = nullif(current_setting('app.current_org', true), '')::uuid
        OR current_setting('app.system', true) = 'on'
    )
    WITH CHECK (
        org_id = nullif(current_setting('app.current_org', true), '')::uuid
        OR current_setting('app.system', true) = 'on'
    );

-- ----------------------------------------- 4. Tactics workspace state (DB-backed RLS)

CREATE TABLE IF NOT EXISTS tactics_state (
    org_id     UUID PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE
               DEFAULT nullif(current_setting('app.current_org', true), '')::uuid,
    payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tactics_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE tactics_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tactics_state;
CREATE POLICY tenant_isolation ON tactics_state
    USING (
        org_id = nullif(current_setting('app.current_org', true), '')::uuid
        OR current_setting('app.system', true) = 'on'
    )
    WITH CHECK (
        org_id = nullif(current_setting('app.current_org', true), '')::uuid
        OR current_setting('app.system', true) = 'on'
    );

-- ----------------------------------------- 5. Webhook replay deduplication (per tenant)

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE
                DEFAULT nullif(current_setting('app.current_org', true), '')::uuid,
    channel     TEXT        NOT NULL,
    delivery_id TEXT        NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_org_chan_id_idx
    ON webhook_deliveries (org_id, channel, delivery_id);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webhook_deliveries;
CREATE POLICY tenant_isolation ON webhook_deliveries
    USING (
        org_id = nullif(current_setting('app.current_org', true), '')::uuid
        OR current_setting('app.system', true) = 'on'
    )
    WITH CHECK (
        org_id = nullif(current_setting('app.current_org', true), '')::uuid
        OR current_setting('app.system', true) = 'on'
    );

-- ----------------------------------------- 6. Document storage confinement metadata

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS storage_key TEXT,
    ADD COLUMN IF NOT EXISTS content_type TEXT,
    ADD COLUMN IF NOT EXISTS byte_size BIGINT,
    ADD COLUMN IF NOT EXISTS sha256 TEXT,
    ADD COLUMN IF NOT EXISTS uploaded_by TEXT;

-- ----------------------------------------- 7. Enforce FORCE RLS on integration tables

CREATE TABLE IF NOT EXISTS integration_connectors (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    system_type TEXT NOT NULL,
    category TEXT NOT NULL,
    connection_mode TEXT NOT NULL DEFAULT 'PUSH_WEBHOOK',
    auto_takeover BOOLEAN NOT NULL DEFAULT true,
    source_url TEXT,
    source_auth_sealed TEXT,
    db_config_sealed TEXT,
    db_tables JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    autonomy_mode TEXT NOT NULL DEFAULT 'FULL_AUTONOMOUS',
    api_key_prefix TEXT NOT NULL,
    api_key_hash TEXT NOT NULL UNIQUE,
    webhook_secret_hash TEXT NOT NULL,
    outbound_webhook_url TEXT,
    outbound_events JSONB NOT NULL DEFAULT '[]'::jsonb,
    field_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_sync_at TIMESTAMPTZ,
    events_processed INTEGER NOT NULL DEFAULT 0,
    errors_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS integration_events (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    connector_name TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'INBOUND',
    format TEXT NOT NULL DEFAULT 'JSON',
    entity_type TEXT NOT NULL DEFAULT 'ORDER',
    status TEXT NOT NULL DEFAULT 'PROCESSED',
    idempotency_key TEXT,
    external_ref TEXT,
    shipment_ref TEXT,
    order_ref TEXT,
    mapped_by TEXT NOT NULL DEFAULT 'HEURISTIC',
    summary TEXT NOT NULL DEFAULT '',
    delegated_agents JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_preview TEXT NOT NULL DEFAULT '',
    normalized_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    outbound_status TEXT,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_connectors_org_idx
    ON integration_connectors (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS integration_events_org_idx
    ON integration_events (org_id, created_at DESC);

ALTER TABLE integration_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connectors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON integration_connectors;
CREATE POLICY tenant_isolation ON integration_connectors
    USING (
        org_id::text = nullif(current_setting('app.current_org', true), '')
        OR current_setting('app.system', true) = 'on'
    )
    WITH CHECK (
        org_id::text = nullif(current_setting('app.current_org', true), '')
        OR current_setting('app.system', true) = 'on'
    );

ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON integration_events;
CREATE POLICY tenant_isolation ON integration_events
    USING (
        org_id::text = nullif(current_setting('app.current_org', true), '')
        OR current_setting('app.system', true) = 'on'
    )
    WITH CHECK (
        org_id::text = nullif(current_setting('app.current_org', true), '')
        OR current_setting('app.system', true) = 'on'
    );

-- ----------------------------------------- 8. Composite tenant foreign keys (org_id, id)
-- PostgreSQL FK integrity checks bypass RLS; composite (org_id, parent_id) FKs make
-- cross-tenant foreign key links impossible at the database engine level.

DO $$
DECLARE
    parent_tbl TEXT;
BEGIN
    FOREACH parent_tbl IN ARRAY ARRAY[
        'shipments', 'orders', 'customers', 'warehouses',
        'carriers', 'conveyances', 'drivers', 'consolidation_groups'
    ]
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = parent_tbl
        ) THEN
            EXECUTE format(
                'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (org_id, id)',
                parent_tbl || '_org_id_id_uniq', parent_tbl
            );
        END IF;
    END LOOP;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipment_legs_org_shipment_fk') THEN
        ALTER TABLE shipment_legs
            ADD CONSTRAINT shipment_legs_org_shipment_fk
            FOREIGN KEY (org_id, shipment_id) REFERENCES shipments (org_id, id) ON DELETE CASCADE
            NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotes_org_shipment_fk') THEN
        ALTER TABLE quotes
            ADD CONSTRAINT quotes_org_shipment_fk
            FOREIGN KEY (org_id, shipment_id) REFERENCES shipments (org_id, id) ON DELETE CASCADE
            NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approvals_org_shipment_fk') THEN
        ALTER TABLE approvals
            ADD CONSTRAINT approvals_org_shipment_fk
            FOREIGN KEY (org_id, shipment_id) REFERENCES shipments (org_id, id) ON DELETE CASCADE
            NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exceptions_org_shipment_fk') THEN
        ALTER TABLE exceptions
            ADD CONSTRAINT exceptions_org_shipment_fk
            FOREIGN KEY (org_id, shipment_id) REFERENCES shipments (org_id, id) ON DELETE CASCADE
            NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_org_shipment_fk') THEN
        ALTER TABLE documents
            ADD CONSTRAINT documents_org_shipment_fk
            FOREIGN KEY (org_id, shipment_id) REFERENCES shipments (org_id, id) ON DELETE CASCADE
            NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assistant_messages_org_shipment_fk') THEN
        ALTER TABLE assistant_messages
            ADD CONSTRAINT assistant_messages_org_shipment_fk
            FOREIGN KEY (org_id, shipment_id) REFERENCES shipments (org_id, id) ON DELETE CASCADE
            NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'consolidation_items_org_shipment_fk') THEN
        ALTER TABLE consolidation_items
            ADD CONSTRAINT consolidation_items_org_shipment_fk
            FOREIGN KEY (org_id, shipment_id) REFERENCES shipments (org_id, id) ON DELETE CASCADE
            NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_org_warehouse_fk') THEN
        ALTER TABLE inventory
            ADD CONSTRAINT inventory_org_warehouse_fk
            FOREIGN KEY (org_id, warehouse_id) REFERENCES warehouses (org_id, id) ON DELETE CASCADE
            NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'replenishment_orders_org_warehouse_fk') THEN
        ALTER TABLE replenishment_orders
            ADD CONSTRAINT replenishment_orders_org_warehouse_fk
            FOREIGN KEY (org_id, warehouse_id) REFERENCES warehouses (org_id, id) ON DELETE CASCADE
            NOT VALID;
    END IF;
END $$;

-- ----------------------------------------- 9. Immutability trigger for org_id

CREATE OR REPLACE FUNCTION prevent_org_id_reassignment()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.org_id IS DISTINCT FROM NEW.org_id THEN
        RAISE EXCEPTION 'Tenant ownership (org_id) is immutable once created.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'shipments', 'orders', 'customers', 'warehouses', 'carriers',
        'conveyances', 'drivers', 'documents', 'approvals', 'exceptions',
        'communications', 'agent_runs', 'work_items', 'team_invitations'
    ]
    LOOP
        IF EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = tbl
        ) THEN
            EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', tbl || '_immutable_org_id', tbl);
            EXECUTE format(
                'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_org_id_reassignment()',
                tbl || '_immutable_org_id', tbl
            );
        END IF;
    END LOOP;
END $$;

-- ----------------------------------------- 10. Leading-column (org_id, ...) RLS indexes

CREATE INDEX IF NOT EXISTS shipments_org_updated_idx ON shipments (org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS shipments_org_state_idx ON shipments (org_id, state);
CREATE INDEX IF NOT EXISTS orders_org_ordered_idx ON orders (org_id, ordered_at DESC);
CREATE INDEX IF NOT EXISTS approvals_org_state_idx ON approvals (org_id, state);
CREATE INDEX IF NOT EXISTS exceptions_org_state_idx ON exceptions (org_id, state);
CREATE INDEX IF NOT EXISTS documents_org_created_idx ON documents (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_org_created_idx ON agent_runs (org_id, created_at DESC);

-- ----------------------------------------- 11. Grants to unprivileged logistics_app role

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logistics_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON team_invitations, tactics_state, webhook_deliveries,
               integration_connectors, integration_events
            TO logistics_app;
    END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('024_enterprise_multi_tenancy')
    ON CONFLICT (version) DO NOTHING;
