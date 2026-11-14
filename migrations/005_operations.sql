-- 005_operations.sql — tracking and the operational tail.
--
-- tracking_events is the highest-volume table in the system: at 5,000
-- shipments/day with multi-leg journeys and 15-minute polling it takes well
-- over a million rows a day. It is partitioned by month so that retention is a
-- DETACH rather than a DELETE, and so its indexes never sit in the same
-- buffers as interactively-queried tables.

-- --------------------------------------------------------- tracking_events

CREATE TABLE IF NOT EXISTS tracking_events (
    id            BIGSERIAL,
    shipment_id   UUID        NOT NULL,
    leg_id        UUID,
    occurred_at   TIMESTAMPTZ NOT NULL,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    source        TEXT        NOT NULL,
    event_type    TEXT        NOT NULL,
    latitude      NUMERIC(9, 6),
    longitude     NUMERIC(9, 6),
    speed_kph     NUMERIC(6, 2),
    heading_deg   NUMERIC(5, 2),
    temperature_c NUMERIC(5, 2),
    location_id   UUID,
    payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,

    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX IF NOT EXISTS tracking_events_shipment_idx
    ON tracking_events (shipment_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS tracking_events_leg_idx
    ON tracking_events (leg_id, occurred_at DESC);

-- Create the current and next three months up front, and provide a function
-- the scheduler calls to keep running ahead. An insert into a missing
-- partition is an error, so this must never be allowed to fall behind.
CREATE OR REPLACE FUNCTION ensure_tracking_partition(target DATE)
RETURNS TEXT AS $$
DECLARE
    start_at DATE := date_trunc('month', target)::date;
    end_at   DATE := (date_trunc('month', target) + interval '1 month')::date;
    part     TEXT := 'tracking_events_' || to_char(start_at, 'YYYY_MM');
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF tracking_events FOR VALUES FROM (%L) TO (%L)',
            part, start_at, end_at
        );
    END IF;
    RETURN part;
END;
$$ LANGUAGE plpgsql;

SELECT ensure_tracking_partition((CURRENT_DATE + (n || ' month')::interval)::date)
  FROM generate_series(0, 3) AS n;


-- ------------------------------------------------------------- checkpoints
-- Expected milestones. Their absence is what makes a *missed* checkpoint
-- detectable by arithmetic instead of inference.

CREATE TABLE IF NOT EXISTS checkpoints (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id   UUID        NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    leg_id        UUID        REFERENCES shipment_legs(id) ON DELETE CASCADE,
    sequence      INTEGER     NOT NULL,
    name          TEXT        NOT NULL,
    location_id   UUID        REFERENCES locations(id) ON DELETE SET NULL,
    expected_at   TIMESTAMPTZ NOT NULL,
    -- Grace before "late" becomes "missed".
    tolerance_minutes INTEGER NOT NULL DEFAULT 60,
    reached_at    TIMESTAMPTZ,
    state         TEXT        NOT NULL DEFAULT 'PENDING',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT checkpoints_state_known CHECK (
        state IN ('PENDING', 'REACHED', 'MISSED', 'SKIPPED')
    )
);

CREATE INDEX IF NOT EXISTS checkpoints_shipment_idx ON checkpoints (shipment_id, sequence);
-- The detection sweep's query: what is overdue right now.
CREATE INDEX IF NOT EXISTS checkpoints_due_idx ON checkpoints (expected_at)
    WHERE state = 'PENDING';


-- -------------------------------------------------------------- exceptions

CREATE TABLE IF NOT EXISTS exceptions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id       UUID        NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    leg_id            UUID        REFERENCES shipment_legs(id) ON DELETE SET NULL,
    kind              TEXT        NOT NULL,
    severity          TEXT        NOT NULL DEFAULT 'MEDIUM',
    -- How it was found. Deterministic detection should dominate this column;
    -- if it does not, something is calling a model that should not be.
    detected_by       TEXT        NOT NULL DEFAULT 'detector',
    detail            JSONB       NOT NULL DEFAULT '{}'::jsonb,

    state             TEXT        NOT NULL DEFAULT 'OPEN',
    resolution        TEXT,
    resolved_at       TIMESTAMPTZ,
    agent_run_id      UUID        REFERENCES agent_runs(id) ON DELETE SET NULL,
    cost_impact_minor BIGINT,
    currency          CHAR(3)     REFERENCES currencies(code),

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT exceptions_severity_known CHECK (
        severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')
    ),
    CONSTRAINT exceptions_state_known CHECK (
        state IN ('OPEN', 'INVESTIGATING', 'AWAITING_APPROVAL', 'RESOLVED', 'ABANDONED')
    )
);

CREATE INDEX IF NOT EXISTS exceptions_open_idx ON exceptions (severity, created_at DESC)
    WHERE state <> 'RESOLVED';
CREATE INDEX IF NOT EXISTS exceptions_shipment_idx ON exceptions (shipment_id, created_at DESC);

DROP TRIGGER IF EXISTS exceptions_updated_at ON exceptions;
CREATE TRIGGER exceptions_updated_at BEFORE UPDATE ON exceptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- --------------------------------------------------------------- documents

CREATE TABLE IF NOT EXISTS documents (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id      UUID        REFERENCES shipments(id) ON DELETE CASCADE,
    leg_id           UUID        REFERENCES shipment_legs(id) ON DELETE SET NULL,
    kind             TEXT        NOT NULL,
    direction        TEXT        NOT NULL DEFAULT 'OUTBOUND',
    filename         TEXT,
    content_type     TEXT,
    storage_uri      TEXT,
    sha256           TEXT,

    -- nemotron-parse output, plus how much to trust it.
    extracted        JSONB,
    extraction_model TEXT,
    extraction_confidence NUMERIC(5, 4),
    verified_by      TEXT,
    verified_at      TIMESTAMPTZ,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT documents_kind_known CHECK (
        kind IN ('BOL', 'AWB', 'SEA_WAYBILL', 'RAIL_WAYBILL', 'PACKING_LIST',
                 'COMMERCIAL_INVOICE', 'CUSTOMS_DECLARATION', 'CERTIFICATE_OF_ORIGIN',
                 'POD', 'LABEL', 'PHOTO', 'SIGNATURE', 'OTHER')
    )
);

