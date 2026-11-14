from __future__ import annotations

import pytest

from logistics.domain.events import EventDraft
from logistics.domain.models import StepResult, WorkRequest
from logistics.domain.states import InvalidTransition, ShipmentState
from logistics.orchestrator.orchestrator import OrchestratorError

S = ShipmentState


async def _draft(repo, queue, reference):
    shipment = await repo.create(
        reference=reference,
        origin={"warehouse": "Lagos", "city": "Lagos", "address": "Ikeja depot"},
        destination={"city": "Abuja", "address": "12 Ahmadu Bello Way"},
        cargo={"quantity": 100, "weight_kg": 1800},
    )
    await queue.enqueue(WorkRequest(kind="order.validate", shipment_id=shipment.id))
    item = await queue.claim(worker_id="test")
    return shipment, item


async def test_apply_transitions_and_logs_the_event(orchestrator, repo, queue, db, reference):
    shipment, item = await _draft(repo, queue, reference)

    updated = await orchestrator.apply(item, StepResult(transition=S.VALIDATED))

    assert updated.state is S.VALIDATED
    assert updated.version == shipment.version + 1

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT seq, type, from_state, to_state FROM shipment_events"
            " WHERE shipment_id = %s ORDER BY seq",
            (shipment.id,),
        )
        events = await cur.fetchall()

    assert [e["type"] for e in events] == ["shipment.created", "shipment.state_changed"]
    assert events[-1]["from_state"] == "DRAFT"
    assert events[-1]["to_state"] == "VALIDATED"
    assert [e["seq"] for e in events] == [1, 2], "seq must be gapless"


async def test_apply_auto_schedules_the_next_step(orchestrator, repo, queue, reference):
    _, item = await _draft(repo, queue, reference)
    await orchestrator.apply(item, StepResult(transition=S.VALIDATED))

    # VALIDATED routes to warehouse.allocate — the handler did not enqueue it.
    nxt = await queue.claim(worker_id="test")
    assert nxt is not None
    assert nxt.kind == "warehouse.allocate"


async def test_wait_state_schedules_nothing(orchestrator, repo, queue, reference):
    _, item = await _draft(repo, queue, reference)
    await orchestrator.apply(item, StepResult(transition=S.NEEDS_INFO))
    assert await queue.claim(worker_id="test") is None, "NEEDS_INFO must wait for a human"


async def test_illegal_transition_is_refused(orchestrator, repo, queue, reference):
    _, item = await _draft(repo, queue, reference)
    with pytest.raises(InvalidTransition):
        await orchestrator.apply(item, StepResult(transition=S.BOOKED))


async def test_failed_apply_leaves_nothing_behind(orchestrator, repo, queue, db, reference):
    """The whole point of applying in one transaction."""
    shipment, item = await _draft(repo, queue, reference)

    with pytest.raises(InvalidTransition):
        await orchestrator.apply(
            item,
            StepResult(
                transition=S.BOOKED,
                events=(EventDraft(type="should.not.persist"),),
                enqueue=(WorkRequest(kind="should.not.exist", shipment_id=shipment.id),),
            ),
        )

    reloaded = await repo.get(shipment.id)
    assert reloaded.state is S.DRAFT
    assert reloaded.version == shipment.version

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM shipment_events WHERE shipment_id = %s AND type = %s",
            (shipment.id, "should.not.persist"),
        )
        assert (await cur.fetchone())["n"] == 0

        cur = await conn.execute(
            "SELECT count(*) AS n FROM work_items WHERE kind = %s", ("should.not.exist",)
        )
        assert (await cur.fetchone())["n"] == 0


async def test_patch_writes_shipment_columns(orchestrator, repo, queue, reference):
    shipment, item = await _draft(repo, queue, reference)
    updated = await orchestrator.apply(
        item,
        StepResult(
            transition=S.VALIDATED,
            patch={"allocation": {"sku": "DEFAULT", "quantity": 100}},
        ),
    )
    assert updated.allocation == {"sku": "DEFAULT", "quantity": 100}


async def test_patch_cannot_reach_arbitrary_columns(orchestrator, repo, queue, reference):
    """A handler must not be able to rewrite state, version, or reference."""
    _, item = await _draft(repo, queue, reference)
    for column in ("state", "version", "reference"):
        with pytest.raises(OrchestratorError, match="non-patchable"):
            await orchestrator.apply(item, StepResult(patch={column: "hacked"}))


