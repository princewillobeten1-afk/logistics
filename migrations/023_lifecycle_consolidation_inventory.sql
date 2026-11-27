-- 023_lifecycle_consolidation_inventory.sql
-- Adds support for the remaining logistics objectives:
--   1. Inventory replenishment & holding cost metrics (`inventory` columns + `replenishment_orders`)
--   2. Pre-sourcing LTL/LCL shipment consolidation (`consolidation_groups` + `consolidation_items`)
--   3. Reverse logistics / RMA & product lifecycle (`return_authorizations`)

-- ----------------------------------------- 1. Inventory holding & replenishment

ALTER TABLE inventory
    ADD COLUMN IF NOT EXISTS safety_stock INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN IF NOT EXISTS reorder_point INTEGER NOT NULL DEFAULT 40,
    ADD COLUMN IF NOT EXISTS reorder_quantity INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN IF NOT EXISTS unit_cost_minor BIGINT NOT NULL DEFAULT 500000,
    ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'NGN' REFERENCES currencies(code),
    ADD COLUMN IF NOT EXISTS annual_holding_rate NUMERIC(6, 4) NOT NULL DEFAULT 0.2000;

ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_safety_non_neg;
ALTER TABLE inventory ADD CONSTRAINT inventory_safety_non_neg
    CHECK (safety_stock >= 0 AND reorder_point >= 0 AND reorder_quantity > 0);

ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_cost_non_neg;
ALTER TABLE inventory ADD CONSTRAINT inventory_cost_non_neg
    CHECK (unit_cost_minor >= 0 AND annual_holding_rate >= 0);

