-- 009_telegram_integration.sql
--
-- Migration 008 added telegram_chat_id but left the integration CHECK from 004
-- listing only API / WHATSAPP / EMAIL / MANUAL, so a TELEGRAM carrier could not
-- actually be inserted. The columns existed; the value did not.

ALTER TABLE carriers DROP CONSTRAINT IF EXISTS carriers_integration_known;

ALTER TABLE carriers ADD CONSTRAINT carriers_integration_known
    CHECK (integration IN ('API', 'TELEGRAM', 'WHATSAPP', 'EMAIL', 'MANUAL'));

-- Same omission on quotes: 008 allowed TELEGRAM there already, but keep the
-- two lists explicitly aligned so a future channel is added in one obvious
-- place rather than discovered at insert time.
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_source_known;

ALTER TABLE quotes ADD CONSTRAINT quotes_source_known
    CHECK (source IN ('API', 'TELEGRAM', 'WHATSAPP', 'EMAIL', 'MANUAL'));

INSERT INTO schema_migrations (version) VALUES ('009_telegram_integration')
    ON CONFLICT (version) DO NOTHING;
