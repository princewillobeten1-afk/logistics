from __future__ import annotations

import asyncio

from logistics.domain.models import WorkRequest

pytest_plugins = ()


async def test_enqueue_and_claim(queue):
    item_id = await queue.enqueue(WorkRequest(kind="demo.step", payload={"n": 1}))
    assert item_id is not None

    item = await queue.claim(worker_id="w1")
    assert item is not None
    assert item.kind == "demo.step"
    assert item.payload == {"n": 1}
    assert item.attempts == 1


async def test_claim_returns_none_when_empty(queue):
    assert await queue.claim(worker_id="w1") is None


async def test_dedupe_key_prevents_double_scheduling(queue):
    first = await queue.enqueue(WorkRequest(kind="demo.step", dedupe_key="same"))
    second = await queue.enqueue(WorkRequest(kind="demo.step", dedupe_key="same"))
    assert first is not None
    assert second is None, "a colliding dedupe key must not create a second item"


async def test_two_workers_never_claim_the_same_item(queue):
    """SKIP LOCKED is the whole reason workers need no coordination."""
    for i in range(6):
        await queue.enqueue(WorkRequest(kind="demo.step", payload={"n": i}))

    claims = await asyncio.gather(*(queue.claim(worker_id=f"w{i}") for i in range(6)))
    ids = [c.id for c in claims if c is not None]
    assert len(ids) == 6
    assert len(set(ids)) == 6, "an item was handed to two workers"


async def test_run_after_defers_a_timer(queue):
    from datetime import UTC, datetime, timedelta

    await queue.enqueue(
        WorkRequest(
            kind="carrier.close_window",
            run_after=datetime.now(UTC) + timedelta(hours=1),
        )
    )
    assert await queue.claim(worker_id="w1") is None, "a future item must not be claimable"


async def test_failure_retries_then_dies(queue):
    await queue.enqueue(WorkRequest(kind="demo.step", max_attempts=2))

    first = await queue.claim(worker_id="w1")
    assert await queue.fail(first, "boom") is True

    # Backoff is tiny in test settings, so it becomes claimable again.
    await asyncio.sleep(0.1)
    second = await queue.claim(worker_id="w1")
    assert second is not None
    assert second.attempts == 2
    assert await queue.fail(second, "boom again") is False

    assert (await queue.stats()).get("DEAD") == 1


async def test_expired_lease_is_reclaimed(queue):
    """A worker killed mid-step must not strand the shipment."""
    await queue.enqueue(WorkRequest(kind="demo.step"))
    claimed = await queue.claim(worker_id="doomed", lease_s=-1)  # already expired
    assert claimed is not None
    assert await queue.claim(worker_id="w2") is None, "still RUNNING, not claimable"

    assert await queue.reclaim_expired() == 1
    assert (await queue.claim(worker_id="w2")) is not None


async def test_reclaim_kills_items_past_their_attempt_ceiling(queue):
    await queue.enqueue(WorkRequest(kind="demo.step", max_attempts=1))
    await queue.claim(worker_id="doomed", lease_s=-1)
    await queue.reclaim_expired()
    assert (await queue.stats()).get("DEAD") == 1


async def test_extend_lease_protects_a_slow_handler(queue):
    await queue.enqueue(WorkRequest(kind="demo.step"))
    item = await queue.claim(worker_id="w1", lease_s=-1)
    await queue.extend_lease(item.id, lease_s=600)
    assert await queue.reclaim_expired() == 0, "an extended lease must survive the reclaimer"


async def test_completed_item_is_not_reclaimed(queue):
    await queue.enqueue(WorkRequest(kind="demo.step"))
    item = await queue.claim(worker_id="w1", lease_s=-1)
    await queue.complete(item.id)
    assert await queue.reclaim_expired() == 0