CREATE TABLE IF NOT EXISTS replenishment_orders (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE
                         DEFAULT nullif(current_setting('app.current_org', true), '')::uuid,
    reference            TEXT        NOT NULL,
    warehouse_id         UUID        NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    sku                  TEXT        NOT NULL,
    quantity             INTEGER     NOT NULL CHECK (quantity > 0),
    estimated_cost_minor BIGINT,
    currency             CHAR(3)     NOT NULL DEFAULT 'NGN' REFERENCES currencies(code),
    reason               TEXT,
    status               TEXT        NOT NULL DEFAULT 'PROPOSED'
                         CHECK (status IN ('PROPOSED', 'APPROVED', 'ORDERED', 'RECEIVED', 'CANCELLED')),
    supplier_name        TEXT,
    expected_at          TIMESTAMPTZ,
    received_at          TIMESTAMPTZ,
    metadata             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS replenishment_orders_org_idx
    ON replenishment_orders (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS replenishment_orders_org_ref_idx
    ON replenishment_orders (org_id, reference);
CREATE UNIQUE INDEX IF NOT EXISTS replenishment_orders_open_sku_idx
    ON replenishment_orders (org_id, warehouse_id, sku)
    WHERE status IN ('PROPOSED', 'APPROVED', 'ORDERED');

DROP TRIGGER IF EXISTS replenishment_orders_updated_at ON replenishment_orders;
CREATE TRIGGER replenishment_orders_updated_at BEFORE UPDATE ON replenishment_orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE replenishment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE replenishment_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON replenishment_orders;
CREATE POLICY tenant_isolation ON replenishment_orders USING (
    org_id = nullif(current_setting('app.current_org', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
) WITH CHECK (
    org_id = nullif(current_setting('app.current_org', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
);


-- ----------------------------------------- 2. Pre-sourcing freight consolidation

CREATE TABLE IF NOT EXISTS consolidation_groups (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE
                            DEFAULT nullif(current_setting('app.current_org', true), '')::uuid,
    reference               TEXT        NOT NULL,
    origin_city             TEXT        NOT NULL,
    destination_city        TEXT        NOT NULL,
    mode                    TEXT        NOT NULL DEFAULT 'ROAD'
                            CHECK (mode IN ('ROAD', 'AIR', 'SEA', 'RAIL')),
    load_type               TEXT        NOT NULL DEFAULT 'CONSOLIDATED_LTL',
    status                  TEXT        NOT NULL DEFAULT 'OPEN'
                            CHECK (status IN ('OPEN', 'SOURCING', 'BOOKED', 'DISPATCHED', 'CANCELLED')),
    vehicle_capacity_kg     NUMERIC(12, 3) NOT NULL DEFAULT 15000,
    total_weight_kg         NUMERIC(12, 3) NOT NULL DEFAULT 0,
    total_volume_cbm        NUMERIC(12, 4) NOT NULL DEFAULT 0,
    utilization_pct         NUMERIC(5, 2)  NOT NULL DEFAULT 0,
    estimated_savings_minor BIGINT      NOT NULL DEFAULT 0,
    currency                CHAR(3)     NOT NULL DEFAULT 'NGN' REFERENCES currencies(code),
    carrier_id              UUID        REFERENCES carriers(id) ON DELETE SET NULL,
    master_booking_ref      TEXT,
    metadata                JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consolidation_groups_org_idx
    ON consolidation_groups (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS consolidation_groups_org_ref_idx
    ON consolidation_groups (org_id, reference);
CREATE INDEX IF NOT EXISTS consolidation_groups_lane_idx
    ON consolidation_groups (org_id, origin_city, destination_city, mode, status);

DROP TRIGGER IF EXISTS consolidation_groups_updated_at ON consolidation_groups;
CREATE TRIGGER consolidation_groups_updated_at BEFORE UPDATE ON consolidation_groups
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE consolidation_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE consolidation_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON consolidation_groups;
CREATE POLICY tenant_isolation ON consolidation_groups USING (
    org_id = nullif(current_setting('app.current_org', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
) WITH CHECK (
    org_id = nullif(current_setting('app.current_org', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
);

CREATE TABLE IF NOT EXISTS consolidation_items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE
                DEFAULT nullif(current_setting('app.current_org', true), '')::uuid,
    group_id    UUID        NOT NULL REFERENCES consolidation_groups(id) ON DELETE CASCADE,
    shipment_id UUID        NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    weight_kg   NUMERIC(12, 3) NOT NULL DEFAULT 0,
    volume_cbm  NUMERIC(12, 4) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consolidation_items_org_idx
    ON consolidation_items (org_id);
CREATE INDEX IF NOT EXISTS consolidation_items_group_idx
    ON consolidation_items (group_id);
CREATE UNIQUE INDEX IF NOT EXISTS consolidation_items_org_shipment_idx
    ON consolidation_items (org_id, shipment_id);

ALTER TABLE consolidation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE consolidation_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON consolidation_items;
CREATE POLICY tenant_isolation ON consolidation_items USING (
    org_id = nullif(current_setting('app.current_org', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
) WITH CHECK (
    org_id = nullif(current_setting('app.current_org', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
);

ALTER TABLE shipments
    ADD COLUMN IF NOT EXISTS consolidation_group_id UUID REFERENCES consolidation_groups(id) ON DELETE SET NULL;


-- ----------------------------------------- 3. Reverse logistics / RMA lifecycle

CREATE TABLE IF NOT EXISTS return_authorizations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE
                        DEFAULT nullif(current_setting('app.current_org', true), '')::uuid,
    rma_number          TEXT        NOT NULL,
    shipment_id         UUID        REFERENCES shipments(id) ON DELETE SET NULL,
    order_id            UUID        REFERENCES orders(id) ON DELETE SET NULL,
    customer_id         UUID        REFERENCES customers(id) ON DELETE SET NULL,
    warehouse_id        UUID        REFERENCES warehouses(id) ON DELETE SET NULL,
    sku                 TEXT        NOT NULL DEFAULT 'DEFAULT',
    quantity            INTEGER     NOT NULL DEFAULT 1 CHECK (quantity > 0),
    reason              TEXT        NOT NULL
                        CHECK (reason IN ('DAMAGED', 'DEFECTIVE', 'WRONG_ITEM', 'RECALL', 'END_OF_LIFE', 'WARRANTY', 'CUSTOMER_REMORSE')),
    condition_notes     TEXT,
    state               TEXT        NOT NULL DEFAULT 'RETURN_REQUESTED'
                        CHECK (state IN (
                            'RETURN_REQUESTED',
                            'PICKUP_SCHEDULED',
                            'IN_TRANSIT',
                            'RECEIVED',
                            'INSPECTED',
                            'RESTOCKED',
                            'REFURBISHED',
                            'SCRAPPED',
                            'RECALLED',
                            'CLOSED',
                            'REJECTED'
                        )),
    disposition         TEXT
                        CHECK (disposition IS NULL OR disposition IN ('RESTOCK', 'REFURBISH', 'SCRAP', 'REPLACE', 'CREDIT')),
    reverse_shipment_id UUID        REFERENCES shipments(id) ON DELETE SET NULL,
    refund_minor        BIGINT      NOT NULL DEFAULT 0,
    currency            CHAR(3)     NOT NULL DEFAULT 'NGN' REFERENCES currencies(code),
    lot_number          TEXT,
    serial_number       TEXT,
    inspected_by        TEXT,
    inspected_at        TIMESTAMPTZ,
    resolved_at         TIMESTAMPTZ,
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS return_authorizations_org_idx
    ON return_authorizations (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS return_authorizations_org_rma_idx
    ON return_authorizations (org_id, rma_number);
CREATE INDEX IF NOT EXISTS return_authorizations_state_idx
    ON return_authorizations (org_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS return_authorizations_lot_idx
    ON return_authorizations (org_id, sku, lot_number)
    WHERE lot_number IS NOT NULL;

DROP TRIGGER IF EXISTS return_authorizations_updated_at ON return_authorizations;
CREATE TRIGGER return_authorizations_updated_at BEFORE UPDATE ON return_authorizations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE return_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_authorizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON return_authorizations;
CREATE POLICY tenant_isolation ON return_authorizations USING (
    org_id = nullif(current_setting('app.current_org', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
) WITH CHECK (
    org_id = nullif(current_setting('app.current_org', true), '')::uuid
    OR current_setting('app.system', true) = 'on'
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logistics_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON replenishment_orders, consolidation_groups, consolidation_items, return_authorizations
            TO logistics_app;
    END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('023_lifecycle_consolidation_inventory')
    ON CONFLICT (version) DO NOTHING;
