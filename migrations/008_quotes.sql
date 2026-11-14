-- 008_quotes.sql — carrier quotes.
--
-- A quote is the unit of carrier sourcing. API carriers answer in
-- milliseconds; Telegram carriers answer in forty minutes, in free text, or
-- never — so a quote row is created when we *ask*, not when we hear back.
-- That way a carrier who never replies is visible as an unanswered request
-- rather than as an absence of data.

CREATE TABLE IF NOT EXISTS quotes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id     UUID        NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    leg_id          UUID        REFERENCES shipment_legs(id) ON DELETE SET NULL,
    carrier_id      UUID        NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,

    -- Sourcing can run more than once: a rejected approval or an exhausted
    -- window reopens with a new round rather than overwriting history.
    round           INTEGER     NOT NULL DEFAULT 1,
    source          TEXT        NOT NULL,

    -- REQUESTED  we asked, nothing back yet
    -- RECEIVED   a usable price
    -- UNPARSEABLE a reply we could not read with confidence — human queue
    -- DECLINED   carrier said no
    -- SELECTED / REJECTED / EXPIRED
    state           TEXT        NOT NULL DEFAULT 'REQUESTED',

    amount_minor    BIGINT,
    currency        CHAR(3)     REFERENCES currencies(code),
    transit_hours   NUMERIC(8, 2),
    valid_until     TIMESTAMPTZ,

    -- Free-text provenance. Kept verbatim: when a parse turns out wrong weeks
    -- later, this is what the replay harness re-runs against.
    raw_text        TEXT,
    confidence      NUMERIC(5, 4),
    parsed_by       TEXT,
    agent_run_id    UUID        REFERENCES agent_runs(id) ON DELETE SET NULL,

    -- Written by carriers/scoring.py, which is canonical. The dashboard
    -- renders this rather than recomputing, so the score that spends money is
    -- the score anyone is looking at.
    score           NUMERIC(6, 5),
    score_breakdown JSONB,

    requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT quotes_source_known CHECK (source IN ('API', 'TELEGRAM', 'EMAIL', 'MANUAL')),
    CONSTRAINT quotes_state_known CHECK (
        state IN ('REQUESTED', 'RECEIVED', 'UNPARSEABLE', 'DECLINED',
                  'SELECTED', 'REJECTED', 'EXPIRED')
    ),
    -- An amount without its currency is meaningless and must not be storable.
    CONSTRAINT quotes_amount_has_currency CHECK (
        amount_minor IS NULL OR currency IS NOT NULL
    ),
    CONSTRAINT quotes_confidence_range CHECK (
        confidence IS NULL OR confidence BETWEEN 0 AND 1
    ),
    -- A carrier replying twice in one round updates its quote; it does not
    -- get two entries in the comparison.
    UNIQUE (shipment_id, carrier_id, round)
);

CREATE INDEX IF NOT EXISTS quotes_shipment_idx ON quotes (shipment_id, round, state);
CREATE INDEX IF NOT EXISTS quotes_carrier_idx  ON quotes (carrier_id, created_at DESC);
-- The window-close query: what is still outstanding.
CREATE INDEX IF NOT EXISTS quotes_open_idx ON quotes (shipment_id)
    WHERE state = 'REQUESTED';
-- Low-confidence parses are a human review queue.
CREATE INDEX IF NOT EXISTS quotes_unparseable_idx ON quotes (created_at)
    WHERE state = 'UNPARSEABLE';

-- Exactly one winner per sourcing round.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_one_selected_idx
    ON quotes (shipment_id, round) WHERE state = 'SELECTED';

DROP TRIGGER IF EXISTS quotes_updated_at ON quotes;
CREATE TRIGGER quotes_updated_at BEFORE UPDATE ON quotes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------- telegram
-- A Telegram bot cannot initiate a conversation: sending to someone who has
-- never messaged it returns "Forbidden: bot can't initiate conversation with
-- a user". So chat_id is captured from the carrier's first inbound message,
-- and a carrier without one cannot be broadcast to.

ALTER TABLE carriers ADD COLUMN IF NOT EXISTS telegram_chat_id  BIGINT;
ALTER TABLE carriers ADD COLUMN IF NOT EXISTS telegram_username TEXT;
ALTER TABLE carriers ADD COLUMN IF NOT EXISTS onboarded_at      TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS carriers_telegram_chat_idx
    ON carriers (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;

-- Resolving an inbound update to a carrier is the hot path of the poller.
CREATE INDEX IF NOT EXISTS carriers_telegram_ready_idx ON carriers (id)
    WHERE telegram_chat_id IS NOT NULL AND active;

INSERT INTO schema_migrations (version) VALUES ('008_quotes')
    ON CONFLICT (version) DO NOTHING;
