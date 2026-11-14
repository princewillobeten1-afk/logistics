-- 019_dedupe_per_org.sql — deduplication is per organisation.
--
-- `work_items.dedupe_key` is what makes enqueueing idempotent: a handler that
-- re-runs and re-enqueues its follow-up collides instead of duplicating. Most
-- keys embed a shipment UUID and so are distinct across orgs by construction.
-- Three are not:
--
--     analytics:{hour}    handlers/analytics.py
--     sweep:{minute}      handlers/tracking.py
--     poll:{10s bucket}   handlers/channels.py
--
-- plus the dashboard's `channel-config:{channel}`. Those are time- or
-- name-bucketed with nothing tenant-specific in them, so with the key global
-- the first organisation to enqueue a sweep wins and every other organisation's
-- sweep silently collides and is dropped — no error, no work item, and absence
-- detection that simply never runs for them.
--
-- Fixing it in the schema rather than at the twenty call sites means no future
-- caller has to remember, and the three above need no change at all.

ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_dedupe_key_key;
DROP INDEX IF EXISTS work_items_dedupe_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS work_items_org_dedupe_idx
    ON work_items (org_id, dedupe_key);

INSERT INTO schema_migrations (version) VALUES ('019_dedupe_per_org')
    ON CONFLICT (version) DO NOTHING;
