"""Customers, fleet, and the link that was missing between them.

`shipments.customer_id` existed since migration 004 and had **zero writers**.
`channels/inbound.py` matches an inbound email through
`JOIN customers c ON c.id = s.customer_id`, so that join could never find a
row: a customer writing in about their own shipment was never matched to it.

Same shape as the three dead paths the earlier audit turned up — the column is
there, something reads it, nothing fills it, and everything looks correct until
you ask which code actually writes to the table.
"""

from __future__ import annotations

from psycopg.types.json import Jsonb

from logistics.channels.base import ChannelKind, Inbound
from logistics.channels.inbound import InboundRouter
from logistics.domain.states import ShipmentState

S = ShipmentState


async def _customer(
    db, code="ACME", name="Acme Manufacturing", *, sla_hours=24, contacts=None
) -> str:
    if contacts is None:
        contacts = [{"name": "Ada", "email": "ops@acme.example"}]
    async with db.connection() as conn:
        cur = await conn.execute(
            "INSERT INTO customers (code, name, sla_hours, contacts)"
            " VALUES (%s, %s, %s, %s)"
            " ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name"
            " RETURNING id",
            (code, name, sla_hours, Jsonb(contacts)),
        )
        return (await cur.fetchone())["id"]


# ------------------------------------------------------- resolving the link


async def test_a_shipment_links_to_its_customer_by_code(db, repo, reference):
    customer_id = await _customer(db)
    shipment = await repo.create(reference=reference, customer_ref="ACME")

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT customer_id FROM shipments WHERE id = %s", (shipment.id,)
        )
        assert (await cur.fetchone())["customer_id"] == customer_id


async def test_the_code_match_ignores_case(db, repo, reference):
    customer_id = await _customer(db)
    shipment = await repo.create(reference=reference, customer_ref="acme")

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT customer_id FROM shipments WHERE id = %s", (shipment.id,)
        )
        assert (await cur.fetchone())["customer_id"] == customer_id


async def test_an_exact_name_also_matches(db, repo, reference):
    """Orders arrive naming the company, not its internal code."""
    customer_id = await _customer(db)
    shipment = await repo.create(
        reference=reference, customer_ref="Acme Manufacturing"
    )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT customer_id FROM shipments WHERE id = %s", (shipment.id,)
        )
        assert (await cur.fetchone())["customer_id"] == customer_id


async def test_a_near_miss_links_to_nobody(db, repo, reference):
    """No fuzzy matching, on purpose. Attaching a shipment to the wrong
    customer is worse than attaching it to none — the wrong one then receives
    the updates, and nobody notices until they read about someone else's
    delivery."""
    await _customer(db)
    shipment = await repo.create(reference=reference, customer_ref="Acme Manufacturng")

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT customer_id, customer_ref FROM shipments WHERE id = %s",
            (shipment.id,),
        )
        row = await cur.fetchone()
    assert row["customer_id"] is None
    # The unmatched text is kept, so a human can see what the order said.
    assert row["customer_ref"] == "Acme Manufacturng"


async def test_no_customer_ref_is_not_an_error(db, repo, reference):
    shipment = await repo.create(reference=reference)
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT customer_id FROM shipments WHERE id = %s", (shipment.id,)
        )
        assert (await cur.fetchone())["customer_id"] is None


async def test_an_inactive_customer_is_not_matched(db, repo, reference):
    await _customer(db)
    async with db.connection() as conn:
        await conn.execute("UPDATE customers SET active = false WHERE code = 'ACME'")

    shipment = await repo.create(reference=reference, customer_ref="ACME")
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT customer_id FROM shipments WHERE id = %s", (shipment.id,)
        )
        assert (await cur.fetchone())["customer_id"] is None


