-- 003_reference.sql — reference data and demand.
--
-- Two things here are load-bearing beyond their apparent size:
--
--   * `currencies.minor_unit_exponent` — money is integer minor units, but the
--     number of them per major unit is per-currency. NGN and USD are 2, JPY is
--     0, KWD is 3. Hardcoding 2 silently mis-scales by 100x.
--   * `warehouses.dispatch_lead_hours` — what makes deadline-aware allocation
--     possible. Without it, allocation can only see stock, and will happily
--     pick the near warehouse that cannot dispatch in time.

-- ------------------------------------------------------------------ money

CREATE TABLE IF NOT EXISTS currencies (
    code                 CHAR(3) PRIMARY KEY,
    name                 TEXT     NOT NULL,
    -- Minor units per major unit, as a power of ten. NGN/USD = 2, JPY = 0.
    minor_unit_exponent  SMALLINT NOT NULL DEFAULT 2,
    CONSTRAINT currencies_exponent_sane CHECK (minor_unit_exponent BETWEEN 0 AND 4)
);

INSERT INTO currencies (code, name, minor_unit_exponent) VALUES
    ('NGN', 'Nigerian naira',     2),
    ('USD', 'US dollar',          2),
    ('EUR', 'Euro',               2),
    ('GBP', 'Pound sterling',     2),
    ('ZAR', 'South African rand', 2),
    ('CNY', 'Chinese yuan',       2),
    ('JPY', 'Japanese yen',       0)
ON CONFLICT (code) DO NOTHING;


CREATE TABLE IF NOT EXISTS fx_rates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    base        CHAR(3)        NOT NULL REFERENCES currencies(code),
    quote       CHAR(3)        NOT NULL REFERENCES currencies(code),
    -- 1 unit of `base` costs `rate` units of `quote`.
    rate        NUMERIC(20, 10) NOT NULL,
    as_of       TIMESTAMPTZ    NOT NULL,
    source      TEXT           NOT NULL DEFAULT 'manual',
    created_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CONSTRAINT fx_rates_positive CHECK (rate > 0),
    CONSTRAINT fx_rates_distinct CHECK (base <> quote),
    UNIQUE (base, quote, as_of)
);

-- The hot path is "latest rate for this pair", so order descending.
CREATE INDEX IF NOT EXISTS fx_rates_latest_idx ON fx_rates (base, quote, as_of DESC);


-- -------------------------------------------------------------- locations
-- One table for every kind of place, so a leg's origin and destination can be
-- a warehouse, a port, an airport or a customer site without three columns.

CREATE TABLE IF NOT EXISTS locations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type        TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    -- UN/LOCODE for ports, IATA for airports, internal code for warehouses.
    code        TEXT,
    address     TEXT,
    city        TEXT,
    region      TEXT,
    country     CHAR(2),
    postcode    TEXT,
    latitude    NUMERIC(9, 6),
    longitude   NUMERIC(9, 6),
    timezone    TEXT        NOT NULL DEFAULT 'Africa/Lagos',
    metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT locations_type_known CHECK (
        type IN ('WAREHOUSE', 'PORT', 'AIRPORT', 'RAIL_TERMINAL',
                 'CUSTOMER_SITE', 'CROSS_DOCK', 'BORDER_POST')
    )
);

CREATE INDEX IF NOT EXISTS locations_type_idx    ON locations (type);
CREATE INDEX IF NOT EXISTS locations_country_idx ON locations (country, city);
CREATE UNIQUE INDEX IF NOT EXISTS locations_code_idx ON locations (type, code)
    WHERE code IS NOT NULL;

DROP TRIGGER IF EXISTS locations_updated_at ON locations;
CREATE TRIGGER locations_updated_at BEFORE UPDATE ON locations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -------------------------------------------------------------- customers

CREATE TABLE IF NOT EXISTS customers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code              TEXT        NOT NULL UNIQUE,
    name              TEXT        NOT NULL,
    contacts          JSONB       NOT NULL DEFAULT '[]'::jsonb,
    default_currency  CHAR(3)     NOT NULL DEFAULT 'NGN' REFERENCES currencies(code),
    -- Contractual SLA in hours; breaching it is an approval trigger.
    sla_hours         INTEGER,
    payment_terms     TEXT,
    active            BOOLEAN     NOT NULL DEFAULT true,
    metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS customers_updated_at ON customers;
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- --------------------------------------------------------------- products
-- The handling attributes here are constraints, not decoration: hazmat cannot
-- fly on passenger aircraft, temperature-controlled cargo cannot go on a plain
-- truck, and oversized changes the vehicle class.

CREATE TABLE IF NOT EXISTS products (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku            TEXT        NOT NULL UNIQUE,
    name           TEXT        NOT NULL,
    description    TEXT,

    weight_kg      NUMERIC(12, 3),
    length_cm      NUMERIC(10, 2),
    width_cm       NUMERIC(10, 2),
    height_cm      NUMERIC(10, 2),

    -- Special handling. Drives validation and constrains mode selection.
    hazmat_class   TEXT,
    un_number      TEXT,
    temp_min_c     NUMERIC(5, 2),
    temp_max_c     NUMERIC(5, 2),
    fragile        BOOLEAN     NOT NULL DEFAULT false,
    oversized      BOOLEAN     NOT NULL DEFAULT false,
    stackable      BOOLEAN     NOT NULL DEFAULT true,

    hs_code        TEXT,  -- customs classification
    metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT products_temp_range CHECK (
        temp_min_c IS NULL OR temp_max_c IS NULL OR temp_min_c <= temp_max_c
    )
);

