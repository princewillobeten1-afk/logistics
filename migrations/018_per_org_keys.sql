-- 018_per_org_keys.sql — the natural keys migration 016 missed.
--
-- Found by listing every unique index on an RLS-protected table and asking
-- which of them two organisations could legitimately collide on. Most are
-- safe without changing: a primary key on a UUID is unique by construction,
-- and an index keyed on an already-scoped foreign key (shipment_id,
-- warehouse_id, carrier_id) inherits that row's scope.
--
-- These six are business keys that each company issues for itself. Left
-- global, the second organisation to use the platform gets a duplicate-key
-- error when it creates a warehouse coded LOS-1, raises invoice INV-0001, or
-- writes its first policy version — a tenancy bug that presents as a crash
-- rather than a leak, but a tenancy bug all the same.

-- Two companies may both run a warehouse coded LOS-1.
DROP INDEX IF EXISTS locations_code_idx;
CREATE UNIQUE INDEX IF NOT EXISTS locations_org_code_idx
    ON locations (org_id, type, code) WHERE code IS NOT NULL;

-- Invoice numbering restarts per company; it is theirs to define.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_number_key;
DROP INDEX IF EXISTS invoices_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_org_number_idx
    ON invoices (org_id, number);

-- Each organisation versions its own policy. Globally unique versions would
-- mean org B's first policy has to be version 2 because org A got there first.
ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_version_key;
DROP INDEX IF EXISTS policies_version_key;
CREATE UNIQUE INDEX IF NOT EXISTS policies_org_version_idx
    ON policies (org_id, version);

-- Both companies generate a report for the same week.
DROP INDEX IF EXISTS insights_period_topic_idx;
CREATE UNIQUE INDEX IF NOT EXISTS insights_org_period_topic_idx
    ON insights (org_id, period_start, period_end, topic);

-- Each organisation runs its own bot, so an external id is only unique within
-- one. The same person messaging two companies is two contacts, not one — and
-- merging them would show one company's customer the other's conversation.
ALTER TABLE channel_contacts
    DROP CONSTRAINT IF EXISTS channel_contacts_channel_external_id_key;
DROP INDEX IF EXISTS channel_contacts_channel_external_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS channel_contacts_org_channel_external_idx
    ON channel_contacts (org_id, channel, external_id);

-- A haulier can work for more than one shipper, and reaches each through that
-- shipper's own bot.
DROP INDEX IF EXISTS carriers_telegram_chat_idx;
CREATE UNIQUE INDEX IF NOT EXISTS carriers_org_telegram_chat_idx
    ON carriers (org_id, telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('018_per_org_keys')
    ON CONFLICT (version) DO NOTHING;
