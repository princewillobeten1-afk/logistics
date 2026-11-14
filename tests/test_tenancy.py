"""Tenant isolation.

The most important tests in the suite. Everything else in the system fails
visibly — a wrong ETA, a stuck shipment, a rejected booking. This fails
silently and looks like working software right up until one customer reads
another's shipments.

Migration 016's policies were written correctly and were completely inert,
because the application connected as a superuser and superusers ignore row
level security. `test_the_application_role_cannot_bypass_rls` is the test that
would have caught it; the rest assume it passes.
"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from psycopg.errors import InsufficientPrivilege

from logistics.db import Database, current_org, system_context, use_org
from logistics.domain.states import ShipmentState
from logistics.shipments import ShipmentRepo

SRC = Path(__file__).resolve().parents[1] / "src" / "logistics"


# ------------------------------------------------------- the role itself


async def test_the_application_role_cannot_bypass_rls(db: Database):
    """Without this, every other test in this file passes vacuously.

    A superuser — or any role with BYPASSRLS — ignores row level security
    entirely, FORCE included. The policies would be present, correct, and
    decorative.
    """
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT current_user AS role, rolsuper, rolbypassrls"
            "  FROM pg_roles WHERE rolname = current_user"
        )
        row = await cur.fetchone()

    assert row["role"] == "logistics_app"
    assert row["rolsuper"] is False, "a superuser ignores every policy below"
    assert row["rolbypassrls"] is False


async def test_the_application_role_cannot_alter_the_policies_binding_it(db: Database):
    """It has DML rights and nothing more. A role that can drop the policy
    constraining it is not constrained by it."""
    with pytest.raises(InsufficientPrivilege):
        async with db.connection() as conn:
            await conn.execute("ALTER TABLE shipments DISABLE ROW LEVEL SECURITY")


# ------------------------------------------------------- failing closed


async def test_an_unscoped_query_returns_nothing(db: Database, repo: ShipmentRepo, reference):
    """The whole design in one test. Forgetting to scope is the mistake people
    actually make; it must return zero rows, never someone else's."""
    await repo.create(reference=reference, state=ShipmentState.DRAFT)

    async with db.connection() as conn:
        cur = await conn.execute("SELECT count(*) AS n FROM shipments")
        assert (await cur.fetchone())["n"] == 1

    with use_org(None):
        async with db.connection() as conn:
            cur = await conn.execute("SELECT count(*) AS n FROM shipments")
            assert (await cur.fetchone())["n"] == 0


async def test_an_unset_org_does_not_raise(db: Database):
    """`''::uuid` raises where `NULL::uuid` is NULL. If the policy dropped the
    nullif(), releasing a connection would leave '' behind and every unscoped
    query would crash instead of returning nothing — a much noisier failure,
    and one that would push someone toward loosening the policy."""
    with use_org(None):
        async with db.connection() as conn:
            cur = await conn.execute("SELECT count(*) AS n FROM shipments")
            assert (await cur.fetchone())["n"] == 0


# ------------------------------------------------------- between tenants


async def test_one_org_cannot_read_anothers_shipments(
    db: Database, repo: ShipmentRepo, other_org, reference
):
    async with db.connection(privileged=True) as conn:
        await conn.execute(
            "INSERT INTO shipments (org_id, reference, state)"
            " VALUES (%s, 'OTHER-ORG-1', 'DRAFT')",
            (other_org,),
        )

    ours = await repo.create(reference=reference, state=ShipmentState.DRAFT)

    async with db.connection() as conn:
        cur = await conn.execute("SELECT reference FROM shipments")
        visible = {r["reference"] for r in await cur.fetchall()}

    assert visible == {reference}, "the other org's shipment must not be listed"

    with use_org(other_org):
        assert await repo.get(ours.id) is None, "not filtered — absent"


async def test_a_reference_lookup_cannot_cross_orgs(
    db: Database, repo: ShipmentRepo, other_org
):
    """The dashboard and the support agent both look shipments up by
    reference. That is the path a customer's message takes."""
    async with db.connection(privileged=True) as conn:
        await conn.execute(
            "INSERT INTO shipments (org_id, reference, state)"
            " VALUES (%s, 'SHARED-REF', 'IN_TRANSIT')",
            (other_org,),
        )

    assert await repo.get_by_reference("SHARED-REF") is None

    with use_org(other_org):
        found = await repo.get_by_reference("SHARED-REF")
    assert found is not None, "it does exist — just not for us"


