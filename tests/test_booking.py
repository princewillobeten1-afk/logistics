"""The money path.

These are the tests that matter most in the codebase: everything here guards
against spending twice, or spending without a decision behind it.
"""

from __future__ import annotations

import pytest

from logistics.approvals import ApprovalRepo
from logistics.tools import (
    NeedsReconciliation,
    ToolError,
    ToolExecutor,
    idempotency_key,
)

NAIRA = 100


# ------------------------------------------------------------ idempotency


def test_key_is_stable_across_retries():
    """Attempt counters and timestamps are deliberately excluded — including
    them would make every retry a fresh call, which is the bug."""
    a = idempotency_key("book_shipment", "ship-1", 1, "carrier-a", 45_000_000)
    b = idempotency_key("book_shipment", "ship-1", 1, "carrier-a", 45_000_000)
    assert a == b


def test_key_differs_across_distinct_actions():
    base = ("book_shipment", "ship-1", 1, "carrier-a")
    assert idempotency_key(*base, 45_000_000) != idempotency_key(*base, 46_000_000)
    assert idempotency_key(*base, 1) != idempotency_key(
        "book_shipment", "ship-2", 1, "carrier-a", 1
    )


async def test_first_call_executes(db):
    executor = ToolExecutor(db)
    calls = 0

    async def tender() -> dict:
        nonlocal calls
        calls += 1
        return {"booking_ref": "ABC-1"}

    result = await executor.execute(
        key="k1", tool="book_shipment", tier=3, request={}, call=tender
    )
    assert calls == 1
    assert result.ok and not result.replayed
    assert result.response["booking_ref"] == "ABC-1"


async def test_second_call_replays_and_never_calls_out_again(db):
    """The core guarantee: a retry must not book a second truck."""
    executor = ToolExecutor(db)
    calls = 0

    async def tender() -> dict:
        nonlocal calls
        calls += 1
        return {"booking_ref": f"ABC-{calls}"}

    first = await executor.execute(
        key="same", tool="book_shipment", tier=3, request={}, call=tender
    )
    second = await executor.execute(
        key="same", tool="book_shipment", tier=3, request={}, call=tender
    )

    assert calls == 1, "the carrier must be tendered exactly once"
    assert second.replayed is True
    assert second.response == first.response


async def test_concurrent_calls_execute_only_once(db):
    """Two workers racing both pass a read check; the unique index does not."""
    import asyncio

    executor = ToolExecutor(db)
    calls = 0

    async def tender() -> dict:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return {"booking_ref": "ONCE"}

    results = await asyncio.gather(
        *(
            executor.execute(
                key="race", tool="book_shipment", tier=3, request={}, call=tender
            )
            for _ in range(4)
        ),
        return_exceptions=True,
    )
    ok = [r for r in results if not isinstance(r, Exception)]

    assert calls == 1
    assert any(getattr(r, "replayed", False) for r in ok) or len(ok) == 1


async def test_a_failed_call_is_retryable(db):
    """The call raised, so nothing committed at the far end."""
    executor = ToolExecutor(db)

    async def boom() -> dict:
        raise RuntimeError("connection reset")

    with pytest.raises(ToolError):
        await executor.execute(
            key="fail", tool="book_shipment", tier=3, request={}, call=boom
        )

    # The retry is allowed through — and this time it works.
    with pytest.raises(ToolError, match="previously failed"):
        await executor.execute(
            key="fail", tool="book_shipment", tier=3, request={},
            call=lambda: _ok({"booking_ref": "R"}),
        )

    result = await executor.execute(
        key="fail", tool="book_shipment", tier=3, request={},
        call=lambda: _ok({"booking_ref": "R"}),
    )
    assert result.response["booking_ref"] == "R"


async def test_a_crash_mid_call_demands_reconciliation(db):
    """The dangerous window: the tender reached the carrier and we never saw
    the response. Blind retry is how a truck gets booked twice."""
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO tool_calls (idempotency_key, tool, tier, request, state)"
            " VALUES ('dangling', 'book_shipment', 3, '{}', 'INTENT')"
        )

    with pytest.raises(NeedsReconciliation, match="Reconcile with the carrier"):
        await ToolExecutor(db).execute(
            key="dangling", tool="book_shipment", tier=3, request={},
            call=lambda: _ok({"booking_ref": "SHOULD-NOT-HAPPEN"}),
        )


async def test_reconciliation_adopts_what_the_carrier_already_has(db):
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO tool_calls (idempotency_key, tool, tier, request, state)"
            " VALUES ('recon', 'book_shipment', 3, '{}', 'INTENT')"
        )

    called = False

    async def tender() -> dict:
        nonlocal called
        called = True
        return {"booking_ref": "DUPLICATE"}

    result = await ToolExecutor(db).execute(
        key="recon", tool="book_shipment", tier=3, request={}, call=tender,
        reconcile=lambda: _ok({"booking_ref": "ALREADY-BOOKED"}),
    )

    assert called is False, "reconciliation must not tender again"
    assert result.response["booking_ref"] == "ALREADY-BOOKED"
    assert result.replayed is True


