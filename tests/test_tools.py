"""The tool layer (§35).

What is being tested is the order of the gates as much as the gates
themselves. Permission before schema, schema before policy: an agent reaching
outside its remit must fail differently, and earlier, than one merely over
budget — the first is a wiring bug, the second is Tuesday.
"""

from __future__ import annotations

import pytest

from logistics.domain.states import ShipmentState
from logistics.tools import (
    AGENT_TOOLS,
    PermissionDenied,
    Tier,
    ToolContext,
    ToolDenied,
    ToolInputError,
    ToolNotFound,
    registry,
)

S = ShipmentState


@pytest.fixture
def ctx(db, policy):
    return ToolContext(db=db, agent="exception", policy=policy)


# ------------------------------------------------------- the registry itself


def test_every_tool_declares_what_it_is_and_what_it_costs():
    for name in registry.names:
        spec = registry.get(name)
        assert isinstance(spec.tier, Tier), f"{name} has no tier"
        assert len(spec.description) > 30, f"{name} needs a real description"
        assert spec.action, f"{name} has no policy action name"


def test_no_tool_is_granted_to_nobody():
    """A tool no agent can call is either a forgotten permission or dead code."""
    assert registry.unreachable() == set()


def test_no_permission_names_a_tool_that_does_not_exist():
    """A typo in a permission set would otherwise surface at runtime as a
    puzzling ToolNotFound, long after the edit that caused it."""
    assert registry.undefined() == set()


def test_only_side_effecting_tools_are_run_through_the_executor():
    """The executor writes an intent row per call. Wrapping reads in one would
    fill tool_calls with noise and teach everyone to ignore it."""
    for name in registry.names:
        spec = registry.get(name)
        if spec.tier is Tier.READ:
            assert not spec.key_fields, f"{name} is a read but claims idempotency"


def test_tools_that_leave_the_building_are_idempotent():
    """Tier 2 and above reach something outside this system, and a retry after
    a timeout must not do it twice."""
    for name in registry.names:
        spec = registry.get(name)
        if spec.tier >= Tier.EXTERNAL:
            assert spec.key_fields, f"{name} has external effects but no idempotency key"


def test_a_tool_advertises_the_schema_it_validates_against():
    """The description an agent reads and the contract it is held to are the
    same object, so they cannot drift."""
    schema = registry.get("get_shipment").schema()
    assert schema["name"] == "get_shipment"
    assert "reference" in schema["parameters"]["properties"]
    assert schema["tier"] == 0


# ---------------------------------------------------------------- permission


async def test_an_agent_cannot_call_a_tool_outside_its_remit(ctx):
    """The support agent talks to customers. It does not spend money."""
    with pytest.raises(PermissionDenied):
        await registry.call("support", "book_carrier", {}, ctx)


def test_permissions_are_data_not_prose():
    assert "book_carrier" not in AGENT_TOOLS["support"]
    assert "book_carrier" in AGENT_TOOLS["carrier"]
    assert AGENT_TOOLS["orchestrator"] == set()


def test_the_tracking_agent_can_only_read():
    """A detector that can change what it is watching produces findings that
    mean nothing."""
    for name in AGENT_TOOLS["tracking"]:
        assert registry.get(name).tier is Tier.READ


def test_the_analytics_agent_can_only_read():
    for name in AGENT_TOOLS["analytics"]:
        assert registry.get(name).tier is Tier.READ


async def test_an_unknown_agent_is_granted_nothing(ctx):
    with pytest.raises(PermissionDenied):
        await registry.call("marketing", "get_shipment", {"reference": "X"}, ctx)


async def test_permission_is_checked_before_the_arguments(ctx):
    """Ordering matters. If schema ran first, an agent reaching outside its
    remit with malformed arguments would be told its arguments were wrong —
    and someone would fix the arguments."""
    with pytest.raises(PermissionDenied):
        await registry.call("support", "book_carrier", {"nonsense": True}, ctx)


async def test_an_unknown_tool_is_refused_before_anything_else(ctx):
    with pytest.raises(ToolNotFound):
        await registry.call("exception", "delete_everything", {}, ctx)


