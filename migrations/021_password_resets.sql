-- 021_password_resets.sql — self-service "forgot password".
--
-- Same identity-boundary reasoning as `users` and `sessions` (migration 015):
-- resetting a password happens before there is any authenticated org context,
-- so this table sits outside row-level security like the rest of the login
-- path. Isolation instead comes from the token itself — 32 bytes of entropy,
-- single-use, short-lived — the same way a session token is its own
-- credential rather than something org-scoping would meaningfully protect.
--
-- tests/test_tenancy.py::test_every_business_table_is_protected knows about
-- this exemption explicitly, so a real oversight elsewhere still fails loudly.

CREATE TABLE IF NOT EXISTS password_resets (
    token       TEXT PRIMARY KEY,
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    -- Set once the token is consumed. NULL is what "still usable" means. The
    -- row is kept rather than deleted on use, so a repeat submission of a
    -- stale link produces a clear "already used" instead of "not found".
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_address  INET
);

CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);
-- Expiring stale tokens is a background sweep; give it a cheap index, the
-- same way sessions_expiry_idx does for sessions.
CREATE INDEX IF NOT EXISTS password_resets_expiry_idx ON password_resets (expires_at);

INSERT INTO schema_migrations (version) VALUES ('021_password_resets')
    ON CONFLICT (version) DO NOTHING;