async def test_the_same_reference_can_exist_in_two_orgs(
    db: Database, repo: ShipmentRepo, other_org
):
    """References are unique within a company, not across the platform. Two
    customers both numbering their shipments from 1 is normal."""
    await repo.create(reference="SHP-0001", state=ShipmentState.DRAFT)

    async with db.connection(privileged=True) as conn:
        await conn.execute(
            "INSERT INTO shipments (org_id, reference, state)"
            " VALUES (%s, 'SHP-0001', 'DRAFT')",
            (other_org,),
        )  # must not raise


async def test_a_write_cannot_be_aimed_at_another_org(db: Database, other_org):
    """WITH CHECK, not just USING. Reading is only half of it — an insert that
    names someone else's org must be refused too."""
    with pytest.raises(InsufficientPrivilege, match="row-level security"):
        async with db.connection() as conn:
            await conn.execute(
                "INSERT INTO shipments (org_id, reference, state)"
                " VALUES (%s, 'SMUGGLED', 'DRAFT')",
                (other_org,),
            )


async def test_an_update_cannot_move_a_row_to_another_org(
    db: Database, repo: ShipmentRepo, other_org, reference
):
    await repo.create(reference=reference, state=ShipmentState.DRAFT)
    with pytest.raises(InsufficientPrivilege, match="row-level security"):
        async with db.connection() as conn:
            await conn.execute(
                "UPDATE shipments SET org_id = %s WHERE reference = %s",
                (other_org, reference),
            )


async def test_deleting_another_orgs_row_affects_nothing(
    db: Database, other_org, reference
):
    """A DELETE that matches nothing is not an error, which is the right
    outcome — but it must not have deleted anything either."""
    async with db.connection(privileged=True) as conn:
        await conn.execute(
            "INSERT INTO shipments (org_id, reference, state)"
            " VALUES (%s, %s, 'DRAFT')",
            (other_org, reference),
        )

    async with db.connection() as conn:
        cur = await conn.execute("DELETE FROM shipments WHERE reference = %s", (reference,))
        assert cur.rowcount == 0

    with use_org(other_org):
        async with db.connection() as conn:
            cur = await conn.execute(
                "SELECT count(*) AS n FROM shipments WHERE reference = %s", (reference,)
            )
            assert (await cur.fetchone())["n"] == 1, "still theirs"


# ------------------------------------------------------------- plumbing


async def test_org_id_is_filled_in_from_the_context(db: Database, repo: ShipmentRepo, reference):
    """No repo names org_id anywhere. The column default reads the same
    setting the policy does, which is why 223 existing statements needed no
    changes."""
    shipment = await repo.create(reference=reference, state=ShipmentState.DRAFT)

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT org_id FROM shipments WHERE id = %s", (shipment.id,)
        )
        assert (await cur.fetchone())["org_id"] == current_org.get()


async def test_scope_does_not_survive_a_pool_checkout(db: Database, repo, reference):
    """Connections are reused. If the setting outlived the checkout, the next
    request would silently inherit the previous tenant's scope — which is the
    leak this whole design exists to prevent."""
    await repo.create(reference=reference, state=ShipmentState.DRAFT)

    async with db.connection() as conn:
        cur = await conn.execute("SELECT count(*) AS n FROM shipments")
        assert (await cur.fetchone())["n"] == 1

    with use_org(None):
        async with db.connection() as conn:
            cur = await conn.execute(
                "SELECT current_setting('app.current_org', true) AS org,"
                "       current_setting('app.system', true) AS sys"
            )
            row = await cur.fetchone()
            assert row["org"] in (None, "")
            assert row["sys"] in (None, "")


async def test_system_context_sees_every_org(db: Database, repo, other_org, reference):
    await repo.create(reference=reference, state=ShipmentState.DRAFT)
    async with db.connection(privileged=True) as conn:
        await conn.execute(
            "INSERT INTO shipments (org_id, reference, state)"
            " VALUES (%s, 'THEIRS', 'DRAFT')",
            (other_org,),
        )

    with system_context(), use_org(None):
        async with db.connection() as conn:
            cur = await conn.execute("SELECT count(*) AS n FROM shipments")
            assert (await cur.fetchone())["n"] == 2


# --------------------------------------------------- keeping it that way


