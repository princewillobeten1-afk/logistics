-- 017_app_role.sql — an unprivileged role for application queries.
--
-- Migration 016's policies were correct and completely inert. The application
-- connects as `logistics`, which is a SUPERUSER, and **superusers bypass row
-- level security unconditionally** — FORCE ROW LEVEL SECURITY subjects a
-- table's owner to its policies, but nothing subjects a superuser. Isolation
-- was verified by probe, not assumed: every query returned all 12 shipments
-- whether scoped to the right org, a stranger's org, or no org at all.
--
-- The fix is a role that has no such exemption. `logistics_app` owns nothing,
-- can create nothing, and holds plain DML rights. `db.py` switches to it on
-- every pooled connection and back on release; only migrations keep the
-- owner's privileges, because only DDL needs them.
--
-- Stripping SUPERUSER from `logistics` itself was the other option, and was
-- rejected: it is the only login role on this server, so revoking it could not
-- be undone from inside.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logistics_app') THEN
        -- NOLOGIN: nothing ever connects as this role directly. It is reached
        -- only by SET ROLE from an already-authenticated session, so it needs
        -- no password of its own to go stale or leak.
        CREATE ROLE logistics_app NOLOGIN NOSUPERUSER NOBYPASSRLS
            NOCREATEDB NOCREATEROLE NOINHERIT;
    ELSE
        ALTER ROLE logistics_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF;
END $$;

-- The owner must be a member of the role to SET ROLE into it.
GRANT logistics_app TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO logistics_app;

-- DML only. No DDL, no ownership: the application cannot drop a policy that
-- constrains it, which is the point of running as a different role at all.
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE
    ON ALL TABLES IN SCHEMA public TO logistics_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO logistics_app;

-- Tables added by later migrations, which run as the owner, must be reachable
-- too — otherwise migration 018 silently breaks the application.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO logistics_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO logistics_app;

INSERT INTO schema_migrations (version) VALUES ('017_app_role')
    ON CONFLICT (version) DO NOTHING;
