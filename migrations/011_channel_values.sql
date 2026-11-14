-- 011_channel_values.sql
--
-- Migration 005 wrote the communications channel CHECK before inbound channels
-- existed, so it allows EMAIL/SMS/WHATSAPP/PORTAL/VOICE/PUSH and rejects
-- TELEGRAM, GMAIL and WIDGET — the three that migration 010 just introduced.
--
-- Third time a CHECK has lagged a feature (carriers.integration, quotes.source,
-- now this). The lists are widened together here and the enum in
-- channels/base.py is the single place a new channel is declared.

ALTER TABLE communications DROP CONSTRAINT IF EXISTS communications_channel_known;

ALTER TABLE communications ADD CONSTRAINT communications_channel_known
    CHECK (channel IN (
        -- inbound channels a customer can reach us on
        'TELEGRAM', 'WHATSAPP', 'GMAIL', 'WIDGET',
        -- outbound-only notification channels
        'EMAIL', 'SMS', 'PORTAL', 'VOICE', 'PUSH'
    ));

ALTER TABLE channel_contacts DROP CONSTRAINT IF EXISTS channel_contacts_channel_known;

ALTER TABLE channel_contacts ADD CONSTRAINT channel_contacts_channel_known
    CHECK (channel IN ('TELEGRAM', 'WHATSAPP', 'GMAIL', 'WIDGET'));

INSERT INTO schema_migrations (version) VALUES ('011_channel_values')
    ON CONFLICT (version) DO NOTHING;
