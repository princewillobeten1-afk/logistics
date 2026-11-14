-- 004_transport.sql — carriers, conveyances, and the multimodal leg model.
--
-- The central change: a shipment is no longer one journey. It is an ordered
-- sequence of legs, each with its own mode, carrier, conveyance and state.
-- Lagos → Tema is truck → vessel → truck, and the handoffs between them are
-- where real shipments get lost.

-- ------------------------------------------------------------- carriers

CREATE TABLE IF NOT EXISTS carriers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code              TEXT        NOT NULL UNIQUE,
    name              TEXT        NOT NULL,
    -- Which modes this carrier can actually run. Filters candidates per leg.
    modes             TEXT[]      NOT NULL DEFAULT ARRAY['ROAD'],
    carrier_type      TEXT        NOT NULL DEFAULT 'ASSET',

    -- How we transact with them. WhatsApp carriers are the long tail and
    -- behave completely differently from API ones: unbounded reply latency,
    -- free-text pricing, and sometimes no reply at all.
    integration       TEXT        NOT NULL DEFAULT 'MANUAL',
    contact           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    whatsapp_number   TEXT,
    api_config        JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- An unapproved carrier is an approval trigger regardless of amount.
    approved          BOOLEAN     NOT NULL DEFAULT false,
    insurance_cover_minor BIGINT,
    insurance_currency    CHAR(3) REFERENCES currencies(code),
    active            BOOLEAN     NOT NULL DEFAULT true,
    metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT carriers_integration_known CHECK (
        integration IN ('API', 'WHATSAPP', 'EMAIL', 'MANUAL')
    ),
    CONSTRAINT carriers_type_known CHECK (
        carrier_type IN ('ASSET', 'BROKER', 'FORWARDER', 'COURIER', 'LINER', 'AIRLINE')
    )
);

CREATE INDEX IF NOT EXISTS carriers_modes_idx ON carriers USING GIN (modes);
CREATE INDEX IF NOT EXISTS carriers_active_idx ON carriers (active, approved);

