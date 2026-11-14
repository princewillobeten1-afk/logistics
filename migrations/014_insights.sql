-- 014_insights.sql — the Analytics Agent's output.
--
-- Facts are computed in SQL; the model writes the narrative over them. Both
-- are stored: the numbers so a claim can be checked, the narrative so an
-- operator does not have to read a table to know what changed.
--
-- Keeping `facts` alongside `narrative` is deliberate. An insight whose
-- supporting numbers cannot be inspected is an assertion, and this one is
-- meant to influence carrier and lane decisions.

CREATE TABLE IF NOT EXISTS insights (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_start TIMESTAMPTZ NOT NULL,
    period_end   TIMESTAMPTZ NOT NULL,

    -- OPERATIONS | CARRIER | COST | EXCEPTIONS | MODEL
    topic        TEXT        NOT NULL,
    headline     TEXT        NOT NULL,
    narrative    TEXT        NOT NULL,
    recommendation TEXT,

    -- The rows the narrative was written over.
    facts        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    severity     TEXT        NOT NULL DEFAULT 'INFO',
    agent_run_id UUID        REFERENCES agent_runs(id) ON DELETE SET NULL,

    -- Set when someone acts on it, so the same finding is not re-surfaced
    -- every day once it is known.
    acknowledged_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT insights_topic_known CHECK (
        topic IN ('OPERATIONS', 'CARRIER', 'COST', 'EXCEPTIONS', 'MODEL')
    ),
    CONSTRAINT insights_severity_known CHECK (
        severity IN ('INFO', 'NOTABLE', 'ACTION_NEEDED')
    ),
    CONSTRAINT insights_period_ordered CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS insights_recent_idx ON insights (created_at DESC);
CREATE INDEX IF NOT EXISTS insights_open_idx ON insights (severity, created_at DESC)
    WHERE acknowledged_at IS NULL;

-- One insight per topic per period, so a re-run replaces rather than
-- duplicates. Analytics is scheduled and retried like any other step.
CREATE UNIQUE INDEX IF NOT EXISTS insights_period_topic_idx
    ON insights (period_start, period_end, topic);

INSERT INTO schema_migrations (version) VALUES ('014_insights')
    ON CONFLICT (version) DO NOTHING;
