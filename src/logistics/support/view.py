"""The customer-safe projection.

`CustomerView` is an allowlist, not a redaction — a field reaches a customer
only by being named here. That mattered when the agent could only talk; it
matters more now that it can act, because the same context drives both.

Nothing in this module calls a model. Live position and progress come from the
tracking engine's arithmetic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from logistics.db import Database
from logistics.domain.states import ShipmentState
from logistics.geo import haversine_km
from logistics.obs import get_logger
from logistics.tracking.eta import estimate_progress

log = get_logger(__name__)

# Internal state → what a customer is actually told. Several internal states
# collapse to one phrase on purpose: "we are still finding a carrier" and "a
# manager is approving the cost" are the same thing from outside — the
# shipment has not left yet.
CUSTOMER_STATUS: dict[ShipmentState, str] = {
    ShipmentState.DRAFT: "Order received",
    ShipmentState.NEEDS_INFO: "Waiting for information from you",
    ShipmentState.VALIDATED: "Being prepared",
    ShipmentState.ALLOCATED: "Being prepared",
    ShipmentState.PLANNED: "Arranging transport",
    ShipmentState.SOURCING: "Arranging transport",
    ShipmentState.AWAITING_APPROVAL: "Arranging transport",
    ShipmentState.BOOKED: "Booked — awaiting pickup",
    ShipmentState.IN_TRANSIT: "In transit",
    ShipmentState.EXCEPTION: "Delayed",
    ShipmentState.DELIVERED: "Delivered",
    ShipmentState.POD_VERIFIED: "Delivered",
    ShipmentState.CLOSED: "Delivered",
    ShipmentState.CANCELLED: "Cancelled",
    ShipmentState.FAILED: "Could not be completed",
}

# Exception kinds a customer may be told about, in their words. Anything not
# listed is a generic delay — a customer does not need to hear
# "ROUTE_DEVIATION" or that we lost GPS signal.
CUSTOMER_DELAY_REASON: dict[str, str] = {
    "SLA_BREACH_RISK": "running behind schedule",
    "ETA_DRIFT": "running behind schedule",
    "DWELL": "held up en route",
    "MISSED_CHECKPOINT": "behind its expected schedule",
    "TEMPERATURE_EXCURSION": "a temperature issue is being investigated",
}


@dataclass(frozen=True, slots=True)
class CustomerView:
    """Everything the support agent is allowed to know."""

    reference: str
    status: str
    origin: str | None = None
    destination: str | None = None
    promised_by: datetime | None = None
    estimated_arrival: datetime | None = None
    carrier: str | None = None
    delay_reason: str | None = None
    last_update: datetime | None = None
    milestones: list[str] = field(default_factory=list)
    quantity: int | None = None

    # Live tracking, when the shipment is moving and reporting.
    percent_complete: int | None = None
    distance_remaining_km: int | None = None

    def as_prompt(self) -> str:
        def when(value: datetime | None) -> str:
            return value.strftime("%a %d %b, %H:%M") if value else "not yet confirmed"

        lines = [
            f"Reference: {self.reference}",
            f"Status: {self.status}",
            f"From: {self.origin or 'not recorded'}",
            f"To: {self.destination or 'not recorded'}",
            f"Promised delivery: {when(self.promised_by)}",
            f"Current estimate: {when(self.estimated_arrival)}",
            f"Carrier: {self.carrier or 'not yet assigned'}",
        ]
        if self.quantity:
            lines.append(f"Items: {self.quantity}")
        if self.percent_complete is not None:
            lines.append(
                f"Journey progress: about {self.percent_complete}% of the way, "
                f"roughly {self.distance_remaining_km} km remaining"
            )
        if self.delay_reason:
            lines.append(f"Delay: the shipment is {self.delay_reason}")
        if self.last_update:
            lines.append(f"Last update: {when(self.last_update)}")
        if self.milestones:
            lines.append("Progress so far: " + "; ".join(self.milestones))
        return "\n".join(lines)


async def build_view(db: Database, reference: str) -> CustomerView | None:
    """Assemble the customer-safe projection for one shipment."""
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT s.id, s.reference, s.state, s.origin, s.destination,
                   s.cargo, s.deadline, s.plan, s.booking, s.updated_at
              FROM shipments s WHERE s.reference = %s
            """,
            (reference,),
        )
        row = await cur.fetchone()
        if row is None:
            return None

        # Customer-facing milestones only. Policy decisions, scoring and
        # approvals are deliberately not in this list.
        cur = await conn.execute(
            """
            SELECT type, to_state, created_at FROM shipment_events
             WHERE shipment_id = %s
               AND type IN ('shipment.created', 'shipment.state_changed',
                            'tracking.departed', 'tracking.delivered',
                            'carrier.booked')
             ORDER BY seq
            """,
            (row["id"],),
        )
        events = await cur.fetchall()

        cur = await conn.execute(
            """
            SELECT kind FROM exceptions
             WHERE shipment_id = %s AND state <> 'RESOLVED'
             ORDER BY array_position(ARRAY['CRITICAL','HIGH','MEDIUM','LOW'], severity)
             LIMIT 1
            """,
            (row["id"],),
        )
        exception = await cur.fetchone()

        cur = await conn.execute(
            """
            SELECT occurred_at, latitude, longitude, speed_kph
              FROM tracking_events
             WHERE shipment_id = %s ORDER BY occurred_at DESC LIMIT 1
            """,
            (row["id"],),
        )
        last_ping = await cur.fetchone()

    state = ShipmentState(row["state"])
    plan = row["plan"] or {}
    booking = row["booking"] or {}

    eta = None
    if raw := plan.get("projected_delivery"):
        try:
            eta = datetime.fromisoformat(raw)
        except ValueError:
            eta = None

    milestones = []
    for event in events:
        if event["type"] == "shipment.created":
            milestones.append(f"order received {event['created_at']:%d %b}")
        elif event["type"] == "carrier.booked":
            milestones.append(f"transport booked {event['created_at']:%d %b}")
        elif event["type"] == "tracking.departed":
            milestones.append(f"collected {event['created_at']:%d %b %H:%M}")
        elif event["type"] == "tracking.delivered":
            milestones.append(f"delivered {event['created_at']:%d %b %H:%M}")

    progress = _progress(row, last_ping)

    return CustomerView(
        reference=row["reference"],
        status=CUSTOMER_STATUS.get(state, "In progress"),
        origin=_place(row["origin"]),
        destination=_place(row["destination"]),
        promised_by=row["deadline"],
        # A live estimate beats the planned one once the vehicle is reporting.
        estimated_arrival=(progress or {}).get("eta") or eta,
        # The carrier's name is fine to share; nothing about what we paid is.
        carrier=booking.get("carrier_code"),
        delay_reason=(
            CUSTOMER_DELAY_REASON.get(exception["kind"], "experiencing a delay")
            if exception
            else None
        ),
        last_update=(
            _aware(last_ping["occurred_at"]) if last_ping else row["updated_at"]
        ),
        milestones=milestones[-4:],
        quantity=(row["cargo"] or {}).get("quantity"),
        percent_complete=(progress or {}).get("percent"),
        distance_remaining_km=(progress or {}).get("remaining_km"),
    )