async def test_dangling_intents_are_findable(db):
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO tool_calls (idempotency_key, tool, tier, request, state, created_at)"
            " VALUES ('old', 'book_shipment', 3, '{}', 'INTENT', now() - interval '2 hours')"
        )
    dangling = await ToolExecutor(db).dangling(older_than_minutes=15)
    assert [d["idempotency_key"] for d in dangling] == ["old"]


# -------------------------------------------------------------- approvals


async def _proposal(db, shipment_id, amount=650_000 * NAIRA):
    from logistics.orchestrator.policy import PolicyEngine

    return await PolicyEngine(db).propose(
        shipment_id=shipment_id,
        action="book_shipment",
        params={"amount_minor": amount, "currency": "NGN"},
        tier=3,
        rationale="test",
    )


async def test_approving_twice_spends_once(db, repo, reference):
    """A double-clicked Approve at ₦650,000 must not authorise ₦1.3M."""
    shipment = await repo.create(reference=reference)
    proposal = await _proposal(db, shipment.id)
    approvals = ApprovalRepo(db)

    approval = await approvals.request(
        proposed_action_id=proposal.id,
        shipment_id=shipment.id,
        summary="Book T-PREMIUM",
        amount_minor=650_000 * NAIRA,
    )

    first = await approvals.decide(approval.token, approved=True, by="ops")
    second = await approvals.decide(approval.token, approved=True, by="ops")

    assert first is not None and first.state == "APPROVED"
    assert second is None, "a token decides exactly once"


async def test_rejecting_after_approving_does_nothing(db, repo, reference):
    shipment = await repo.create(reference=reference)
    proposal = await _proposal(db, shipment.id)
    approvals = ApprovalRepo(db)
    approval = await approvals.request(
        proposed_action_id=proposal.id, shipment_id=shipment.id, summary="x"
    )

    await approvals.decide(approval.token, approved=True, by="ops")
    assert await approvals.decide(approval.token, approved=False, by="ops2") is None


async def test_approval_advances_its_proposed_action(db, repo, reference):
    """An approval that does not move its action is a decision nothing acts on."""
    shipment = await repo.create(reference=reference)
    proposal = await _proposal(db, shipment.id)
    approvals = ApprovalRepo(db)
    approval = await approvals.request(
        proposed_action_id=proposal.id, shipment_id=shipment.id, summary="x"
    )

    await approvals.decide(approval.token, approved=True, by="ops")

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT state FROM proposed_actions WHERE id = %s", (proposal.id,)
        )
        assert (await cur.fetchone())["state"] == "APPROVED"


async def test_only_one_pending_approval_per_action(db, repo, reference):
    shipment = await repo.create(reference=reference)
    proposal = await _proposal(db, shipment.id)
    approvals = ApprovalRepo(db)

    first = await approvals.request(
        proposed_action_id=proposal.id, shipment_id=shipment.id, summary="x"
    )
    second = await approvals.request(
        proposed_action_id=proposal.id, shipment_id=shipment.id, summary="x"
    )
    assert first.id == second.id, "a retried step must not open a second approval"


async def test_unknown_token_is_refused(db):
    assert await ApprovalRepo(db).decide("not-a-token", approved=True, by="x") is None


async def test_expired_approval_cannot_be_used(db, repo, reference):
    from datetime import timedelta

    shipment = await repo.create(reference=reference)
    proposal = await _proposal(db, shipment.id)
    approvals = ApprovalRepo(db)
    approval = await approvals.request(
        proposed_action_id=proposal.id, shipment_id=shipment.id,
        summary="x", ttl=timedelta(seconds=-1),
    )

    assert await approvals.decide(approval.token, approved=True, by="ops") is None


async def test_expiry_closes_the_action_too(db, repo, reference):
    from datetime import timedelta

    shipment = await repo.create(reference=reference)
    proposal = await _proposal(db, shipment.id)
    approvals = ApprovalRepo(db)
    await approvals.request(
        proposed_action_id=proposal.id, shipment_id=shipment.id,
        summary="x", ttl=timedelta(seconds=-1),
    )

    expired = await approvals.expire_overdue()
    assert len(expired) == 1

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT state FROM proposed_actions WHERE id = %s", (proposal.id,)
        )
        assert (await cur.fetchone())["state"] == "EXPIRED"


async def test_tokens_are_unguessable(db, repo, reference):
    shipment = await repo.create(reference=reference)
    tokens = set()
    for _ in range(5):
        proposal = await _proposal(db, shipment.id)
        approval = await ApprovalRepo(db).request(
            proposed_action_id=proposal.id, shipment_id=shipment.id, summary="x"
        )
        tokens.add(approval.token)
        assert len(approval.token) >= 40, "a bearer credential authorising spend"
    assert len(tokens) == 5


async def _ok(value: dict) -> dict:
    return value
