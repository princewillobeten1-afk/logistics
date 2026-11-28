-- 025_policies_org_version_idx.sql
-- Fixes policies unique index for multi-tenant workspace provisioning:
-- 001_core.sql defined `version INTEGER NOT NULL UNIQUE` (`policies_version_key`),
-- and 016_tenancy.sql dropped `policies_single_active_idx` without dropping
-- `policies_version_key` or creating the per-org `(org_id, version)` unique index
-- required by `seedNewOrgDefaults` during workspace signup and Google sign-in.

ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_version_key;
DROP INDEX IF EXISTS policies_version_key;

CREATE UNIQUE INDEX IF NOT EXISTS policies_org_version_idx
    ON policies (org_id, version);

INSERT INTO schema_migrations (version) VALUES ('025_policies_org_version_idx')
    ON CONFLICT (version) DO NOTHING;