CREATE INDEX IF NOT EXISTS documents_shipment_idx ON documents (shipment_id, kind);
-- Low-confidence extractions are the human review queue.
CREATE INDEX IF NOT EXISTS documents_unverified_idx ON documents (created_at)
    WHERE verified_at IS NULL AND extracted IS NOT NULL;


-- ---------------------------------------------------------- communications

CREATE TABLE IF NOT EXISTS communications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id     UUID        REFERENCES shipments(id) ON DELETE CASCADE,
    customer_id     UUID        REFERENCES customers(id) ON DELETE SET NULL,
    carrier_id      UUID        REFERENCES carriers(id) ON DELETE SET NULL,

    channel         TEXT        NOT NULL,
    direction       TEXT        NOT NULL,
    recipient       TEXT,
    subject         TEXT,
    body            TEXT,
    template        TEXT,

    -- Inbound bodies are untrusted input. This records whether the guardrail
    -- pass ran and what it said, so an unscreened message is visible as such.
    safety_checked  BOOLEAN     NOT NULL DEFAULT false,
    safety_verdict  TEXT,

    agent_run_id    UUID        REFERENCES agent_runs(id) ON DELETE SET NULL,
    -- QUEUED | SENT | DELIVERED | READ | FAILED | RECEIVED
    state           TEXT        NOT NULL DEFAULT 'QUEUED',
    provider_ref    TEXT,
    error           TEXT,
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT communications_channel_known CHECK (
        channel IN ('EMAIL', 'SMS', 'WHATSAPP', 'PORTAL', 'VOICE', 'PUSH')
    ),
    CONSTRAINT communications_direction_known CHECK (
        direction IN ('INBOUND', 'OUTBOUND')
    )
);

CREATE INDEX IF NOT EXISTS communications_shipment_idx
    ON communications (shipment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS communications_inbound_idx
    ON communications (created_at DESC) WHERE direction = 'INBOUND';


-- ------------------------------------------------------------------ claims

CREATE TABLE IF NOT EXISTS claims (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id       UUID        NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    carrier_id        UUID        REFERENCES carriers(id) ON DELETE SET NULL,
    kind              TEXT        NOT NULL,
    description       TEXT,
    amount_minor      BIGINT,
    currency          CHAR(3)     REFERENCES currencies(code),
    state             TEXT        NOT NULL DEFAULT 'OPEN',
    opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at        TIMESTAMPTZ,
    settled_minor     BIGINT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT claims_kind_known CHECK (
        kind IN ('SHORTAGE', 'DAMAGE', 'LOSS', 'DELAY', 'TEMPERATURE', 'OTHER')
    ),
    CONSTRAINT claims_amount_has_currency CHECK (
        amount_minor IS NULL OR currency IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS claims_shipment_idx ON claims (shipment_id);
CREATE INDEX IF NOT EXISTS claims_open_idx ON claims (state, opened_at DESC)
    WHERE state <> 'SETTLED';


-- ---------------------------------------------------------------- invoices

CREATE TABLE IF NOT EXISTS invoices (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id    UUID        REFERENCES shipments(id) ON DELETE SET NULL,
    customer_id    UUID        REFERENCES customers(id) ON DELETE SET NULL,
    carrier_id     UUID        REFERENCES carriers(id) ON DELETE SET NULL,
    direction      TEXT        NOT NULL DEFAULT 'RECEIVABLE',
    number         TEXT        UNIQUE,
    amount_minor   BIGINT      NOT NULL,
    tax_minor      BIGINT      NOT NULL DEFAULT 0,
    currency       CHAR(3)     NOT NULL REFERENCES currencies(code),
    state          TEXT        NOT NULL DEFAULT 'DRAFT',
    issued_at      TIMESTAMPTZ,
    due_at         TIMESTAMPTZ,
    paid_at        TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT invoices_direction_known CHECK (direction IN ('RECEIVABLE', 'PAYABLE'))
);

CREATE INDEX IF NOT EXISTS invoices_shipment_idx ON invoices (shipment_id);
CREATE INDEX IF NOT EXISTS invoices_unpaid_idx ON invoices (due_at)
    WHERE state NOT IN ('PAID', 'VOID');


-- -------------------------------------------------------------- audit_logs
-- Distinct from shipment_events and agent_runs on purpose. Those record what
-- the *system* did to a shipment; this records what a *principal* did to the
-- system — a human approving, a config change, an integration writing in.

CREATE TABLE IF NOT EXISTS audit_logs (
    id             BIGSERIAL PRIMARY KEY,
    actor          TEXT        NOT NULL,
    actor_type     TEXT        NOT NULL DEFAULT 'USER',
    action         TEXT        NOT NULL,
    entity_type    TEXT,
    entity_id      UUID,
    before         JSONB,
    after          JSONB,
    ip_address     INET,
    user_agent     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT audit_logs_actor_type_known CHECK (
        actor_type IN ('USER', 'AGENT', 'SYSTEM', 'INTEGRATION')
    )
);

CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx  ON audit_logs (actor, created_at DESC);


INSERT INTO schema_migrations (version) VALUES ('005_operations')
    ON CONFLICT (version) DO NOTHING;