CREATE INDEX IF NOT EXISTS products_hazmat_idx ON products (hazmat_class)
    WHERE hazmat_class IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_reefer_idx ON products (sku)
    WHERE temp_min_c IS NOT NULL OR temp_max_c IS NOT NULL;

DROP TRIGGER IF EXISTS products_updated_at ON products;
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ----------------------------------------------------------------- orders
-- `raw` keeps the payload exactly as it arrived. When an extraction turns out
-- wrong three weeks later, this is what the replay harness re-runs against.

CREATE TABLE IF NOT EXISTS orders (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference     TEXT        NOT NULL UNIQUE,
    customer_id   UUID        REFERENCES customers(id) ON DELETE SET NULL,
    state         TEXT        NOT NULL DEFAULT 'RECEIVED',
    source        TEXT        NOT NULL DEFAULT 'API',
    currency      CHAR(3)     NOT NULL DEFAULT 'NGN' REFERENCES currencies(code),
    incoterm      TEXT,
    ordered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    required_by   TIMESTAMPTZ,
    raw           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT orders_source_known CHECK (
        source IN ('API', 'ERP', 'CRM', 'EMAIL', 'WHATSAPP', 'CSV', 'PORTAL', 'MANUAL')
    )
);

CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id, ordered_at DESC);
CREATE INDEX IF NOT EXISTS orders_state_idx    ON orders (state);

DROP TRIGGER IF EXISTS orders_updated_at ON orders;
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE IF NOT EXISTS order_items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id          UUID        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    line_no           INTEGER     NOT NULL,
    product_id        UUID        REFERENCES products(id) ON DELETE SET NULL,
    sku               TEXT        NOT NULL,
    description       TEXT,
    quantity          INTEGER     NOT NULL,
    unit_price_minor  BIGINT,
    currency          CHAR(3)     REFERENCES currencies(code),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT order_items_qty_positive CHECK (quantity > 0),
    -- An amount without its currency is meaningless and must not be storable.
    CONSTRAINT order_items_price_has_currency CHECK (
        unit_price_minor IS NULL OR currency IS NOT NULL
    ),
    UNIQUE (order_id, line_no)
);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_sku_idx   ON order_items (sku);


-- ------------------------------------------------------------- warehouses

CREATE TABLE IF NOT EXISTS warehouses (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                 TEXT        NOT NULL UNIQUE,
    name                 TEXT        NOT NULL,
    location_id          UUID        REFERENCES locations(id) ON DELETE SET NULL,

    -- Hours from pick instruction to goods on a vehicle. The input that makes
    -- allocation deadline-aware rather than merely stock-aware.
    dispatch_lead_hours  NUMERIC(6, 2) NOT NULL DEFAULT 8,
    cutoff_local_time    TIME,
    operating_hours      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    handles_hazmat       BOOLEAN     NOT NULL DEFAULT false,
    handles_reefer       BOOLEAN     NOT NULL DEFAULT false,
    active               BOOLEAN     NOT NULL DEFAULT true,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS warehouses_updated_at ON warehouses;
CREATE TRIGGER warehouses_updated_at BEFORE UPDATE ON warehouses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE IF NOT EXISTS inventory (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_id  UUID        NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    sku           TEXT        NOT NULL,
    on_hand       INTEGER     NOT NULL DEFAULT 0,
    reserved      INTEGER     NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT inventory_non_negative CHECK (on_hand >= 0 AND reserved >= 0),
    -- Reserving more than exists is the bug this constraint exists to catch.
    CONSTRAINT inventory_not_oversold CHECK (reserved <= on_hand),
    UNIQUE (warehouse_id, sku)
);

CREATE INDEX IF NOT EXISTS inventory_sku_idx ON inventory (sku)
    WHERE on_hand > reserved;

DROP TRIGGER IF EXISTS inventory_updated_at ON inventory;
CREATE TRIGGER inventory_updated_at BEFORE UPDATE ON inventory
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE IF NOT EXISTS inventory_reservations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id   UUID        REFERENCES shipments(id) ON DELETE CASCADE,
    warehouse_id  UUID        NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    sku           TEXT        NOT NULL,
    quantity      INTEGER     NOT NULL,
    -- HELD | CONSUMED | RELEASED | EXPIRED
    state         TEXT        NOT NULL DEFAULT 'HELD',
    expires_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT inventory_reservations_qty CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS inventory_reservations_shipment_idx
    ON inventory_reservations (shipment_id);
-- Expiring stale holds is a background sweep; give it a cheap index.
CREATE INDEX IF NOT EXISTS inventory_reservations_expiry_idx
    ON inventory_reservations (expires_at) WHERE state = 'HELD';

DROP TRIGGER IF EXISTS inventory_reservations_updated_at ON inventory_reservations;
CREATE TRIGGER inventory_reservations_updated_at BEFORE UPDATE ON inventory_reservations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


INSERT INTO schema_migrations (version) VALUES ('003_reference')
    ON CONFLICT (version) DO NOTHING;