DROP TRIGGER IF EXISTS carriers_updated_at ON carriers;
CREATE TRIGGER carriers_updated_at BEFORE UPDATE ON carriers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- Exactly the inputs the published scoring model needs:
--   30% cost + 25% on-time + 15% availability + 10% damage
--   + 10% route experience + 10% service
CREATE TABLE IF NOT EXISTS carrier_performance (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    carrier_id           UUID        NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
    -- NULL lane = the carrier's overall record.
    origin_region        TEXT,
    destination_region   TEXT,
    mode                 TEXT,

    shipments_count      INTEGER     NOT NULL DEFAULT 0,
    on_time_rate         NUMERIC(5, 4),
    damage_rate          NUMERIC(5, 4),
    availability_rate    NUMERIC(5, 4),
    service_score        NUMERIC(5, 4),
    avg_detention_hours  NUMERIC(8, 2),
    window_start         TIMESTAMPTZ,
    window_end           TIMESTAMPTZ,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT carrier_performance_rates CHECK (
        (on_time_rate      IS NULL OR on_time_rate      BETWEEN 0 AND 1) AND
        (damage_rate       IS NULL OR damage_rate       BETWEEN 0 AND 1) AND
        (availability_rate IS NULL OR availability_rate BETWEEN 0 AND 1) AND
        (service_score     IS NULL OR service_score     BETWEEN 0 AND 1)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS carrier_performance_lane_idx
    ON carrier_performance (
        carrier_id,
        COALESCE(origin_region, ''),
        COALESCE(destination_region, ''),
        COALESCE(mode, '')
    );


CREATE TABLE IF NOT EXISTS carrier_rates (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    carrier_id        UUID        NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
    mode              TEXT        NOT NULL,
    origin_id         UUID        REFERENCES locations(id) ON DELETE SET NULL,
    destination_id    UUID        REFERENCES locations(id) ON DELETE SET NULL,
    origin_region     TEXT,
    destination_region TEXT,

    basis             TEXT        NOT NULL DEFAULT 'FLAT',
    amount_minor      BIGINT      NOT NULL,
    currency          CHAR(3)     NOT NULL REFERENCES currencies(code),
    min_charge_minor  BIGINT,
    transit_hours     NUMERIC(8, 2),

    valid_from        TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to          TIMESTAMPTZ,
    contracted        BOOLEAN     NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT carrier_rates_basis_known CHECK (
        basis IN ('FLAT', 'PER_KM', 'PER_KG', 'PER_CBM', 'PER_CONTAINER', 'PER_PALLET')
    )
);

CREATE INDEX IF NOT EXISTS carrier_rates_lookup_idx
    ON carrier_rates (mode, origin_region, destination_region, valid_from DESC);


-- ---------------------------------------------------------- conveyances
-- Generalises "vehicle" across modes. A truck has a plate, a vessel has an
-- IMO, an aircraft has a tail number — mode-specific ids go in `identifiers`
-- rather than a column per mode that is null for every other mode.

CREATE TABLE IF NOT EXISTS conveyances (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    carrier_id     UUID        REFERENCES carriers(id) ON DELETE SET NULL,
    mode           TEXT        NOT NULL,
    kind           TEXT,
    identifiers    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    capacity_kg    NUMERIC(12, 2),
    capacity_cbm   NUMERIC(12, 2),
    reefer         BOOLEAN     NOT NULL DEFAULT false,
    hazmat_certified BOOLEAN   NOT NULL DEFAULT false,
    active         BOOLEAN     NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT conveyances_mode_known CHECK (mode IN ('ROAD', 'AIR', 'SEA', 'RAIL'))
);

CREATE INDEX IF NOT EXISTS conveyances_carrier_idx ON conveyances (carrier_id, mode);
CREATE INDEX IF NOT EXISTS conveyances_identifiers_idx ON conveyances USING GIN (identifiers);

DROP TRIGGER IF EXISTS conveyances_updated_at ON conveyances;
CREATE TRIGGER conveyances_updated_at BEFORE UPDATE ON conveyances
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE IF NOT EXISTS drivers (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    carrier_id     UUID        REFERENCES carriers(id) ON DELETE SET NULL,
    name           TEXT        NOT NULL,
    phone          TEXT,
    licence_number TEXT,
    licence_expiry DATE,
    hazmat_certified BOOLEAN   NOT NULL DEFAULT false,
    active         BOOLEAN     NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS drivers_updated_at ON drivers;
CREATE TRIGGER drivers_updated_at BEFORE UPDATE ON drivers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE IF NOT EXISTS routes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT,
    mode            TEXT        NOT NULL,
    origin_id       UUID        REFERENCES locations(id) ON DELETE SET NULL,
    destination_id  UUID        REFERENCES locations(id) ON DELETE SET NULL,
    distance_km     NUMERIC(10, 2),
    typical_hours   NUMERIC(8, 2),
    -- Grams of CO2e per tonne-kilometre. One of the optimisation objectives.
    co2e_g_per_tkm  NUMERIC(10, 3),
    waypoints       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    risk_notes      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS routes_lane_idx ON routes (mode, origin_id, destination_id);

DROP TRIGGER IF EXISTS routes_updated_at ON routes;
CREATE TRIGGER routes_updated_at BEFORE UPDATE ON routes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------- shipment tie-ins

ALTER TABLE shipments ADD COLUMN IF NOT EXISTS order_id     UUID REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS customer_id  UUID REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS currency     CHAR(3) NOT NULL DEFAULT 'NGN' REFERENCES currencies(code);
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS origin_id      UUID REFERENCES locations(id) ON DELETE SET NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS destination_id UUID REFERENCES locations(id) ON DELETE SET NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS declared_value_minor BIGINT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS service_level TEXT;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS is_international BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS shipments_order_idx    ON shipments (order_id);
CREATE INDEX IF NOT EXISTS shipments_customer_idx ON shipments (customer_id);


-- ---------------------------------------------------------- shipment_legs
-- The multimodal core.
--
-- Leg lifecycle:
--   PLANNED → SOURCING → BOOKED → AT_ORIGIN → IN_TRANSIT
--           → AT_DESTINATION → HANDED_OFF → COMPLETED
--   (EXCEPTION / CANCELLED reachable from most)
--
-- HANDED_OFF is deliberately distinct from COMPLETED. A container discharged
-- at Apapa with nobody booked to collect it is the classic way a multi-leg
-- shipment dies quietly, and it needs a state you can query for.

CREATE TABLE IF NOT EXISTS shipment_legs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id       UUID        NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    sequence          INTEGER     NOT NULL,
    mode              TEXT        NOT NULL,
    state             TEXT        NOT NULL DEFAULT 'PLANNED',
    version           INTEGER     NOT NULL DEFAULT 0,

    origin_id         UUID        REFERENCES locations(id) ON DELETE SET NULL,
    destination_id    UUID        REFERENCES locations(id) ON DELETE SET NULL,
    route_id          UUID        REFERENCES routes(id) ON DELETE SET NULL,

    carrier_id        UUID        REFERENCES carriers(id) ON DELETE SET NULL,
    conveyance_id     UUID        REFERENCES conveyances(id) ON DELETE SET NULL,
    driver_id         UUID        REFERENCES drivers(id) ON DELETE SET NULL,

    -- FTL/LTL for road, FCL/LCL for sea. Same idea, per-mode vocabulary.
    load_type         TEXT,
    container_ref     TEXT,
    booking_ref       TEXT,

    planned_departure TIMESTAMPTZ,
    planned_arrival   TIMESTAMPTZ,
    actual_departure  TIMESTAMPTZ,
    actual_arrival    TIMESTAMPTZ,
    eta               TIMESTAMPTZ,

    cost_minor        BIGINT,
    currency          CHAR(3)     REFERENCES currencies(code),
    distance_km       NUMERIC(10, 2),
    co2e_kg           NUMERIC(12, 3),

    metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT shipment_legs_mode_known CHECK (mode IN ('ROAD', 'AIR', 'SEA', 'RAIL')),
    CONSTRAINT shipment_legs_cost_has_currency CHECK (
        cost_minor IS NULL OR currency IS NOT NULL
    ),
    CONSTRAINT shipment_legs_sequence_positive CHECK (sequence > 0),
    UNIQUE (shipment_id, sequence)
);

CREATE INDEX IF NOT EXISTS shipment_legs_shipment_idx ON shipment_legs (shipment_id, sequence);
CREATE INDEX IF NOT EXISTS shipment_legs_state_idx    ON shipment_legs (state);
CREATE INDEX IF NOT EXISTS shipment_legs_carrier_idx  ON shipment_legs (carrier_id);
-- Finding legs stuck at a handoff is a first-class query, not a scan.
CREATE INDEX IF NOT EXISTS shipment_legs_handoff_idx  ON shipment_legs (destination_id, actual_arrival)
    WHERE state = 'HANDED_OFF';

DROP TRIGGER IF EXISTS shipment_legs_updated_at ON shipment_legs;
CREATE TRIGGER shipment_legs_updated_at BEFORE UPDATE ON shipment_legs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- Stops within a leg, for consolidated multi-drop runs.
CREATE TABLE IF NOT EXISTS shipment_stops (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    leg_id         UUID        NOT NULL REFERENCES shipment_legs(id) ON DELETE CASCADE,
    sequence       INTEGER     NOT NULL,
    location_id    UUID        REFERENCES locations(id) ON DELETE SET NULL,
    stop_type      TEXT        NOT NULL DEFAULT 'DELIVERY',
    window_start   TIMESTAMPTZ,
    window_end     TIMESTAMPTZ,
    arrived_at     TIMESTAMPTZ,
    departed_at    TIMESTAMPTZ,
    state          TEXT        NOT NULL DEFAULT 'PENDING',
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT shipment_stops_type_known CHECK (
        stop_type IN ('PICKUP', 'DELIVERY', 'TRANSFER', 'CUSTOMS', 'REST', 'FUEL')
    ),
    UNIQUE (leg_id, sequence)
);

CREATE INDEX IF NOT EXISTS shipment_stops_leg_idx ON shipment_stops (leg_id, sequence);


-- ------------------------------------------------- customs declarations
-- Attached to the leg that crosses the border, not the shipment — on a
-- three-leg move only one leg clears customs.

CREATE TABLE IF NOT EXISTS customs_declarations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id         UUID        NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    leg_id              UUID        REFERENCES shipment_legs(id) ON DELETE SET NULL,
    direction           TEXT        NOT NULL DEFAULT 'EXPORT',
    declaration_ref     TEXT,
    hs_codes            TEXT[]      NOT NULL DEFAULT '{}',
    declared_value_minor BIGINT,
    currency            CHAR(3)     REFERENCES currencies(code),
    duty_minor          BIGINT,
    duty_currency       CHAR(3)     REFERENCES currencies(code),
    broker              TEXT,
    -- NOT_STARTED | SUBMITTED | UNDER_REVIEW | HELD | CLEARED | REJECTED
    clearance_state     TEXT        NOT NULL DEFAULT 'NOT_STARTED',
    submitted_at        TIMESTAMPTZ,
    cleared_at          TIMESTAMPTZ,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT customs_direction_known CHECK (direction IN ('IMPORT', 'EXPORT', 'TRANSIT'))
);

CREATE INDEX IF NOT EXISTS customs_shipment_idx ON customs_declarations (shipment_id);
-- Held at customs is an exception the tracking agent must be able to find.
CREATE INDEX IF NOT EXISTS customs_open_idx ON customs_declarations (clearance_state)
    WHERE clearance_state NOT IN ('CLEARED', 'REJECTED');

DROP TRIGGER IF EXISTS customs_declarations_updated_at ON customs_declarations;
CREATE TRIGGER customs_declarations_updated_at BEFORE UPDATE ON customs_declarations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


INSERT INTO schema_migrations (version) VALUES ('004_transport')
    ON CONFLICT (version) DO NOTHING;
