"""Sourcing end to end: broadcast → window closes → score → gate → book.

This is the path that stranded every shipment reaching SOURCING, and the first
one that puts rows in proposed_actions, approvals and tool_calls.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from logistics.approvals import ApprovalRepo
from logistics.domain.models import WorkRequest
from logistics.domain.states import ShipmentState
from logistics.handlers import registry as real_registry
from logistics.orchestrator.worker import Worker

S = ShipmentState
NAIRA = 100


def _worker(db, queue, orchestrator, repo, settings, policy):  # noqa: ANN001, ANN202
    return Worker(
        db=db, queue=queue, orchestrator=orchestrator, repo=repo,
        registry=real_registry, settings=settings, policy=policy,
    )


async def _drain(worker, limit: int = 25) -> int:  # noqa: ANN001
    steps = 0
    while steps < limit and await worker.process_one():
        steps += 1
    return steps


async def _planned(repo, reference, *, deadline_hours: float = 96):
    """A shipment sitting at PLANNED, ready to source."""
    return await repo.create(
        reference=reference,
        state=S.PLANNED,
        origin={"city": "Lagos", "warehouse": "Lagos"},
        destination={"city": "Abuja", "address": "12 Ahmadu Bello Way"},
        cargo={"sku": "DEFAULT", "quantity": 100, "weight_kg": 1800},
        deadline=datetime.now(UTC) + timedelta(hours=deadline_hours),
    )


async def _source_and_close(db, queue, orchestrator, repo, settings, policy, shipment):  # noqa: ANN001
    """Run carrier.source, then fire the window timer immediately."""
    await queue.enqueue(WorkRequest(kind="carrier.source", shipment_id=shipment.id))
    worker = _worker(db, queue, orchestrator, repo, settings, policy)
    await worker.process_one()

    # The window is a 45-minute timer; pull it forward rather than waiting.
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE work_items SET run_after = now()"
            " WHERE kind = 'carrier.close_window' AND state = 'PENDING'"
        )
    return await _drain(worker)


# ------------------------------------------------------------- broadcasting


async def test_sourcing_asks_every_reachable_carrier(
    db, queue, orchestrator, repo, settings, reference, carriers, policy
):
    shipment = await _planned(repo, reference)
    await queue.enqueue(WorkRequest(kind="carrier.source", shipment_id=shipment.id))
    await _worker(db, queue, orchestrator, repo, settings, policy).process_one()

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT state, count(*) AS n FROM quotes WHERE shipment_id = %s GROUP BY state",
            (shipment.id,),
        )
        by_state = {r["state"]: r["n"] for r in await cur.fetchall()}

    # All three are API carriers, so all three answer within the call.
    assert by_state.get("RECEIVED") == 3
    assert (await repo.get(shipment.id)).state is S.SOURCING


async def test_no_reachable_carriers_raises_an_exception(
    db, queue, orchestrator, repo, settings, reference, policy
):
    """No fleet fixture: nothing to ask. A silent wait would be worse."""
    shipment = await _planned(repo, reference)
    await queue.enqueue(WorkRequest(kind="carrier.source", shipment_id=shipment.id))
    await _worker(db, queue, orchestrator, repo, settings, policy).process_one()

    assert (await repo.get(shipment.id)).state is S.EXCEPTION


async def test_a_quote_row_exists_for_the_ask_not_just_the_answer(
    db, queue, orchestrator, repo, settings, reference, carriers, policy
):
    """A carrier who never replies must be visible as an unanswered request."""
    shipment = await _planned(repo, reference)
    await queue.enqueue(WorkRequest(kind="carrier.source", shipment_id=shipment.id))
    await _worker(db, queue, orchestrator, repo, settings, policy).process_one()

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM quotes WHERE shipment_id = %s", (shipment.id,)
        )
        assert (await cur.fetchone())["n"] == 3


# ------------------------------------------------------- closing the window


async def test_window_close_scores_and_proposes(
    db, queue, orchestrator, repo, settings, reference, carriers, policy, fx
):
    shipment = await _planned(repo, reference)
    await _source_and_close(db, queue, orchestrator, repo, settings, policy, shipment)

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT action, state, policy_decision, rationale FROM proposed_actions"
            " WHERE shipment_id = %s",
            (shipment.id,),
        )
        proposal = await cur.fetchone()

    assert proposal is not None, "the first proposed action in the system"
    assert proposal["action"] == "book_shipment"
    assert proposal["policy_decision"] == "REQUIRE_APPROVAL"
    assert proposal["rationale"]


async def test_every_quote_gets_a_stored_score(
    db, queue, orchestrator, repo, settings, reference, carriers, policy, fx
):
    """The dashboard renders these rather than recomputing, so the score that
    spends money is the score on the screen."""
    shipment = await _planned(repo, reference)
    await _source_and_close(db, queue, orchestrator, repo, settings, policy, shipment)

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT score, score_breakdown FROM quotes"
            " WHERE shipment_id = %s AND score IS NOT NULL",
            (shipment.id,),
        )
        scored = await cur.fetchall()

    assert len(scored) == 3
    assert all(0 <= float(r["score"]) <= 1 for r in scored)
    assert "parts" in scored[0]["score_breakdown"]


async def test_exactly_one_quote_is_selected(
    db, queue, orchestrator, repo, settings, reference, carriers, policy, fx
):
    shipment = await _planned(repo, reference)
    await _source_and_close(db, queue, orchestrator, repo, settings, policy, shipment)

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT state, count(*) AS n FROM quotes WHERE shipment_id = %s GROUP BY state",
            (shipment.id,),
        )
        by_state = {r["state"]: r["n"] for r in await cur.fetchall()}

    assert by_state.get("SELECTED") == 1
    assert by_state.get("REJECTED") == 2


async def test_phase_one_policy_sends_every_booking_to_a_human(
    db, queue, orchestrator, repo, settings, reference, carriers, policy, fx
):
    shipment = await _planned(repo, reference)
    await _source_and_close(db, queue, orchestrator, repo, settings, policy, shipment)

    final = await repo.get(shipment.id)
    assert final.state is S.AWAITING_APPROVAL

    pending = await ApprovalRepo(db).pending()
    assert len(pending) == 1
    assert pending[0].shipment_id == shipment.id
    assert pending[0].amount_minor > 0


async def test_an_escalation_timer_is_scheduled(
    db, queue, orchestrator, repo, settings, reference, carriers, policy, fx
):
    """An unanswered approval must not sit silently at 2am."""
    shipment = await _planned(repo, reference)
    await _source_and_close(db, queue, orchestrator, repo, settings, policy, shipment)

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT kind FROM work_items WHERE shipment_id = %s AND state = 'PENDING'",
            (shipment.id,),
        )
        kinds = {r["kind"] for r in await cur.fetchall()}
    assert "approval.escalate" in kinds


async def test_a_tight_deadline_changes_who_wins(
    db, queue, orchestrator, repo, settings, reference, carriers, policy, fx
):
    """The §7 case, end to end: with no slack the unreliable carrier is
    excluded rather than discounted."""
    shipment = await repo.create(
        reference=reference,
        state=S.PLANNED,
        origin={"city": "Lagos", "warehouse": "Lagos"},
        destination={"city": "Abuja"},
        cargo={"sku": "DEFAULT", "quantity": 100, "weight_kg": 1800},
        deadline=datetime.now(UTC) + timedelta(hours=12),  # essentially no room
    )
    # Slack is transit against the deadline, so the plan has to carry a transit
    # estimate for the constraint to have anything to measure.
    async with db.connection() as conn:
        await conn.execute(
            'UPDATE shipments SET plan = \'{"transit_hours": 11.5, "modes": ["ROAD"]}\' WHERE id = %s',
            (shipment.id,),
        )
    await _source_and_close(db, queue, orchestrator, repo, settings, policy, shipment)

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT c.code FROM quotes q JOIN carriers c ON c.id = q.carrier_id"
            " WHERE q.shipment_id = %s AND q.state = 'SELECTED'",
            (shipment.id,),
        )
        winner = await cur.fetchone()
        cur = await conn.execute(
            "SELECT rationale FROM proposed_actions WHERE shipment_id = %s",
            (shipment.id,),
        )
        rationale = (await cur.fetchone())["rationale"]

    assert winner["code"] == "T-PREMIUM"
    assert "excluded" in rationale


# ------------------------------------------------------------- the full path


async def test_approval_leads_to_a_booked_shipment(
    db, queue, orchestrator, repo, settings, reference, carriers, policy, fx
):
    """The whole point: propose → gate → approve → book, with real rows in
    every table the safety architecture depends on."""
    shipment = await _planned(repo, reference)
    await _source_and_close(db, queue, orchestrator, repo, settings, policy, shipment)

    approval = (await ApprovalRepo(db).pending())[0]
    decided = await ApprovalRepo(db).decide(approval.token, approved=True, by="ops")
    assert decided is not None

    await queue.enqueue(
        WorkRequest(
            kind="approval.granted",
            shipment_id=shipment.id,
            payload={
                "approval_id": str(approval.id),
                "proposed_action_id": str(approval.proposed_action_id),
                "decided_by": "ops",
                "round": 1,
            },
        )
    )
    await _drain(_worker(db, queue, orchestrator, repo, settings, policy))

    final = await repo.get(shipment.id)
    assert final.state is S.BOOKED
    assert final.booking["booking_ref"]
    assert final.booking["carrier_code"]

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT state, tool_call_id FROM proposed_actions WHERE shipment_id = %s",
            (shipment.id,),
        )
        assert (await cur.fetchone())["state"] == "EXECUTED"

        cur = await conn.execute(
            "SELECT tool, state FROM tool_calls WHERE shipment_id = %s", (shipment.id,)
        )
        call = await cur.fetchone()
    assert call["tool"] == "book_shipment"
    assert call["state"] == "RESULT"


async def test_rejection_sources_again_rather_than_giving_up(
    db, queue, orchestrator, repo, settings, reference, carriers, policy, fx
):
    shipment = await _planned(repo, reference)
    await _source_and_close(db, queue, orchestrator, repo, settings, policy, shipment)

    approval = (await ApprovalRepo(db).pending())[0]
    await ApprovalRepo(db).decide(approval.token, approved=False, by="ops")

    await queue.enqueue(
        WorkRequest(
            kind="approval.refused",
            shipment_id=shipment.id,
            payload={"approval_id": str(approval.id), "decided_by": "ops"},
        )
    )
    await _worker(db, queue, orchestrator, repo, settings, policy).process_one()

    assert (await repo.get(shipment.id)).state is S.PLANNED


async def test_booking_without_an_approved_action_is_refused(
    db, queue, orchestrator, repo, settings, reference, carriers, policy, fx
):
    """The gate is the whole point. Nothing books without it."""
    shipment = await _planned(repo, reference)
    await _source_and_close(db, queue, orchestrator, repo, settings, policy, shipment)

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id FROM proposed_actions WHERE shipment_id = %s", (shipment.id,)
        )
        action_id = (await cur.fetchone())["id"]

    # Skip the approval entirely.
    await queue.enqueue(
        WorkRequest(
            kind="carrier.book",
            shipment_id=shipment.id,
            payload={"proposed_action_id": str(action_id), "round": 1},
        )
    )
    await _worker(db, queue, orchestrator, repo, settings, policy).process_one()

    assert (await repo.get(shipment.id)).state is S.AWAITING_APPROVAL

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT state, last_error FROM work_items"
            " WHERE kind = 'carrier.book' AND shipment_id = %s",
            (shipment.id,),
        )
        row = await cur.fetchone()
    assert row["state"] == "DEAD"
    assert "not APPROVED" in row["last_error"]


async def test_no_dead_close_window_items_remain(
    db, queue, orchestrator, repo, settings, reference, carriers, policy, fx
):
    """The dead-end this change exists to close."""
    shipment = await _planned(repo, reference)
    await _source_and_close(db, queue, orchestrator, repo, settings, policy, shipment)

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM work_items"
            " WHERE kind = 'carrier.close_window' AND state = 'DEAD'"
        )
        assert (await cur.fetchone())["n"] == 0
