-- 015_identity.sql — organisations, users, sessions.
--
-- Until now there was no authentication at all, and `/approvals` would
-- authorise carrier spending for anyone who could reach the port, off a `by`
-- field that was an unverified form input. The policy gate carefully withheld
-- the decision from the agent and then handed it to nobody in particular.
--
-- Sessions are rows rather than JWTs on purpose: revocation is a DELETE, and
-- the Python worker can read a session the dashboard wrote without the two
-- sharing a signing secret.

CREATE TABLE IF NOT EXISTS organisations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL,
    slug        TEXT        NOT NULL UNIQUE,
    active      BOOLEAN     NOT NULL DEFAULT true,
    settings    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS organisations_updated_at ON organisations;
CREATE TRIGGER organisations_updated_at BEFORE UPDATE ON organisations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- Roles, smallest set covering the PRD's personas:
--   VIEWER      read only
--   DISPATCHER  create and edit shipments
--   APPROVER    decide approvals — the only role that can authorise spend
--   ADMIN       users, channels, policy
CREATE TABLE IF NOT EXISTS users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    email          TEXT        NOT NULL,
    -- scrypt, from the Python standard library. Format is
    -- scrypt$n$r$p$salt$hash — self-describing, so parameters can be raised
    -- later without invalidating existing hashes.
    password_hash  TEXT        NOT NULL,
    name           TEXT,
    role           TEXT        NOT NULL DEFAULT 'VIEWER',
    active         BOOLEAN     NOT NULL DEFAULT true,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT users_role_known CHECK (
        role IN ('VIEWER', 'DISPATCHER', 'APPROVER', 'ADMIN')
    )
);

-- Email is the login identifier, so it must be globally unique regardless of
-- org — otherwise a login form cannot resolve to one account.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id) WHERE active;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_address  INET,
    user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
-- Expiring old sessions is a background sweep; give it a cheap index.
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);


-- The org everything existing belongs to. Migration 016 backfills against it.
INSERT INTO organisations (name, slug)
VALUES ('Default Organisation', 'default')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('015_identity')
    ON CONFLICT (version) DO NOTHING;