def test_an_agent_is_only_told_about_tools_it_may_use():
    """Describing a tool an agent cannot call invites it to try, and then the
    refusal reads as a fault rather than a boundary."""
    offered = {s["name"] for s in registry.schemas_for("support")}
    assert offered == AGENT_TOOLS["support"]
    assert "book_carrier" not in offered


# -------------------------------------------------------------------- schema


async def test_bad_arguments_are_refused_with_a_usable_message(ctx):
    with pytest.raises(ToolInputError) as exc:
        await registry.call("warehouse", "reserve_inventory", {
            "reference": "SHP-1", "sku": "DEFAULT", "warehouse": "LOS-1",
            "quantity": -5,
        }, ctx)
    # The text goes back to a model as a retry prompt, so it has to name the
    # field and say what is wrong with it.
    assert "quantity" in str(exc.value)


async def test_missing_arguments_are_refused(ctx):
    with pytest.raises(ToolInputError) as exc:
        await registry.call("exception", "get_shipment", {}, ctx)
    assert "reference" in str(exc.value)


async def test_an_unknown_channel_is_refused_by_name(ctx):
    with pytest.raises(ToolInputError) as exc:
        await registry.call("support", "send_message", {
            "channel": "CARRIER_PIGEON", "to": "123", "text": "hello",
        }, ctx)
    assert "CARRIER_PIGEON" in str(exc.value)


# -------------------------------------------------------------------- policy


async def test_a_read_is_not_gated(db, repo, reference):
    """No policy engine at all, and a read still works. Putting a gate in front
    of a SELECT only teaches operators that gate messages are noise."""
    await repo.create(reference=reference, state=S.DRAFT)
    result = await registry.call(
        "exception", "get_shipment", {"reference": reference},
        ToolContext(db=db, agent="exception", policy=None),
    )
    assert result.response["found"] is True


async def test_a_write_with_no_policy_engine_is_denied(db):
    """Fails closed. A tool that spends money with no policy behind it is
    exactly the failure this structure exists to prevent."""
    with pytest.raises(ToolDenied, match="no policy engine"):
        await registry.call("carrier", "book_carrier", {
            "reference": "SHP-1", "carrier_code": "T-A", "amount_minor": 1_000_00,
        }, ToolContext(db=db, agent="carrier", policy=None))


async def test_booking_requires_a_human_under_the_phase_one_policy(
    db, policy, repo, reference
):
    """The seeded cap is zero, so every booking reaches a person."""
    shipment = await repo.create(reference=reference, state=S.SOURCING)
    with pytest.raises(ToolDenied) as exc:
        await registry.call("carrier", "book_carrier", {
            "reference": reference, "carrier_code": "T-PREMIUM",
            "amount_minor": 45_000_00,
        }, ToolContext(
            db=db, agent="carrier", policy=policy, shipment_id=shipment.id
        ))
    assert exc.value.decision == "REQUIRE_APPROVAL"
    assert exc.value.proposal_id is not None, "the gate must leave an audit row"
    # Refused on the amount, not for want of one. Before the price was an
    # argument, the gate could not see it and every booking was refused with
    # "carries no amount_minor" — the same answer for the right and wrong
    # reasons, which would stop being the same answer once caps rise.
    assert "amount_minor" not in exc.value.reason


async def test_the_gate_sees_the_price_it_is_checking(db, policy, repo, reference):
    """The proposal row must record what was actually asked for, or the audit
    trail says a booking was gated without saying at what value."""
    shipment = await repo.create(reference=reference, state=S.SOURCING)
    with pytest.raises(ToolDenied):
        await registry.call("carrier", "book_carrier", {
            "reference": reference, "carrier_code": "T-PREMIUM",
            "amount_minor": 45_000_00, "currency": "NGN",
        }, ToolContext(
            db=db, agent="carrier", policy=policy, shipment_id=shipment.id
        ))

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT params FROM proposed_actions WHERE shipment_id = %s",
            (shipment.id,),
        )
        params = (await cur.fetchone())["params"]
    assert params["amount_minor"] == 45_000_00
    assert params["currency"] == "NGN"


