-- 010_channels.sql — inbound channel connections.
--
-- The operator configures how customers reach them: their own Telegram bot,
-- their WhatsApp number, their support mailbox, a widget on their website.
-- Credentials move out of .env and into the database so they can be managed
-- from Settings rather than a deploy.
--
-- That makes encryption at rest mandatory. `credentials` holds a Fernet
-- ciphertext and nothing else; the key lives in CREDENTIALS_KEY and never in
-- the database. A dump of this table on its own yields no usable secret.
--
-- One row per channel: this deployment serves one business. Multi-tenancy
-- would add an org_id here and to the unique index, and nothing else about
-- the design would change.

CREATE TABLE IF NOT EXISTS channel_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel         TEXT        NOT NULL UNIQUE,
    display_name    TEXT,

    -- Non-secret settings: bot username, phone number id, mailbox address,
    -- allowed widget origins. Safe to render in the dashboard.
    config          JSONB       NOT NULL DEFAULT '{}'::jsonb,

    -- Fernet ciphertext. Never selected into anything user-facing.
    credentials     BYTEA,

    -- UNCONFIGURED | PENDING | VERIFIED | ERROR
    state           TEXT        NOT NULL DEFAULT 'UNCONFIGURED',
    enabled         BOOLEAN     NOT NULL DEFAULT false,

    verified_at     TIMESTAMPTZ,
    last_inbound_at TIMESTAMPTZ,
    last_error      TEXT,

    -- Where the channel's poller left off: a Telegram update offset, an IMAP
    -- UID. Kept so a restart does not replay or skip messages.
    cursor          TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT channel_connections_known CHECK (
        channel IN ('TELEGRAM', 'WHATSAPP', 'GMAIL', 'WIDGET')
    ),
    CONSTRAINT channel_connections_state_known CHECK (
        state IN ('UNCONFIGURED', 'PENDING', 'VERIFIED', 'ERROR')
    ),
    -- An enabled channel must have been verified: enabling something that has
    -- never successfully connected would silently drop customer messages.
    CONSTRAINT channel_connections_enabled_is_verified CHECK (
        NOT enabled OR state = 'VERIFIED'
    )
);

DROP TRIGGER IF EXISTS channel_connections_updated_at ON channel_connections;
CREATE TRIGGER channel_connections_updated_at BEFORE UPDATE ON channel_connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------ inbound identities
-- Who is on the other end of a channel, and which shipment they are asking
-- about. A customer emailing from one address about three shipments is three
-- conversations; the same address is one identity.

CREATE TABLE IF NOT EXISTS channel_contacts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel         TEXT        NOT NULL,
    -- Telegram chat_id, WhatsApp wa_id, email address, widget session id.
    external_id     TEXT        NOT NULL,
    display_name    TEXT,
    customer_id     UUID        REFERENCES customers(id) ON DELETE SET NULL,
    -- The shipment this contact is currently asking about, so a follow-up
    -- question without a reference still lands on the right conversation.
    last_shipment_id UUID       REFERENCES shipments(id) ON DELETE SET NULL,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (channel, external_id)
);

CREATE INDEX IF NOT EXISTS channel_contacts_shipment_idx
    ON channel_contacts (last_shipment_id);


-- Communications gain the identity they arrived from, so a reply goes back
-- the way the question came in rather than to a guessed address.
ALTER TABLE communications ADD COLUMN IF NOT EXISTS contact_id UUID
    REFERENCES channel_contacts(id) ON DELETE SET NULL;
ALTER TABLE communications ADD COLUMN IF NOT EXISTS external_ref TEXT;

CREATE INDEX IF NOT EXISTS communications_contact_idx
    ON communications (contact_id, created_at DESC);

-- Seed the four channels as unconfigured, so Settings has something to render
-- and enabling one is an UPDATE rather than a decision about what exists.
INSERT INTO channel_connections (channel, display_name) VALUES
    ('TELEGRAM', 'Telegram bot'),
    ('WHATSAPP', 'WhatsApp Business'),
    ('GMAIL',    'Support mailbox'),
    ('WIDGET',   'Website widget')
ON CONFLICT (channel) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('010_channels')
    ON CONFLICT (version) DO NOTHING;
