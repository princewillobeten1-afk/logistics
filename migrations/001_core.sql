-- 001_core.sql — orchestrator spine.
-- Tables the orchestrator itself needs. Operational entities (customers,
-- inventory, carriers, tracking) land in later migrations.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------- shipments
-- The aggregate root. `state` is a projection of shipment_events, kept
-- denormalised here so the dashboard can query it without a fold.
-- `version` is the optimistic lock: every transition bumps it.

CREATE TABLE IF NOT EXISTS shipments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference     TEXT        NOT NULL UNIQUE,
    state         TEXT        NOT NULL,
    version       INTEGER     NOT NULL DEFAULT 0,

    customer_ref  TEXT,
    origin        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    destination   JSONB       NOT NULL DEFAULT '{}'::jsonb,
    cargo         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    deadline      TIMESTAMPTZ,

    -- Populated as the shipment moves; null until the relevant step runs.
    allocation    JSONB,
    plan          JSONB,
    booking       JSONB,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shipments_state_idx    ON shipments (state);
CREATE INDEX IF NOT EXISTS shipments_deadline_idx ON shipments (deadline)
    WHERE state NOT IN ('CLOSED', 'CANCELLED', 'FAILED');

DROP TRIGGER IF EXISTS shipments_updated_at ON shipments;
CREATE TRIGGER shipments_updated_at BEFORE UPDATE ON shipments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---------------------------------------------------------- shipment_events
-- Append-only. Never updated, never deleted. `seq` is per-shipment and gapless,
-- which is what makes replay deterministic.

CREATE TABLE IF NOT EXISTS shipment_events (
    id            BIGSERIAL PRIMARY KEY,
    shipment_id   UUID        NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    seq           INTEGER     NOT NULL,
    type          TEXT        NOT NULL,
    from_state    TEXT,
    to_state      TEXT,
    payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- 'system' | 'agent:<name>' | 'user:<id>' | 'carrier:<id>'
    actor         TEXT        NOT NULL DEFAULT 'system',
    work_item_id  UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (shipment_id, seq)
);

CREATE INDEX IF NOT EXISTS shipment_events_shipment_idx
    ON shipment_events (shipment_id, seq);
CREATE INDEX IF NOT EXISTS shipment_events_type_idx
    ON shipment_events (type, created_at DESC);


-- --------------------------------------------------------------- work_items
-- The durable queue. Claimed with FOR UPDATE SKIP LOCKED under a lease, so a
-- worker that dies mid-step releases its item once the lease expires rather
-- than stranding the shipment.