async def test_a_gated_refusal_is_recorded_as_a_proposal(db, policy, repo, reference):
    """The row is the evidence that the gate ran. Without it, 'the agent did
    not book' and 'the agent was stopped from booking' look identical."""
    shipment = await repo.create(reference=reference, state=S.SOURCING)
    with pytest.raises(ToolDenied):
        await registry.call("carrier", "book_carrier", {
            "reference": reference, "carrier_code": "T-PREMIUM",
            "amount_minor": 45_000_00,
        }, ToolContext(
            db=db, agent="carrier", policy=policy, shipment_id=shipment.id
        ))

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT action, tier, policy_decision, rationale FROM proposed_actions"
            " WHERE shipment_id = %s", (shipment.id,)
        )
        row = await cur.fetchone()

    assert row["action"] == "book_shipment"
    assert row["tier"] == 3
    assert row["policy_decision"] == "REQUIRE_APPROVAL"
    assert "carrier agent" in row["rationale"]


async def _allow_booking(db, cap_minor: int = 500_000_00) -> None:
    """A policy that would let a booking through, so the guards after the gate
    can actually be reached."""
    import json

    async with db.connection() as conn:
        await conn.execute("UPDATE policies SET active = false WHERE active")
        await conn.execute(
            "INSERT INTO policies (version, name, rules, active)"
            " VALUES (99, 'tools-test', %s, true)"
            " ON CONFLICT (org_id, version) DO UPDATE"
            "   SET rules = EXCLUDED.rules, active = true",
            (json.dumps({
                "base_currency": "NGN",
                "fx_max_age_hours": 24,
                "auto_execute_tiers": [0, 1],
                "actions": {"book_shipment": {"auto_approve_below_minor": cap_minor}},
            }),),
        )


async def _quote(db, shipment_id, carrier_code: str, amount_minor: int, round_no=1):
    from logistics.carriers.adapter import Quote, QuoteState
    from logistics.carriers.repo import QuoteRepo
    from logistics.domain.money import Money

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id FROM carriers WHERE code = %s", (carrier_code,)
        )
        carrier_id = (await cur.fetchone())["id"]

    await QuoteRepo(db).record(
        shipment_id=shipment_id, round=round_no, source="API",
        quote=Quote(
            carrier_id=carrier_id, state=QuoteState.RECEIVED,
            price=Money(amount_minor, "NGN"), transit_hours=11.0,
        ),
    )
    return carrier_id


async def test_a_quoted_price_the_agent_misstated_books_nothing(
    db, policy, repo, reference, carriers
):
    """The gate checks the caps against a number the *caller* supplied, because
    it runs before the quote is read. So the number is an assertion, and this
    is where it is held to account: claim ₦400k, clear a ₦500k cap, and then
    have the quote actually say ₦900k — nothing books."""
    await _allow_booking(db)
    shipment = await repo.create(reference=reference, state=S.SOURCING)
    await _quote(db, shipment.id, "T-PREMIUM", 900_000_00)

    result = await registry.call("carrier", "book_carrier", {
        "reference": reference, "carrier_code": "T-PREMIUM",
        "amount_minor": 400_000_00, "round": 1,
    }, ToolContext(db=db, agent="carrier", policy=policy, shipment_id=shipment.id))

    assert result.response["ok"] is False
    assert "different amount" in result.response["reason"]

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM work_items WHERE kind = 'carrier.book'"
        )
        assert (await cur.fetchone())["n"] == 0, "nothing may have been queued"


async def test_an_honest_price_reaches_the_booking_handler(
    db, policy, repo, reference, carriers
):
    """And the handoff names the proposal, because `carrier.book` refuses to
    tender against a booking with no decision behind it."""
    await _allow_booking(db)
    shipment = await repo.create(reference=reference, state=S.SOURCING)
    await _quote(db, shipment.id, "T-SOLID", 120_000_00)

    result = await registry.call("carrier", "book_carrier", {
        "reference": reference, "carrier_code": "T-SOLID",
        "amount_minor": 120_000_00, "round": 1,
    }, ToolContext(db=db, agent="carrier", policy=policy, shipment_id=shipment.id))

    assert result.response["ok"] is True

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT payload FROM work_items WHERE kind = 'carrier.book'"
        )
        row = await cur.fetchone()
    assert row is not None, "the existing booking handler must be the one that tenders"
    assert row["payload"]["proposed_action_id"], "the handler re-checks this"


