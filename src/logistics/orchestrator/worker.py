"""The worker loop.

Claim an item, run its handler, hand the result to the orchestrator. Concurrency
is N independent loops against one queue — SKIP LOCKED means they never collide
on the same item, so no coordination is needed between them.

A separate reclaimer returns items whose worker died. Without it a process kill
mid-step strands a shipment permanently.
"""

from __future__ import annotations

import asyncio
import contextlib
import traceback

from logistics.config import Settings, get_settings
from logistics.db import Database, use_org
from logistics.domain.models import WorkItem
from logistics.handlers.base import HandlerRegistry, PermanentFailure, StepContext
from logistics.llm.base import InvalidOutput, LLMClient
from logistics.obs import get_logger
from logistics.orchestrator.orchestrator import Orchestrator
from logistics.orchestrator.policy import PolicyEngine
from logistics.orchestrator.queue import WorkQueue
from logistics.shipments import ShipmentRepo

log = get_logger(__name__)


class Worker:
    def __init__(
        self,
        *,
        db: Database,
        queue: WorkQueue,
        orchestrator: Orchestrator,
        repo: ShipmentRepo,
        registry: HandlerRegistry,
        llm: LLMClient | None = None,
        policy: PolicyEngine | None = None,
        telegram: object = None,
        settings: Settings | None = None,
    ) -> None:
        self._db = db
        self._queue = queue
        self._orchestrator = orchestrator
        self._repo = repo
        self._registry = registry
        self._llm = llm
        self._policy = policy
        self._telegram = telegram
        self._settings = settings or get_settings()
        self._processed = 0

    @property
    def processed(self) -> int:
        return self._processed

    # ----------------------------------------------------------------- run
    async def run(self, stop: asyncio.Event | None = None) -> None:
        stop = stop or asyncio.Event()
        n = self._settings.worker_concurrency
        log.info(
            "worker.start",
            worker_id=self._settings.worker_id,
            concurrency=n,
            kinds=self._registry.kinds,
        )
        tasks = [asyncio.create_task(self._loop(i, stop)) for i in range(n)]
        tasks.append(asyncio.create_task(self._reclaimer(stop)))
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            log.info("worker.stopped", processed=self._processed)

    async def _loop(self, slot: int, stop: asyncio.Event) -> None:
        idle = self._settings.worker_poll_interval_s
        while not stop.is_set():
            try:
                did_work = await self.process_one()
            except Exception:  # noqa: BLE001 - a loop must never die silently
                log.error("worker.loop_error", slot=slot, error=traceback.format_exc())
                did_work = False

            if did_work:
                idle = self._settings.worker_poll_interval_s
                continue

            # Back off when the queue is empty so an idle system is not
            # hammering Postgres once a second per slot.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=idle)
            idle = min(idle * 1.5, self._settings.worker_idle_backoff_s)

    async def _reclaimer(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(
                    stop.wait(), timeout=self._settings.worker_reclaim_interval_s
                )
            if stop.is_set():
                return
            try:
                if n := await self._queue.reclaim_expired():
                    log.warning("worker.reclaimed", count=n)
            except Exception:  # noqa: BLE001
                log.error("worker.reclaim_error", error=traceback.format_exc())

    # ------------------------------------------------------------ one step
    async def process_one(self) -> bool:
        """Claim and run a single item. Returns False when the queue is empty."""
        item = await self._queue.claim()
        if item is None:
            return False

        # The claim looked across every organisation; everything from here runs
        # scoped to the one that owns this item. Handlers therefore need no
        # tenancy code of their own — and a handler that tried to reach another
        # org's data would find it simply absent.
        with use_org(item.org_id):
            return await self._run(item)

    async def _run(self, item: WorkItem) -> bool:
        bound = log.bind(
            kind=item.kind, item_id=str(item.id), attempt=item.attempts,
            shipment_id=str(item.shipment_id) if item.shipment_id else None,
        )
        handler = self._registry.get(item.kind)
        if handler is None:
            # Not retryable: no amount of waiting registers a handler.
            await self._queue.fail(
                _exhaust(item), f"no handler registered for kind {item.kind!r}"
            )
            bound.error("step.no_handler")
            return True

        shipment = (
            await self._repo.get(item.shipment_id) if item.shipment_id is not None else None
        )
        ctx = StepContext(
            item=item,
            shipment=shipment,
            db=self._db,
            settings=self._settings,
            llm=self._llm,
            policy=self._policy,
            telegram=self._telegram,
        )

        heartbeat = asyncio.create_task(self._heartbeat(item))
        try:
            result = await handler(ctx)
        except PermanentFailure as exc:
            await self._queue.fail(_exhaust(item), f"permanent: {exc}")
            bound.error("step.permanent_failure", error=str(exc))
            return True
        except InvalidOutput as exc:
            # The model missed the schema after every retry. Expected with
            # open-weight models — this belongs to a human, not the retry loop.
            await self._queue.fail(_exhaust(item), f"invalid model output: {exc}")
            bound.error("step.invalid_output", attempts=exc.attempts)
            return True
        except Exception as exc:  # noqa: BLE001
            await self._queue.fail(item, f"{type(exc).__name__}: {exc}")
            bound.warning("step.failed", error=str(exc), trace=traceback.format_exc())
            return True
        finally:
            heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat

        try:
            await self._orchestrator.apply(item, result)
        except Exception as exc:  # noqa: BLE001
            # The handler succeeded but its result would not apply — an illegal
            # transition, a bad patch. Retrying re-runs the handler, which is
            # safe because handlers do not mutate core state.
            await self._queue.fail(item, f"apply failed: {type(exc).__name__}: {exc}")
            bound.error("step.apply_failed", error=str(exc))
            return True

        self._processed += 1
        bound.info("step.done", transition=str(result.transition) if result.transition else None)
        return True

    async def _heartbeat(self, item: WorkItem) -> None:
        """Extend the lease while a slow handler runs, so the reclaimer does not
        take an item that is still being worked."""
        interval = max(5.0, self._settings.worker_lease_s / 3)
        while True:
            await asyncio.sleep(interval)
            with contextlib.suppress(Exception):
                await self._queue.extend_lease(item.id)


def _exhaust(item: WorkItem) -> WorkItem:
    """A copy at its attempt ceiling, so `fail` marks it DEAD immediately."""
    from dataclasses import replace

    return replace(item, attempts=item.max_attempts)