def _progress(row: dict[str, Any], last_ping: dict[str, Any] | None) -> dict | None:
    """How far along the journey is, from the last position report.

    Arithmetic, not inference — the same engine the detection rules use. A
    shipment with no coordinates simply has no progress to report, which is
    different from being at zero.
    """
    if last_ping is None or last_ping["latitude"] is None:
        return None

    origin = _coords(row["origin"])
    destination = _coords(row["destination"])
    if origin is None or destination is None:
        return None

    position = (float(last_ping["latitude"]), float(last_ping["longitude"]))
    if haversine_km(origin, destination) < 1:
        return None

    estimate = estimate_progress(
        position=position,
        origin=origin,
        destination=destination,
        at=_aware(last_ping["occurred_at"]) or datetime.now(UTC),
        observed_speeds=[float(last_ping["speed_kph"])] if last_ping["speed_kph"] else [],
    )
    return {
        "percent": int(round(estimate.fraction_complete * 100)),
        "remaining_km": int(round(estimate.distance_remaining_km)),
        "eta": estimate.eta,
    }


def _coords(location: dict[str, Any] | None) -> tuple[float, float] | None:
    if not location:
        return None
    lat, lon = location.get("latitude"), location.get("longitude")
    if lat is None or lon is None:
        return None
    return (float(lat), float(lon))


def _place(location: dict[str, Any] | None) -> str | None:
    if not location:
        return None
    return location.get("city") or location.get("warehouse") or location.get("address")


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)
