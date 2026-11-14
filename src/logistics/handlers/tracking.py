"""Tracking-driven steps.

Ingestion detects; these apply the consequence to shipment state. Keeping the
transition here rather than in the ingestor means state still moves in exactly
one place, and every move is validated against the lifecycle table.

None of these calls a model.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from logistics.domain.events import EventDraft
from logistics.domain.models import StepResult, WorkRequest
from logistics.domain.states import ShipmentState
from logistics.handlers.base import StepContext, handler

# How often the absence sweep runs. Frequent enough to notice a silent truck
# within the hour, cheap enough to be free — it is one indexed query.
SWEEP_INTERVAL = timedelta(minutes=15)


@handler("tracking.mark_in_transit")
async def mark_in_transit(ctx: StepContext) -> StepResult:
    shipment = ctx.require_shipment()
    if shipment.state is not ShipmentState.BOOKED:
        # A late or duplicated DEPARTED event. Not an error.
        ctx.log.info("tracking.depart_ignored", state=str(shipment.state))
        return StepResult()

    return StepResult(
        transition=ShipmentState.IN_TRANSIT,
        events=(
            EventDraft(
                type="tracking.departed",
                actor="tracking",
                payload={"occurred_at": ctx.item.payload.get("occurred_at")},
            ),
        ),
    )


@handler("tracking.mark_delivered")
async def mark_delivered(ctx: StepContext) -> StepResult:
    shipment = ctx.require_shipment()
    if shipment.state not in (ShipmentState.IN_TRANSIT, ShipmentState.EXCEPTION):
        ctx.log.info("tracking.delivery_ignored", state=str(shipment.state))
        return StepResult()

    return StepResult(
        transition=ShipmentState.DELIVERED,
        events=(
            EventDraft(
                type="tracking.delivered",
                actor="tracking",
                payload={"occurred_at": ctx.item.payload.get("occurred_at")},
            ),
        ),
    )


@handler("tracking.raise_exception")
async def raise_exception(ctx: StepContext) -> StepResult:
    """Move a shipment into EXCEPTION after detection fired.

    The exception rows already exist — ingestion wrote them. This is the state
    change, and it is what will later wake the Exception Agent.
    """
    shipment = ctx.require_shipment()
    payload = ctx.item.payload

    if shipment.state is ShipmentState.EXCEPTION:
        return StepResult()
    if shipment.state not in (ShipmentState.BOOKED, ShipmentState.IN_TRANSIT):
        ctx.log.info("tracking.escalation_ignored", state=str(shipment.state))
        return StepResult()

    ctx.log.warning(
        "tracking.escalated",
        severity=payload.get("severity"),
        kinds=payload.get("kinds"),
    )

    return StepResult(
        transition=ShipmentState.EXCEPTION,
        events=(
            EventDraft(
                type="tracking.exception_raised",
                actor="detector",
                payload={
                    "kinds": payload.get("kinds"),
                    "severity": payload.get("severity"),
                    "summary": payload.get("summary"),
                    # Recorded explicitly: the economics of this system depend
                    # on detection being arithmetic, and the audit trail should
                    # show that plainly.
                    "detected_by": "deterministic",
                },
            ),
        ),
    )


@handler("detection.sweep")
async def sweep(ctx: StepContext) -> StepResult:
    """Absence detection.

    Catches what no event can: a checkpoint never reached, a vehicle that
    stopped reporting. Event-driven rules are blind to silence, so this is the
    only thing standing between a truck going quiet and nobody noticing.

    Reschedules itself, so one enqueue keeps it running forever.
    """
    from logistics.exceptions import ExceptionRepo
    from logistics.tracking.detection import Thresholds, actionable, detect_stale

    thresholds = Thresholds()
    now = datetime.now(UTC)
    repo = ExceptionRepo(ctx.db)
    checked = 0
    raised = 0

    async with ctx.db.connection() as conn:
        await conn.execute("SELECT ensure_tracking_partitions(3)")

        cur = await conn.execute(
            """
            SELECT s.id, s.reference,
                   max(t.occurred_at) AS last_seen
              FROM shipments s
         LEFT JOIN tracking_events t ON t.shipment_id = s.id
             WHERE s.state IN ('BOOKED', 'IN_TRANSIT')
             GROUP BY s.id, s.reference
            """
        )
        active = await cur.fetchall()

        cur = await conn.execute(
            """
            SELECT c.shipment_id, c.name, c.expected_at, c.tolerance_minutes
              FROM checkpoints c
              JOIN shipments s ON s.id = c.shipment_id
             WHERE c.state = 'PENDING'
               AND s.state IN ('BOOKED', 'IN_TRANSIT')
               AND c.expected_at + make_interval(mins => c.tolerance_minutes) < now()
            """
        )
        overdue = await cur.fetchall()

    by_shipment: dict[str, list[tuple[str, datetime, float]]] = {}
    for row in overdue:
        by_shipment.setdefault(str(row["shipment_id"]), []).append(
            (row["name"], _aware(row["expected_at"]), float(row["tolerance_minutes"]))
        )

    follow_up: list[WorkRequest] = []

    for row in active:
        checked += 1
        detections = detect_stale(
            now=now,
            last_seen=_aware(row["last_seen"]),
            checkpoints=by_shipment.get(str(row["id"]), []),
            thresholds=thresholds,
        )
        if not detections:
            continue

        for detection in detections:
            if await repo.raise_detection(
                shipment_id=row["id"], detection=detection, detected_by="sweep"
            ):
                raised += 1

        if worth := actionable(detections):
            follow_up.append(
                WorkRequest(
                    kind="tracking.raise_exception",
                    shipment_id=row["id"],
                    payload={
                        "kinds": [str(d.kind) for d in worth],
                        "severity": str(worth[0].severity),
                        "summary": worth[0].summary,
                        "detected_at": now.isoformat(),
                    },
                    dedupe_key=f"exception:{row['id']}:{worth[0].kind}",
                    priority=10,
                )
            )

    ctx.log.info("sweep.done", checked=checked, raised=raised, escalated=len(follow_up))

    # Reschedule. The dedupe key is time-bucketed so a duplicate enqueue in the
    # same window collides instead of doubling the sweep rate.
    next_run = now + SWEEP_INTERVAL
    follow_up.append(
        WorkRequest(
            kind="detection.sweep",
            run_after=next_run,
            dedupe_key=f"sweep:{int(next_run.timestamp() // 60)}",
            priority=200,
        )
    )

    return StepResult(enqueue=tuple(follow_up))


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)
