-- 016_tenancy.sql — org_id and row-level security on every business table.
--
-- ~36 tables and 223 SQL statements are in scope. Scoping each query by hand
-- is how tenancy bugs happen, and the failure mode is the worst one there is:
-- one customer reading another's shipments. So isolation is enforced by
-- Postgres, not by remembering.
--
--     org_id = current_setting('app.current_org', true)::uuid
--
-- `current_setting(..., true)` returns NULL when the setting is absent, and
-- `org_id = NULL` is NULL, which is not TRUE — so a query that forgets to set
-- the org returns **zero rows rather than someone else's**. Isolation fails
-- closed.
--
-- FORCE ROW LEVEL SECURITY matters: a table's owner bypasses RLS by default,
-- and the application connects as the owner. Without FORCE the policies below
-- would be decorative.
--
-- Deliberately NOT covered: `users` and `sessions`. They are the identity
-- system rather than tenant data, and both must be readable *before* an org is
-- known — a login has no org context yet. A session token is 32 bytes of
-- entropy and is itself the credential; user listing is scoped in the one
-- admin query that does it.
--
-- The `app.system` escape exists for two modules and no others: the migration
-- runner (`db.py`), and the work queue (`orchestrator/queue.py`), which claims
-- and reclaims across orgs because one worker process serves every tenant.
-- Both touch queue bookkeeping only, never business data. A test asserts the
-- import appears in exactly those two files.

DO $$
DECLARE
    default_org UUID;
    t           TEXT;
    skip        TEXT[] := ARRAY[
        -- global reference data, shared by every org
        'currencies', 'fx_rates', 'schema_migrations',
        -- the identity system itself
        'organisations', 'users', 'sessions'
    ];
BEGIN
    SELECT id INTO default_org FROM organisations WHERE slug = 'default';

    FOR t IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           -- 'r' ordinary tables and 'p' partitioned parents. Partitions
           -- inherit the column and the policy from their parent.
           AND c.relkind IN ('r', 'p')
           AND c.relispartition = false
           AND NOT (c.relname = ANY(skip))
         ORDER BY c.relname
    LOOP
        EXECUTE format(
            'ALTER TABLE %I ADD COLUMN IF NOT EXISTS org_id UUID '
            'REFERENCES organisations(id) ON DELETE CASCADE', t
        );
        EXECUTE format('UPDATE %I SET org_id = %L WHERE org_id IS NULL', t, default_org);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN org_id SET NOT NULL', t);
        EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN org_id SET DEFAULT '
            'nullif(current_setting(''app.current_org'', true), '''')::uuid', t
        );

        -- Every tenant-scoped query filters on this; without it RLS turns
        -- each one into a sequential scan.
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I (org_id)', t || '_org_idx', t
        );

        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

        -- nullif() is load-bearing. Releasing a pooled connection clears the
        -- setting to '' rather than unsetting it, and ''::uuid *raises*
        -- rather than yielding NULL — which would turn "returns nothing"
        -- into "crashes". NULL compares as NULL, which is not TRUE, so the
        -- row is excluded and isolation still fails closed.
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING ('
            '  org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid'
            '  OR current_setting(''app.system'', true) = ''on'''
            ') WITH CHECK ('
            '  org_id = nullif(current_setting(''app.current_org'', true), '''')::uuid'
            '  OR current_setting(''app.system'', true) = ''on'''
            ')', t
        );
    END LOOP;
END $$;


-- Unique constraints become per-org: two organisations may each have a
-- carrier coded CARRIER-A, and a shipment reference is only unique within the
-- company that issued it.
-- Order matters: a UNIQUE constraint owns its index, and dropping the index
-- first is refused. Drop the constraint, then the index for the case where one
-- exists without a constraint behind it.
ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_reference_key;
DROP INDEX IF EXISTS shipments_reference_key;
CREATE UNIQUE INDEX IF NOT EXISTS shipments_org_reference_idx
    ON shipments (org_id, reference);

ALTER TABLE carriers DROP CONSTRAINT IF EXISTS carriers_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS carriers_org_code_idx ON carriers (org_id, code);

ALTER TABLE warehouses DROP CONSTRAINT IF EXISTS warehouses_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS warehouses_org_code_idx ON warehouses (org_id, code);

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS customers_org_code_idx ON customers (org_id, code);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_reference_key;
CREATE UNIQUE INDEX IF NOT EXISTS orders_org_reference_idx ON orders (org_id, reference);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_sku_key;
CREATE UNIQUE INDEX IF NOT EXISTS products_org_sku_idx ON products (org_id, sku);

-- One active policy *per organisation*, not one globally.
DROP INDEX IF EXISTS policies_single_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS policies_org_active_idx
    ON policies (org_id) WHERE active;

-- Channel connections are per-org: each company brings its own bot token.
ALTER TABLE channel_connections DROP CONSTRAINT IF EXISTS channel_connections_channel_key;
CREATE UNIQUE INDEX IF NOT EXISTS channel_connections_org_channel_idx
    ON channel_connections (org_id, channel);

INSERT INTO schema_migrations (version) VALUES ('016_tenancy')
    ON CONFLICT (version) DO NOTHING;
