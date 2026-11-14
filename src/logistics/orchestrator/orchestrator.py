"""The orchestrator.

Its whole job is to apply a handler's StepResult atomically: validate the
transition, append the events, update the shipment, schedule what comes next,
and close the work item — in one transaction, so a crash anywhere leaves the
shipment either fully advanced or untouched, never half-way.

Handlers do not write to shipments, shipment_events, or work_items themselves.
They return a description of what should happen and this applies it. That is
what makes every step replayable and every transition auditable.
"""

from __future__ import annotations

from typing import Any, Final
from uuid import UUID

from psycopg.types.json import Jsonb

from logistics.config import Settings, get_settings
from logistics.db import Database
from logistics.domain.events import EventDraft, EventType
from logistics.domain.models import (
    LegDraft,
    Shipment,
    StepResult,
    WorkItem,
    WorkRequest,
)
from logistics.domain.states import assert_transition, is_terminal
from logistics.obs import get_logger
from logistics.orchestrator.queue import WorkQueue
from logistics.orchestrator.routing import next_step
from logistics.shipments import ShipmentRepo

log = get_logger(__name__)

# Columns a handler may patch, and which of them are JSONB. Whitelisted rather
# than interpolated, so a handler cannot reach columns it has no business in.
_JSONB_COLUMNS: Final[frozenset[str]] = frozenset(
    {"origin", "destination", "cargo", "allocation", "plan", "booking"}
)
_PATCHABLE: Final[frozenset[str]] = _JSONB_COLUMNS | {"deadline", "customer_ref"}


class OrchestratorError(Exception):
    pass


class UnknownShipment(OrchestratorError):
    pass


class ConcurrentModification(OrchestratorError):
    pass


