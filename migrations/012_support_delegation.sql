-- 012_support_delegation.sql — the support agent gains the ability to act.
--
-- Until now a customer message could only produce a sentence. It can now
-- produce work: a shipment, a change request, an escalation. Two consequences
-- need storing.
--
-- 1. Conversation state. Collecting an order takes several turns, so the
--    agent has to remember what it already asked for. The contact IS the
--    conversation, so the draft lives there rather than in a new table.
--
-- 2. Provenance. A shipment created from an unauthenticated chat is not the
--    same thing as one submitted through the API, and an operator should be
--    able to see which is which at a glance.

ALTER TABLE channel_contacts ADD COLUMN IF NOT EXISTS draft JSONB;
ALTER TABLE channel_contacts ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE channel_contacts ADD COLUMN IF NOT EXISTS escalation_reason TEXT;

-- The ops inbox query: which conversations need a human.
CREATE INDEX IF NOT EXISTS channel_contacts_escalated_idx
    ON channel_contacts (escalated_at DESC)
    WHERE escalated_at IS NOT NULL;

-- Conversations with an order half-collected, so an operator can see what the
-- agent is in the middle of.
CREATE INDEX IF NOT EXISTS channel_contacts_drafting_idx
    ON channel_contacts (last_seen_at DESC)
    WHERE draft IS NOT NULL;


ALTER TABLE shipments ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'API';
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS origin_contact_id UUID
    REFERENCES channel_contacts(id) ON DELETE SET NULL;

ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_created_via_known;
ALTER TABLE shipments ADD CONSTRAINT shipments_created_via_known
    CHECK (created_via IN ('API', 'CHAT', 'CSV', 'EMAIL', 'ERP', 'MANUAL'));

-- Both the dashboard filter and the per-contact rate limit read this.
CREATE INDEX IF NOT EXISTS shipments_chat_origin_idx
    ON shipments (origin_contact_id, created_at DESC)
    WHERE origin_contact_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('012_support_delegation')
    ON CONFLICT (version) DO NOTHING;
