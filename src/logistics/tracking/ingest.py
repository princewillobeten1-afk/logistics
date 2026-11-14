"""Tracking ingestion.

The hot path. Every position update in the system passes through here, so it
does exactly three things and none of them involve a model:

  1. Append the raw event.
  2. Compute progress and run the detection rules.
  3. Record findings, and enqueue a step when one is worth acting on.

State transitions are *not* done here. Ingestion enqueues work and the
orchestrator transitions, so shipment state still moves in exactly one place.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from logistics.db import Database
from logistics.domain.models import WorkRequest
from logistics.domain.states import ShipmentState
from logistics.exceptions import ExceptionRepo
from logistics.geo import Coordinates
from logistics.obs import get_logger
from logistics.orchestrator.queue import WorkQueue
from logistics.tracking.detection import (
    Detection,
    DetectionKind,
    Thresholds,
    actionable,
    detect_on_event,
)
from logistics.tracking.eta import DEFAULT_SPEED_KPH, Progress, estimate_progress
from logistics.tracking.events import TrackingEvent, TrackingEventType

log = get_logger(__name__)

# How many recent pings feed the speed estimate. Long enough to smooth traffic,
# short enough to react to a breakdown.
SPEED_WINDOW = 12

# A vehicle under this speed is treated as stopped for dwell purposes.
STOPPED_KPH = 5.0


@dataclass(frozen=True, slots=True)
class IngestResult:
    event_recorded: bool
    progress: Progress | None
    detections: list[Detection]
    raised: list[str]
    """Kinds that produced a new exception row (not already open)."""
    cleared: list[str]
    escalated: bool


class TrackingIngestor:
    def __init__(
        self,
        db: Database,
        queue: WorkQueue,
        *,
        thresholds: Thresholds | None = None,
    ) -> None:
        self._db = db
        self._queue = queue
        self._exceptions = ExceptionRepo(db)
        self._thresholds = thresholds or Thresholds()

    async def ingest(self, event: TrackingEvent) -> IngestResult:
        context = await self._context(event.shipment_id)
        if context is None:
            log.warning("tracking.unknown_shipment", shipment_id=str(event.shipment_id))
            return IngestResult(False, None, [], [], [], False)

        await self._record(event)

        progress = self._progress(event, context)
        detections: list[Detection] = []

        if progress is not None:
            detections = detect_on_event(
                progress=progress,
                now=event.occurred_at,
                planned_arrival=context.get("planned_arrival"),
                deadline=context.get("deadline"),
                stationary_since=await self._stationary_since(event),
                temperature_c=event.temperature_c,
                temp_min_c=context.get("temp_min_c"),
                temp_max_c=context.get("temp_max_c"),
                thresholds=self._thresholds,
            )

        raised = []
        for detection in detections:
            created = await self._exceptions.raise_detection(
                shipment_id=event.shipment_id,
                detection=detection,
                leg_id=event.leg_id,
            )
            if created:
                raised.append(str(detection.kind))

        # A condition that has cleared should close its finding. Without this,
        # a truck that rejoins its route stays flagged forever.
        cleared = await self._clear_resolved(event.shipment_id, detections)

        escalated = False
        if worth := actionable(detections):
            escalated = await self._escalate(event, worth, context)

        if event.event_type is TrackingEventType.DEPARTED:
            await self._enqueue(event.shipment_id, "tracking.mark_in_transit", event)
        elif event.event_type is TrackingEventType.DELIVERED:
            await self._enqueue(event.shipment_id, "tracking.mark_delivered", event)

        return IngestResult(
            event_recorded=True,
            progress=progress,
            detections=detections,
            raised=raised,
            cleared=cleared,
            escalated=escalated,
        )

    # ----------------------------------------------------------- internals

    async def _record(self, event: TrackingEvent) -> None:
        async with self._db.connection() as conn:
            await conn.execute(
                """
                INSERT INTO tracking_events
                    (shipment_id, leg_id, occurred_at, source, event_type,
                     latitude, longitude, speed_kph, heading_deg, temperature_c, payload)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    event.shipment_id,
                    event.leg_id,
                    event.occurred_at,
                    str(event.source),
                    str(event.event_type),
                    event.latitude,
                    event.longitude,
                    event.speed_kph,
                    event.heading_deg,
                    event.temperature_c,
                    Jsonb(event.payload),
                ),
            )

    async def _context(self, shipment_id: UUID) -> dict[str, Any] | None:
        """Everything detection needs, in one round trip."""
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                SELECT s.state, s.deadline, s.origin, s.destination, s.plan,
                       p.temp_min_c, p.temp_max_c
                  FROM shipments s
             LEFT JOIN products p ON p.sku = s.cargo->>'sku'
                 WHERE s.id = %s
                """,
                (shipment_id,),
            )
            row = await cur.fetchone()
            if row is None:
                return None

            cur = await conn.execute(
                "SELECT speed_kph FROM tracking_events"
                " WHERE shipment_id = %s AND speed_kph IS NOT NULL"
                " ORDER BY occurred_at DESC LIMIT %s",
                (shipment_id, SPEED_WINDOW),
            )
            speeds = [float(r["speed_kph"]) for r in await cur.fetchall()]

        plan = row["plan"] or {}
        planned_arrival = None
        if raw := plan.get("projected_delivery"):
            try:
                planned_arrival = datetime.fromisoformat(raw)
            except ValueError:
                planned_arrival = None

        return {
            "state": ShipmentState(row["state"]),
            "deadline": _aware(row["deadline"]),
            "origin": _coords(row["origin"]),
            "destination": _coords(row["destination"]),
            "planned_arrival": _aware(planned_arrival),
            "observed_speeds": speeds,
            "temp_min_c": _f(row["temp_min_c"]),
            "temp_max_c": _f(row["temp_max_c"]),
        }

    def _progress(
        self, event: TrackingEvent, context: dict[str, Any]
    ) -> Progress | None:
        position = event.position
        origin = context.get("origin")
        destination = context.get("destination")
        if position is None or origin is None or destination is None:
            # Position-free events (a scan, a carrier status push) still get
            # recorded; there is simply nothing geometric to compute.
            return None

        # Context is read before the event is stored, so the incoming sample
        # is not in the history yet. It is also the freshest signal there is —
        # on a shipment's first ping it is the only one — so it leads.
        speeds = list(context.get("observed_speeds") or [])
        if event.speed_kph is not None:
            speeds.insert(0, float(event.speed_kph))

        return estimate_progress(
            position=position,
            origin=origin,
            destination=destination,
            at=event.occurred_at,
            observed_speeds=speeds,
            speed_fallback=DEFAULT_SPEED_KPH,
        )

    async def _stationary_since(self, event: TrackingEvent) -> datetime | None:
        """When the vehicle last moved. None if it is moving now."""
        if event.speed_kph is None or event.speed_kph >= STOPPED_KPH:
            return None

        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                SELECT max(occurred_at) AS moved_at
                  FROM tracking_events
                 WHERE shipment_id = %s AND speed_kph >= %s
                   AND occurred_at <= %s
                """,
                (event.shipment_id, STOPPED_KPH, event.occurred_at),
            )
            row = await cur.fetchone()
        return _aware(row["moved_at"]) if row and row["moved_at"] else None

    async def _clear_resolved(
        self, shipment_id: UUID, detections: list[Detection]
    ) -> list[str]:
        """Close findings whose condition no longer holds.

        Only the self-correcting kinds. An SLA breach risk or a temperature
        excursion does not un-happen because the next ping looks fine.
        """
        self_correcting = {DetectionKind.ROUTE_DEVIATION, DetectionKind.DWELL}
        still_firing = {d.kind for d in detections}
        cleared = []
        for kind in self_correcting - still_firing:
            n = await self._exceptions.resolve_kind(
                shipment_id, str(kind), resolution="condition cleared"
            )
            if n:
                cleared.append(str(kind))
        return cleared

    async def _escalate(
        self, event: TrackingEvent, detections: list[Detection], context: dict[str, Any]
    ) -> bool:
        if context["state"] not in (ShipmentState.IN_TRANSIT, ShipmentState.BOOKED):
            return False

        worst = detections[0]
        # Keyed on kind, not on time: a shipment already escalated for this
        # condition must not re-enqueue on every subsequent ping.
        request = WorkRequest(
            kind="tracking.raise_exception",
            shipment_id=event.shipment_id,
            payload={
                "kinds": [str(d.kind) for d in detections],
                "severity": str(worst.severity),
                "summary": worst.summary,
                "detected_at": event.occurred_at.isoformat(),
            },
            dedupe_key=f"exception:{event.shipment_id}:{worst.kind}",
            priority=10,
        )
        return await self._queue.enqueue(request) is not None

    async def _enqueue(
        self, shipment_id: UUID, kind: str, event: TrackingEvent
    ) -> None:
        await self._queue.enqueue(
            WorkRequest(
                kind=kind,
                shipment_id=shipment_id,
                payload={"occurred_at": event.occurred_at.isoformat()},
                dedupe_key=f"{kind}:{shipment_id}",
                priority=20,
            )
        )


def _coords(location: dict[str, Any] | None) -> Coordinates | None:
    if not location:
        return None
    lat, lon = location.get("latitude"), location.get("longitude")
    if lat is None or lon is None:
        return None
    return (float(lat), float(lon))


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _f(value: Any) -> float | None:
    return None if value is None else float(value)