async def test_a_carrier_that_did_not_quote_cannot_be_booked(
    db, policy, repo, reference, carriers
):
    await _allow_booking(db)
    shipment = await repo.create(reference=reference, state=S.SOURCING)
    await _quote(db, shipment.id, "T-SOLID", 120_000_00)

    result = await registry.call("carrier", "book_carrier", {
        "reference": reference, "carrier_code": "T-CHEAP",
        "amount_minor": 90_000_00, "round": 1,
    }, ToolContext(db=db, agent="carrier", policy=policy, shipment_id=shipment.id))

    assert result.response["ok"] is False
    assert "did not quote" in result.response["reason"]
    # Says who did, so the caller can pick again rather than guessing.
    assert "T-SOLID" in result.response["reason"]


async def test_an_internal_write_is_allowed_without_a_human(db, policy, repo, reference):
    """Tier 1 is in `auto_execute_tiers` and carries no spend, so reserving
    stock does not queue for approval. If it did, nothing would ever ship."""
    shipment = await repo.create(reference=reference, state=S.VALIDATED)
    result = await registry.call("warehouse", "release_inventory", {
        "reference": reference,
    }, ToolContext(db=db, agent="warehouse", policy=policy, shipment_id=shipment.id))
    assert result.ok


# ------------------------------------------------------------------- effects


async def test_a_read_returns_what_the_repository_holds(db, policy, repo, reference):
    await repo.create(
        reference=reference, state=S.IN_TRANSIT,
        origin={"city": "Lagos"}, destination={"city": "Abuja"},
    )
    result = await registry.call(
        "exception", "get_shipment", {"reference": reference},
        ToolContext(db=db, agent="exception", policy=policy),
    )
    assert result.response["state"] == "IN_TRANSIT"
    assert result.response["origin"]["city"] == "Lagos"


async def test_a_missing_shipment_is_not_an_error(db, policy):
    """It is also what another organisation's shipment looks like from here,
    and the two must be indistinguishable."""
    result = await registry.call(
        "exception", "get_shipment", {"reference": "NOPE-1"},
        ToolContext(db=db, agent="exception", policy=policy),
    )
    assert result.response["found"] is False


async def test_reserving_stock_goes_through_the_real_inventory(
    db, policy, repo, reference
):
    shipment = await repo.create(reference=reference, state=S.VALIDATED)
    result = await registry.call("warehouse", "reserve_inventory", {
        "reference": reference, "sku": "DEFAULT",
        "warehouse": "NOWHERE", "quantity": 5,
    }, ToolContext(db=db, agent="warehouse", policy=policy, shipment_id=shipment.id))

    # No such warehouse, so nothing is held — and it says so rather than
    # raising, because a shortfall is an operational fact the caller decides
    # about, not a crash.
    assert result.response["ok"] is False
    assert result.response["reserved"] == 0


async def test_inventory_is_visible_through_the_tool(db, policy):
    result = await registry.call(
        "warehouse", "get_inventory", {"sku": "DEFAULT"},
        ToolContext(db=db, agent="warehouse", policy=policy),
    )
    assert "total_available" in result.response
    assert isinstance(result.response["warehouses"], list)


async def test_carriers_are_listed_with_their_record(db, policy, carriers):
    result = await registry.call(
        "carrier", "get_carriers", {"mode": "ROAD"},
        ToolContext(db=db, agent="carrier", policy=policy),
    )
    codes = {c["code"] for c in result.response["carriers"]}
    assert {"T-CHEAP", "T-SOLID", "T-PREMIUM"} <= codes
    premium = next(c for c in result.response["carriers"] if c["code"] == "T-PREMIUM")
    assert premium["on_time_rate"] == 0.97


# ------------------------------------------------------------------ tenancy


async def test_a_tool_cannot_read_another_organisations_shipment(
    db, policy, other_org
):
    """The tool layer inherits tenancy rather than reimplementing it — but
    inheriting it silently is exactly the thing worth a test."""
    async with db.connection(privileged=True) as conn:
        await conn.execute(
            "INSERT INTO shipments (org_id, reference, state)"
            " VALUES (%s, 'THEIRS-1', 'IN_TRANSIT')",
            (other_org,),
        )

    result = await registry.call(
        "exception", "get_shipment", {"reference": "THEIRS-1"},
        ToolContext(db=db, agent="exception", policy=policy),
    )
    assert result.response["found"] is False