CREATE TABLE IF NOT EXISTS work_items (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id       UUID        REFERENCES shipments(id) ON DELETE CASCADE,
    kind              TEXT        NOT NULL,
    payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- PENDING | RUNNING | DONE | DEAD
    state             TEXT        NOT NULL DEFAULT 'PENDING',
    run_after         TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts          INTEGER     NOT NULL DEFAULT 0,
    max_attempts      INTEGER     NOT NULL DEFAULT 5,
    priority          SMALLINT    NOT NULL DEFAULT 100,

    -- Set by the caller to make enqueue idempotent. A retry of the same
    -- logical step collides here instead of creating a second item.
    dedupe_key        TEXT UNIQUE,

    locked_by         TEXT,
    locked_at         TIMESTAMPTZ,
    lease_expires_at  TIMESTAMPTZ,

    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The claim query's covering index. Partial, because DONE rows dominate the
-- table within days and must not be walked.
CREATE INDEX IF NOT EXISTS work_items_claimable_idx
    ON work_items (priority, run_after)
    WHERE state = 'PENDING';

CREATE INDEX IF NOT EXISTS work_items_reclaim_idx
    ON work_items (lease_expires_at)
    WHERE state = 'RUNNING';

CREATE INDEX IF NOT EXISTS work_items_shipment_idx ON work_items (shipment_id);

DROP TRIGGER IF EXISTS work_items_updated_at ON work_items;
CREATE TRIGGER work_items_updated_at BEFORE UPDATE ON work_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- --------------------------------------------------------------- agent_runs
-- One row per model call. Audit trail, cost ledger, and the eval corpus.

CREATE TABLE IF NOT EXISTS agent_runs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id        UUID        REFERENCES shipments(id) ON DELETE SET NULL,
    work_item_id       UUID,
    agent              TEXT        NOT NULL,
    job                TEXT        NOT NULL,
    model              TEXT        NOT NULL,
    prompt_version     TEXT,

    request            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    response           JSONB,
    decision           TEXT,
    rationale          TEXT,

    prompt_tokens      INTEGER,
    completion_tokens  INTEGER,
    latency_ms         INTEGER,

    -- OK | INVALID_OUTPUT | REFUSED | ERROR
    status             TEXT        NOT NULL,
    attempt            SMALLINT    NOT NULL DEFAULT 1,
    error              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runs_shipment_idx ON agent_runs (shipment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_job_idx      ON agent_runs (job, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_status_idx   ON agent_runs (status, created_at DESC)
    WHERE status <> 'OK';


-- --------------------------------------------------------------- tool_calls
-- Every side-effecting call. The UNIQUE on idempotency_key is the thing
-- standing between a retry and a double-booked truck.

CREATE TABLE IF NOT EXISTS tool_calls (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key  TEXT        NOT NULL UNIQUE,
    shipment_id      UUID        REFERENCES shipments(id) ON DELETE SET NULL,
    agent_run_id     UUID        REFERENCES agent_runs(id) ON DELETE SET NULL,
    tool             TEXT        NOT NULL,
    tier             SMALLINT    NOT NULL,
    request          JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- INTENT written before the external call, RESULT after. An INTENT with no
    -- RESULT is the crash window and must be reconciled, never blind-retried.
    state            TEXT        NOT NULL DEFAULT 'INTENT',
    response         JSONB,
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tool_calls_shipment_idx ON tool_calls (shipment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tool_calls_dangling_idx ON tool_calls (created_at)
    WHERE state = 'INTENT';


-- ---------------------------------------------------------------- policies
CREATE TABLE IF NOT EXISTS policies (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version     INTEGER     NOT NULL UNIQUE,
    name        TEXT        NOT NULL,
    rules       JSONB       NOT NULL,
    active      BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one active policy version at a time.
CREATE UNIQUE INDEX IF NOT EXISTS policies_single_active_idx
    ON policies ((true)) WHERE active;


-- --------------------------------------------------------- proposed_actions
-- The propose → gate → execute record. An agent writes PROPOSED; the policy
-- engine decides; only the executor may move it to EXECUTED.

CREATE TABLE IF NOT EXISTS proposed_actions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id       UUID        NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    agent_run_id      UUID        REFERENCES agent_runs(id) ON DELETE SET NULL,
    work_item_id      UUID,

    action            TEXT        NOT NULL,
    params            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    rationale         TEXT,
    tier              SMALLINT    NOT NULL,

    -- ALLOW | REQUIRE_APPROVAL | DENY
    policy_decision   TEXT,
    policy_reason     TEXT,
    policy_version    INTEGER,

    -- PROPOSED | APPROVED | REJECTED | EXECUTED | FAILED | EXPIRED
    state             TEXT        NOT NULL DEFAULT 'PROPOSED',
    tool_call_id      UUID        REFERENCES tool_calls(id) ON DELETE SET NULL,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS proposed_actions_shipment_idx
    ON proposed_actions (shipment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS proposed_actions_open_idx
    ON proposed_actions (state) WHERE state IN ('PROPOSED', 'APPROVED');


-- ---------------------------------------------------------------- approvals
-- Tokens are single-use: the partial unique index below allows exactly one
-- PENDING approval per proposed action, so a double-click cannot open two.

CREATE TABLE IF NOT EXISTS approvals (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposed_action_id   UUID        NOT NULL REFERENCES proposed_actions(id) ON DELETE CASCADE,
    shipment_id          UUID        NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    token                TEXT        NOT NULL UNIQUE,

    summary              TEXT        NOT NULL,
    amount_minor         BIGINT,
    currency             TEXT        NOT NULL DEFAULT 'NGN',

    -- PENDING | APPROVED | REJECTED | EXPIRED
    state                TEXT        NOT NULL DEFAULT 'PENDING',
    requested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    escalate_at          TIMESTAMPTZ,
    expires_at           TIMESTAMPTZ NOT NULL,
    decided_by           TEXT,
    decided_at           TIMESTAMPTZ,
    note                 TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_idx
    ON approvals (proposed_action_id) WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS approvals_pending_idx
    ON approvals (expires_at) WHERE state = 'PENDING';


INSERT INTO schema_migrations (version) VALUES ('001_core')
    ON CONFLICT (version) DO NOTHING;