async def test_a_customer_in_another_org_is_not_matched(db, repo, reference, other_org):
    """RLS scopes the lookup, so this needs no filter of its own — which is
    exactly why it is worth a test."""
    async with db.connection(privileged=True) as conn:
        await conn.execute(
            "INSERT INTO customers (org_id, code, name, contacts)"
            " VALUES (%s, 'THEIRS', 'Their Company', %s)",
            (other_org, Jsonb([])),
        )

    shipment = await repo.create(reference=reference, customer_ref="THEIRS")
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT customer_id FROM shipments WHERE id = %s", (shipment.id,)
        )
        assert (await cur.fetchone())["customer_id"] is None


# ------------------------------------------------- what the link unblocks


async def test_an_email_from_a_known_customer_now_finds_their_shipment(db, repo):
    """The dead path, working. Before the link existed this returned nothing
    for every customer, so an emailed question about a shipment arrived
    unattached and the support agent had no idea what it was about."""
    await _customer(db, contacts=[{"name": "Ada", "email": "ada@acme.example"}])
    await repo.create(
        reference="CUST-EMAIL-1", state=S.IN_TRANSIT, customer_ref="ACME"
    )

    routed = await InboundRouter(db).route(
        Inbound(
            channel=ChannelKind.GMAIL,
            external_id="ada@acme.example",
            text="Where is my delivery?",
        )
    )
    assert routed.reference == "CUST-EMAIL-1"


async def test_two_open_shipments_means_asking_rather_than_guessing(db, repo):
    """"Exactly one" is the rule. With two open shipments a guess is worse than
    a question — the customer gets told about the wrong consignment."""
    await _customer(db, contacts=[{"name": "Ada", "email": "ada@acme.example"}])
    await repo.create(reference="CUST-A", state=S.IN_TRANSIT, customer_ref="ACME")
    await repo.create(reference="CUST-B", state=S.IN_TRANSIT, customer_ref="ACME")

    routed = await InboundRouter(db).route(
        Inbound(
            channel=ChannelKind.GMAIL,
            external_id="ada@acme.example",
            text="Where is my delivery?",
        )
    )
    assert routed.reference is None


async def test_a_closed_shipment_is_not_what_they_are_asking_about(db, repo):
    await _customer(db, contacts=[{"name": "Ada", "email": "ada@acme.example"}])
    await repo.create(reference="CUST-OLD", state=S.CLOSED, customer_ref="ACME")

    routed = await InboundRouter(db).route(
        Inbound(
            channel=ChannelKind.GMAIL,
            external_id="ada@acme.example",
            text="Where is my delivery?",
        )
    )
    assert routed.reference is None


# ----------------------------------------------------------------- seeding


async def test_the_seed_populates_customers_and_fleet(db):
    """All three tables were built and empty. A page over an empty table looks
    identical to a page over a broken query."""
    from logistics.seed import seed_demo

    counts = await seed_demo(db)
    assert counts["customers"] >= 5
    assert counts["conveyances"] >= 5
    assert counts["drivers"] >= 5


async def test_seeding_twice_does_not_duplicate_the_fleet(db):
    """Conveyances have no natural key, so identity is the registration inside
    `identifiers`. Getting that wrong grows the fleet on every run."""
    from logistics.seed import seed_demo

    await seed_demo(db)
    await seed_demo(db)

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT identifiers->>'registration' AS reg, count(*) AS n"
            "  FROM conveyances GROUP BY 1 HAVING count(*) > 1"
        )
        assert not await cur.fetchall(), "re-seeding duplicated vehicles"

        cur = await conn.execute(
            "SELECT licence_number, count(*) AS n FROM drivers"
            " GROUP BY 1 HAVING count(*) > 1"
        )
        assert not await cur.fetchall(), "re-seeding duplicated drivers"


async def test_the_seeded_fleet_belongs_to_reachable_carriers(db):
    """A fleet listing that includes trucks belonging to a haulier nobody can
    contact is a list of things that cannot be dispatched."""
    from logistics.seed import seed_demo

    await seed_demo(db)
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM conveyances WHERE carrier_id IS NULL"
        )
        assert (await cur.fetchone())["n"] == 0