class Orchestrator:
    def __init__(
        self,
        db: Database,
        queue: WorkQueue,
        repo: ShipmentRepo,
        settings: Settings | None = None,
    ) -> None:
        self._db = db
        self._queue = queue
        self._repo = repo
        self._settings = settings or get_settings()

    # ---------------------------------------------------------------- kick
    async def start(self, shipment_id: UUID) -> UUID | None:
        """Schedule the step a shipment's current state calls for.

        Idempotent: the dedupe key means calling it twice schedules once.
        """
        shipment = await self._repo.get(shipment_id)
        if shipment is None:
            raise UnknownShipment(str(shipment_id))
        return await self._schedule_route(shipment)

    async def _schedule_route(
        self, shipment: Shipment, *, conn: Any = None
    ) -> UUID | None:
        if is_terminal(shipment.state):
            return None
        kind = next_step(shipment.state)
        if kind is None:
            return None
        return await self._queue.enqueue(
            WorkRequest(
                kind=kind,
                shipment_id=shipment.id,
                dedupe_key=f"route:{shipment.id}:{shipment.state}:{shipment.version}",
            ),
            conn=conn,
        )

    # --------------------------------------------------------------- apply
    async def apply(self, item: WorkItem, result: StepResult) -> Shipment | None:
        async with self._db.transaction() as conn:
            shipment: Shipment | None = None

            if item.shipment_id is not None:
                # FOR UPDATE serialises concurrent steps on this shipment, which
                # is what makes MAX(seq)+1 below safe without a sequence table.
                shipment = await self._repo.lock(conn, item.shipment_id)
                if shipment is None:
                    raise UnknownShipment(str(item.shipment_id))

            events = list(result.events)
            updated = shipment

            if shipment is not None:
                if result.transition is not None:
                    assert_transition(shipment.state, result.transition)
                    events.append(
                        EventDraft(
                            type=EventType.STATE_CHANGED,
                            from_state=shipment.state,
                            to_state=result.transition,
                            payload={"via": item.kind},
                            actor=f"step:{item.kind}",
                        )
                    )

                if result.transition is not None or result.patch:
                    updated = await self._persist(conn, shipment, result)

                if result.legs:
                    await self._persist_legs(conn, shipment.id, result.legs)

                if events:
                    await self._append_events(conn, shipment.id, item.id, events)

            for request in result.enqueue:
                await self._queue.enqueue(request, conn=conn)

            # Auto-advance. Handlers signal intent by transitioning; they do not
            # enqueue the standard next step themselves. Explicit enqueues are
            # for timers and side quests only.
            if updated is not None and result.transition is not None:
                await self._schedule_route(updated, conn=conn)

            await self._queue.complete(item.id, conn=conn)

        if result.transition is not None:
            log.info(
                "shipment.transitioned",
                shipment_id=str(item.shipment_id),
                from_state=str(shipment.state) if shipment else None,
                to_state=str(result.transition),
                via=item.kind,
            )
        return updated

    # ------------------------------------------------------------ internals
    async def _persist(
        self, conn: Any, shipment: Shipment, result: StepResult
    ) -> Shipment:
        sets: list[str] = ["version = version + 1"]
        params: list[Any] = []

        if result.transition is not None:
            sets.append("state = %s")
            params.append(str(result.transition))

        for column, value in result.patch.items():
            if column not in _PATCHABLE:
                raise OrchestratorError(
                    f"handler tried to patch non-patchable column {column!r}"
                )
            sets.append(f"{column} = %s")
            params.append(Jsonb(value) if column in _JSONB_COLUMNS else value)

        params.extend([shipment.id, shipment.version])
        cur = await conn.execute(
            f"UPDATE shipments SET {', '.join(sets)}"  # noqa: S608 - whitelisted
            " WHERE id = %s AND version = %s"
            " RETURNING id, reference, state, version, customer_ref, origin,"
            " destination, cargo, deadline, allocation, plan, booking",
            params,
        )
        row = await cur.fetchone()
        if row is None:
            raise ConcurrentModification(
                f"shipment {shipment.id} changed under version {shipment.version}"
            )
        from logistics.shipments import row_to_shipment

        return row_to_shipment(row)

    async def _persist_legs(
        self, conn: Any, shipment_id: UUID, legs: tuple[LegDraft, ...]
    ) -> None:
        """Replace the shipment's legs.

        Replace rather than append: re-planning after an exception must not
        leave the old itinerary alongside the new one. Legs already under way
        are refused, because deleting a leg a truck is driving would lose the
        booking it carries.
        """
        cur = await conn.execute(
            "SELECT sequence, state FROM shipment_legs"
            " WHERE shipment_id = %s AND state <> 'PLANNED'",
            (shipment_id,),
        )
        committed = await cur.fetchall()
        if committed:
            detail = ", ".join(f"leg {r['sequence']} is {r['state']}" for r in committed)
            raise OrchestratorError(
                f"cannot re-plan shipment {shipment_id}: {detail}. "
                "Cancel the committed legs first."
            )

        await conn.execute("DELETE FROM shipment_legs WHERE shipment_id = %s", (shipment_id,))

        for leg in legs:
            metadata = dict(leg.metadata)
            # Names travel until a resolver turns them into location rows.
            if leg.origin_name:
                metadata.setdefault("origin_name", leg.origin_name)
            if leg.destination_name:
                metadata.setdefault("destination_name", leg.destination_name)

            await conn.execute(
                """
                INSERT INTO shipment_legs
                    (shipment_id, sequence, mode, state, origin_id, destination_id,
                     planned_departure, planned_arrival, distance_km,
                     cost_minor, currency, load_type, co2e_kg, metadata)
                VALUES (%s, %s, %s, 'PLANNED', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    shipment_id,
                    leg.sequence,
                    leg.mode,
                    leg.origin_id,
                    leg.destination_id,
                    leg.planned_departure,
                    leg.planned_arrival,
                    leg.distance_km,
                    leg.cost_minor,
                    leg.currency,
                    leg.load_type,
                    leg.co2e_kg,
                    Jsonb(metadata),
                ),
            )

    async def _append_events(
        self, conn: Any, shipment_id: UUID, work_item_id: UUID, events: list[EventDraft]
    ) -> None:
        cur = await conn.execute(
            "SELECT COALESCE(MAX(seq), 0) AS seq FROM shipment_events WHERE shipment_id = %s",
            (shipment_id,),
        )
        row = await cur.fetchone()
        seq = (row["seq"] if row else 0) + 1

        for event in events:
            await conn.execute(
                """
                INSERT INTO shipment_events
                    (shipment_id, seq, type, from_state, to_state, payload, actor, work_item_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    shipment_id,
                    seq,
                    str(event.type),
                    str(event.from_state) if event.from_state else None,
                    str(event.to_state) if event.to_state else None,
                    Jsonb(event.payload),
                    event.actor,
                    work_item_id,
                ),
            )
            seq += 1
