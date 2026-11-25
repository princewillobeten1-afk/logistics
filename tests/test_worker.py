"""End-to-end: a shipment walks the spine under the real worker."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from logistics.domain.models import StepResult, WorkRequest
from logistics.domain.states import ShipmentState
from logistics.handlers import registry as real_registry
from logistics.handlers.allocate import set_inventory_source
from logistics.handlers.base import HandlerRegistry, PermanentFailure
from logistics.inventory import InMemoryInventory
from logistics.llm.registry import Job
from logistics.orchestrator.worker import Worker
from tests.conftest import ScriptedLLM

S = ShipmentState
CLEAN = '{"ready_to_ship": true, "issues": [], "confidence": 0.95}'
ROUTE_ADVISORY = (
    '{"waypoints": ["Lagos", "Ibadan", "Ilorin", "Lokoja", "Abuja"],'
    ' "risk_level": "low", "corridor_notes": "Clear highway corridor"}'
)


def _worker(db, queue, orchestrator, repo, settings, registry, llm=None) -> Worker:  # noqa: ANN001
    return Worker(
        db=db, queue=queue, orchestrator=orchestrator, repo=repo,
        registry=registry, llm=llm, settings=settings,
    )


async def _drain(worker: Worker, limit: int = 20) -> int:
    steps = 0
    while steps < limit and await worker.process_one():
        steps += 1
    return steps


async def test_shipment_walks_from_draft_to_sourcing(
    db, queue, orchestrator, repo, settings, reference, carriers
):
    """DRAFT → VALIDATED → ALLOCATED → PLANNED → SOURCING.

    Only `order.validate` and `planning.plan` (cuOpt + Nemotron route advisory)
    should call the model; allocation and sourcing remain deterministic.
    """
    set_inventory_source(InMemoryInventory())
    shipment = await repo.create(
        reference=reference,
        origin={"warehouse": "Lagos", "city": "Lagos"},
        destination={"city": "Abuja", "address": "12 Ahmadu Bello Way, Garki"},
        cargo={"quantity": 100, "weight_kg": 1800},
        deadline=datetime.now(UTC) + timedelta(days=4),
    )
    await orchestrator.start(shipment.id)

    llm = ScriptedLLM(CLEAN, ROUTE_ADVISORY)
    worker = _worker(db, queue, orchestrator, repo, settings, real_registry, llm)
    await _drain(worker)

    final = await repo.get(shipment.id)
    assert final.state is S.SOURCING
    assert final.allocation["lines"] == [{"warehouse": "Lagos", "quantity": 100}]
    assert final.plan["modes"] == ["ROAD"]
    assert final.plan["international"] is False
    assert final.plan["distance_km"] == 750
    assert [r.job for r in llm.requests] == [
        Job.ORDER_EXTRACTION,
        Job.ROUTE_OPTIMIZATION,
    ], "only order.validate and planning.plan should call the model"

    # Planning must have written the leg, not just the summary.
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT sequence, mode, state FROM shipment_legs"
            " WHERE shipment_id = %s ORDER BY sequence",
            (shipment.id,),
        )
        legs = await cur.fetchall()
    assert [(r["sequence"], r["mode"], r["state"]) for r in legs] == [(1, "ROAD", "PLANNED")]

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT type FROM shipment_events WHERE shipment_id = %s ORDER BY seq",
            (shipment.id,),
        )
        types = [r["type"] for r in await cur.fetchall()]

    assert types.count("shipment.state_changed") == 4
    assert "warehouse.allocation_reserved" in types
    assert "planning.estimated" in types


async def test_sourcing_waits_and_leaves_a_timer(
    db, queue, orchestrator, repo, settings, reference, carriers
):
    """SOURCING is a genuine wait — but the window must not be waited on forever."""
    set_inventory_source(InMemoryInventory())
    shipment = await repo.create(
        reference=reference,
        origin={"warehouse": "Lagos", "city": "Lagos"},
        destination={"city": "Abuja", "address": "12 Ahmadu Bello Way"},
        cargo={"quantity": 100, "weight_kg": 1800},
    )
    await orchestrator.start(shipment.id)
    await _drain(_worker(db, queue, orchestrator, repo, settings, real_registry,
                         ScriptedLLM(CLEAN, ROUTE_ADVISORY)))

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT kind, state, run_after > now() AS future FROM work_items"
            " WHERE shipment_id = %s AND state = 'PENDING'",
            (shipment.id,),
        )
        pending = await cur.fetchall()

    assert len(pending) == 1
    assert pending[0]["kind"] == "carrier.close_window"
    assert pending[0]["future"] is True, "the window timer must be scheduled ahead"


async def test_incomplete_address_stops_at_needs_info(
    db, queue, orchestrator, repo, settings, reference
):
    shipment = await repo.create(
        reference=reference,
        origin={"warehouse": "Lagos"},
        destination={},  # the §4 case
        cargo={"quantity": 100, "weight_kg": 1800},
    )
    await orchestrator.start(shipment.id)
    await _drain(_worker(db, queue, orchestrator, repo, settings, real_registry,
                         ScriptedLLM(CLEAN, ROUTE_ADVISORY)))

    final = await repo.get(shipment.id)
    assert final.state is S.NEEDS_INFO
    assert await queue.claim(worker_id="t") is None, "must wait, not spin"


async def test_unknown_kind_dies_without_burning_retries(
    db, queue, orchestrator, repo, settings, reference
):
    await queue.enqueue(WorkRequest(kind="does.not.exist", max_attempts=5))
    worker = _worker(db, queue, orchestrator, repo, settings, HandlerRegistry())
    assert await worker.process_one() is True

    stats = await queue.stats()
    assert stats.get("DEAD") == 1, "a missing handler is not retryable"


async def test_handler_exception_is_retried(db, queue, orchestrator, repo, settings, reference):
    registry = HandlerRegistry()
    calls = 0

    @registry.register("flaky.step")
    async def flaky(ctx):  # noqa: ANN001, ANN202
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("carrier API timed out")
        return StepResult()

    await queue.enqueue(WorkRequest(kind="flaky.step", max_attempts=3))
    worker = _worker(db, queue, orchestrator, repo, settings, registry)

    await worker.process_one()
    assert calls == 1
    await asyncio.sleep(0.1)  # tiny backoff in test settings
    await worker.process_one()

    assert calls == 2
    assert (await queue.stats()).get("DONE") == 1


async def test_permanent_failure_skips_the_retry_budget(
    db, queue, orchestrator, repo, settings
):
    registry = HandlerRegistry()

    @registry.register("bad.step")
    async def bad(ctx):  # noqa: ANN001, ANN202
        raise PermanentFailure("payload is malformed")

    await queue.enqueue(WorkRequest(kind="bad.step", max_attempts=5))
    worker = _worker(db, queue, orchestrator, repo, settings, registry)
    await worker.process_one()

    assert (await queue.stats()).get("DEAD") == 1


async def test_invalid_model_output_goes_to_a_human_not_a_retry_loop(
    db, queue, orchestrator, repo, settings
):
    from logistics.llm.base import InvalidOutput

    registry = HandlerRegistry()

    @registry.register("schema.step")
    async def step(ctx):  # noqa: ANN001, ANN202
        raise InvalidOutput("did not validate", attempts=3)

    await queue.enqueue(WorkRequest(kind="schema.step", max_attempts=5))
    worker = _worker(db, queue, orchestrator, repo, settings, registry)
    await worker.process_one()

    async with db.connection() as conn:
        cur = await conn.execute("SELECT state, last_error FROM work_items LIMIT 1")
        row = await cur.fetchone()
    assert row["state"] == "DEAD"
    assert "invalid model output" in row["last_error"]


async def test_worker_run_stops_cleanly(db, queue, orchestrator, repo, settings):
    worker = _worker(db, queue, orchestrator, repo, settings, HandlerRegistry())
    stop = asyncio.Event()
    task = asyncio.create_task(worker.run(stop))
    await asyncio.sleep(0.15)
    stop.set()
    await asyncio.wait_for(task, timeout=5)