async def test_work_item_is_closed_on_success(orchestrator, repo, queue, db, reference):
    _, item = await _draft(repo, queue, reference)
    await orchestrator.apply(item, StepResult(transition=S.VALIDATED))

    async with db.connection() as conn:
        cur = await conn.execute("SELECT state FROM work_items WHERE id = %s", (item.id,))
        assert (await cur.fetchone())["state"] == "DONE"


async def test_start_is_idempotent(orchestrator, repo, queue, reference):
    shipment = await repo.create(reference=reference)
    first = await orchestrator.start(shipment.id)
    second = await orchestrator.start(shipment.id)
    assert first is not None
    assert second is None, "scheduling the same state twice must dedupe"


async def test_legs_are_written_in_the_same_transaction(
    orchestrator, repo, queue, db, reference
):
    from logistics.domain.models import LegDraft

    shipment, item = await _draft(repo, queue, reference)
    await orchestrator.apply(
        item,
        StepResult(
            transition=S.VALIDATED,
            legs=(
                LegDraft(sequence=1, mode="ROAD", origin_name="Lagos",
                         destination_name="Apapa Port"),
                LegDraft(sequence=2, mode="SEA", origin_name="Apapa Port",
                         destination_name="Tema Port"),
            ),
        ),
    )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT sequence, mode, state, metadata FROM shipment_legs"
            " WHERE shipment_id = %s ORDER BY sequence",
            (shipment.id,),
        )
        rows = await cur.fetchall()

    assert [(r["sequence"], r["mode"]) for r in rows] == [(1, "ROAD"), (2, "SEA")]
    assert all(r["state"] == "PLANNED" for r in rows)
    assert rows[0]["metadata"]["destination_name"] == "Apapa Port"


async def test_replanning_replaces_legs_rather_than_appending(
    orchestrator, repo, queue, db, reference
):
    from logistics.domain.models import LegDraft

    shipment, item = await _draft(repo, queue, reference)
    await orchestrator.apply(
        item,
        StepResult(transition=S.VALIDATED,
                   legs=(LegDraft(sequence=1, mode="ROAD"), LegDraft(sequence=2, mode="SEA"))),
    )

    nxt = await queue.claim(worker_id="test")
    await orchestrator.apply(
        nxt, StepResult(transition=S.ALLOCATED, legs=(LegDraft(sequence=1, mode="AIR"),))
    )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT sequence, mode FROM shipment_legs WHERE shipment_id = %s ORDER BY sequence",
            (shipment.id,),
        )
        rows = await cur.fetchall()
    assert [(r["sequence"], r["mode"]) for r in rows] == [(1, "AIR")]


async def test_cannot_replan_a_leg_that_is_already_committed(
    orchestrator, repo, queue, db, reference
):
    """Deleting a leg a truck is driving would lose the booking it carries."""
    from logistics.domain.models import LegDraft

    shipment, item = await _draft(repo, queue, reference)
    await orchestrator.apply(
        item, StepResult(transition=S.VALIDATED, legs=(LegDraft(sequence=1, mode="ROAD"),))
    )
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE shipment_legs SET state = 'IN_TRANSIT' WHERE shipment_id = %s",
            (shipment.id,),
        )

    nxt = await queue.claim(worker_id="test")
    with pytest.raises(OrchestratorError, match="cannot re-plan"):
        await orchestrator.apply(
            nxt, StepResult(transition=S.ALLOCATED, legs=(LegDraft(sequence=1, mode="AIR"),))
        )


def test_leg_cost_requires_a_currency():
    from logistics.domain.models import LegDraft

    with pytest.raises(ValueError, match="no currency"):
        LegDraft(sequence=1, mode="ROAD", cost_minor=100)


async def test_events_survive_across_two_steps(orchestrator, repo, queue, db, reference):
    shipment, item = await _draft(repo, queue, reference)
    await orchestrator.apply(item, StepResult(transition=S.VALIDATED))

    nxt = await queue.claim(worker_id="test")
    await orchestrator.apply(nxt, StepResult(transition=S.ALLOCATED))

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT seq FROM shipment_events WHERE shipment_id = %s ORDER BY seq",
            (shipment.id,),
        )
        seqs = [r["seq"] for r in await cur.fetchall()]
    assert seqs == [1, 2, 3], "seq must stay gapless across steps"