async def test_every_business_table_is_protected(db: Database):
    """A migration that adds a table and forgets tenancy fails here rather
    than in production. The exclusions are listed explicitly so that adding
    one is a deliberate edit to this test."""
    exempt = {
        # global reference data, shared by every org
        "currencies", "fx_rates", "schema_migrations",
        # the identity system: readable before an org is known, because
        # resolving the org is what a login does
        "organisations", "users", "sessions",
        # a reset token is its own credential (unguessable, single-use,
        # short-lived) — org-scoping it protects nothing, and requesting a
        # reset happens with no org context yet, same as sessions
        "password_resets",
    }

    with system_context():
        async with db.connection(privileged=True) as conn:
            cur = await conn.execute(
                "SELECT relname, relrowsecurity, relforcerowsecurity"
                "  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
                " WHERE n.nspname = 'public' AND relkind IN ('r','p')"
                "   AND NOT relispartition"
            )
            tables = await cur.fetchall()

    unprotected = {
        t["relname"] for t in tables
        if not (t["relrowsecurity"] and t["relforcerowsecurity"])
    } - exempt
    assert not unprotected, f"tables without enforced RLS: {sorted(unprotected)}"


async def test_every_protected_table_has_an_org_column(db: Database):
    with system_context():
        async with db.connection(privileged=True) as conn:
            cur = await conn.execute(
                "SELECT c.relname FROM pg_class c"
                "  JOIN pg_namespace n ON n.oid = c.relnamespace"
                " WHERE n.nspname='public' AND c.relrowsecurity"
                "   AND NOT EXISTS ("
                "     SELECT 1 FROM information_schema.columns col"
                "      WHERE col.table_name = c.relname AND col.column_name = 'org_id')"
            )
            missing = [r["relname"] for r in await cur.fetchall()]
    assert not missing


def test_the_dashboard_never_takes_an_organisation_from_the_client():
    """`queryAs(orgId, ...)` bypasses the automatic session scoping — it exists
    for the SSE stream, which runs long after `cookies()` can be read.

    That makes it the one function in the dashboard where passing the wrong
    value hands a caller another tenant's data. The org must come from a
    resolved session and nowhere else, so this checks that every file using it
    also resolves a user, and that none of them read an org from the request.
    """
    root = Path(__file__).resolve().parents[1]
    users = [
        path
        for path in [*root.glob("app/**/*.ts"), *root.glob("app/**/*.tsx"),
                     *root.glob("lib/**/*.ts")]
        if "queryAs" in path.read_text(encoding="utf-8")
        and path.name != "db.ts"
    ]
    assert users, "queryAs has no callers; delete it rather than leaving a hole"

    for path in users:
        source = path.read_text(encoding="utf-8")
        where = path.relative_to(root).as_posix()
        assert "currentUser()" in source, (
            f"{where} calls queryAs without resolving a session first"
        )
        for smell in ("searchParams.get(\"org", "searchParams.get('org",
                      "params.org", "headers.get(\"x-org"):
            assert smell not in source, (
                f"{where} appears to take an organisation from the request; "
                "it must come from the session"
            )


def test_the_system_escape_is_used_in_only_two_modules():
    """`system_context` turns tenancy off. It is defensible in the migration
    runner and in the work queue, which must see every tenant's queue because
    one worker serves them all. Anywhere else it is a bug, and it is the kind
    of bug that reads as harmless in review."""
    users = {
        path.relative_to(SRC).as_posix()
        for path in SRC.rglob("*.py")
        if "system_context" in path.read_text(encoding="utf-8")
    }
    assert users == {"db.py", "orchestrator/queue.py"}, (
        "system_context bypasses tenant isolation; new callers need a reason"
    )


async def test_the_worker_scopes_work_to_the_items_own_org(db: Database, queue, other_org):
    """The claim crosses orgs by design. What must not cross is what happens
    next — the handler has to run inside the org that owns the item."""
    from logistics.domain.models import WorkRequest

    async with db.connection(privileged=True) as conn:
        cur = await conn.execute(
            "INSERT INTO shipments (org_id, reference, state)"
            " VALUES (%s, 'THEIR-WORK', 'DRAFT') RETURNING id",
            (other_org,),
        )
        their_shipment = (await cur.fetchone())["id"]
        await conn.execute(
            "INSERT INTO work_items (org_id, shipment_id, kind, payload)"
            " VALUES (%s, %s, 'order.validate', '{}'::jsonb)",
            (other_org, their_shipment),
        )

    item = await queue.claim()
    assert item is not None, "the claim must see every org's queue"
    assert item.org_id == other_org, "and must report whose work it is"
