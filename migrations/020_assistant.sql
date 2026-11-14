-- 020_assistant.sql — the shipment assistant's conversation.
--
-- Separate from `communications`, which is customer correspondence. Mixing the
-- two would put an operator's private "why is this a mess" into the same table
-- the support agent reads when deciding what to tell a customer, and the
-- customer-facing allowlist would be the only thing standing between an
-- internal aside and a customer seeing it. One table per audience.
--
-- Written by the dashboard, answered by the Python worker, read back by the
-- dashboard — which is why it is a table and not a websocket. It also means an
-- operator's question survives a page refresh.

CREATE TABLE IF NOT EXISTS assistant_messages (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE
                             DEFAULT nullif(current_setting('app.current_org', true), '')::uuid,
    shipment_id  UUID        NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,

    -- Who is asking. An operator's chat is their own working aid, not a shared
    -- channel: two dispatchers looking at the same shipment should not find
    -- each other's half-finished questions.
    user_id      UUID        REFERENCES users(id) ON DELETE SET NULL,

    role         TEXT        NOT NULL,
    body         TEXT,

    -- PENDING while the worker is thinking, so the panel can show that rather
    -- than an empty box. FAILED when the model could not produce a usable
    -- answer — deliberately visible, because silence would read as a hang.
    state        TEXT        NOT NULL DEFAULT 'DONE',
    confidence   NUMERIC(4, 3),
    next_step    TEXT,
    agent_run_id UUID        REFERENCES agent_runs(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT assistant_messages_role_known CHECK (role IN ('user', 'assistant')),
    CONSTRAINT assistant_messages_state_known CHECK (
        state IN ('PENDING', 'DONE', 'FAILED')
    ),
    -- A user turn always has text; an assistant turn may be an empty shell
    -- while it is still PENDING.
    CONSTRAINT assistant_messages_user_has_body CHECK (
        role <> 'user' OR (body IS NOT NULL AND length(btrim(body)) > 0)
    )
);

CREATE INDEX IF NOT EXISTS assistant_messages_thread_idx
    ON assistant_messages (shipment_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS assistant_messages_org_idx ON assistant_messages (org_id);

-- Tenancy, exactly as migration 016 applies it everywhere else. Not inherited:
-- a table created after 016 gets none of this automatically, which is what
-- `test_every_business_table_is_protected` exists to catch.
ALTER TABLE assistant_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_messages FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON assistant_messages;
CREATE POLICY tenant_isolation ON assistant_messages
    USING (
        org_id = nullif(current_setting('app.current_org', true), '')::uuid
        OR current_setting('app.system', true) = 'on'
    )
    WITH CHECK (
        org_id = nullif(current_setting('app.current_org', true), '')::uuid
        OR current_setting('app.system', true) = 'on'
    );

INSERT INTO schema_migrations (version) VALUES ('020_assistant')
    ON CONFLICT (version) DO NOTHING;
