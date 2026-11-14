"""Journey simulation.

Development only. Feeds synthetic tracking events along a lane so the
detection engine, the exception path and the dashboard can be exercised
end to end before any real GPS exists.

The scenarios are the ones that matter operationally, not a random walk:
a clean run, a truck losing time, and a truck going somewhere it should not.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from logistics.db import Database
from logistics.domain.states import ShipmentState
from logistics.geo import Coordinates
from logistics.obs import get_logger
from logistics.orchestrator.queue import WorkQueue
from logistics.tracking.events import TrackingEvent, TrackingEventType, TrackingSource
from logistics.tracking.ingest import TrackingIngestor

log = get_logger(__name__)

LAGOS: Coordinates = (6.5244, 3.3792)
ABUJA: Coordinates = (9.0765, 7.3986)
KANO: Coordinates = (12.0022, 8.5920)


@dataclass(frozen=True, slots=True)
class Scenario:
    name: str
    speed_kph: float
    deadline_hours: float
    detour: Coordinates | None = None
    description: str = ""


SCENARIOS: dict[str, Scenario] = {
    "clean": Scenario(
        "clean", speed_kph=65, deadline_hours=48,
        description="On route, on time. Should produce no findings at all.",
    ),
    "delayed": Scenario(
        "delayed", speed_kph=22, deadline_hours=8,
        description="Crawling against a tight deadline. Should breach SLA.",
    ),
    "off-route": Scenario(
        "off-route", speed_kph=60, deadline_hours=48, detour=KANO,
        description="Diverts hundreds of km off the corridor.",
    ),
}


def _interpolate(a: Coordinates, b: Coordinates, t: float) -> Coordinates:
    """Linear in lat/lon. Fine over a few hundred km at these latitudes."""
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


async def simulate_journey(
    db: Database,
    queue: WorkQueue,
    *,
    reference: str,
    scenario: str = "delayed",
    pings: int = 6,
) -> dict:
    """Create a shipment already in transit and drive it down the lane."""
    from logistics.shipments import ShipmentRepo

    spec = SCENARIOS.get(scenario)
    if spec is None:
        raise ValueError(f"unknown scenario {scenario!r}; try {', '.join(SCENARIOS)}")

    repo = ShipmentRepo(db)
    now = datetime.now(UTC)

    existing = await repo.get_by_reference(reference)
    if existing is not None:
        async with db.connection() as conn:
            await conn.execute("DELETE FROM shipments WHERE id = %s", (existing.id,))

    # Straight to BOOKED: carrier booking does not exist yet, and this is a
    # simulator rather than a shortcut anything in production would take.
    shipment = await repo.create(
        reference=reference,
        state=ShipmentState.BOOKED,
        customer_ref="SIMULATED",
        origin={"city": "Lagos", "warehouse": "Lagos",
                "latitude": LAGOS[0], "longitude": LAGOS[1]},
        destination={"city": "Abuja", "address": "12 Ahmadu Bello Way, Garki",
                     "latitude": ABUJA[0], "longitude": ABUJA[1]},
        cargo={"sku": "DEFAULT", "quantity": 100, "weight_kg": 1800},
        deadline=now + timedelta(hours=spec.deadline_hours),
    )

    ingestor = TrackingIngestor(db, queue)
    target = spec.detour or ABUJA
    findings: list[str] = []

    # Capture this one too: a shipment that is already doomed at departure
    # raises here, and later pings hit the dedupe and report nothing.
    departure = await ingestor.ingest(
        TrackingEvent(
            shipment_id=shipment.id,
            occurred_at=now,
            source=TrackingSource.GPS,
            event_type=TrackingEventType.DEPARTED,
            latitude=LAGOS[0],
            longitude=LAGOS[1],
            speed_kph=spec.speed_kph,
        )
    )
    findings.extend(departure.raised)

    for i in range(1, pings + 1):
        fraction = i / (pings + 1)
        position = _interpolate(LAGOS, target, fraction)
        result = await ingestor.ingest(
            TrackingEvent(
                shipment_id=shipment.id,
                occurred_at=now + timedelta(minutes=15 * i),
                source=TrackingSource.GPS,
                latitude=position[0],
                longitude=position[1],
                speed_kph=spec.speed_kph,
            )
        )
        findings.extend(result.raised)

    return {
        "reference": reference,
        "shipment_id": str(shipment.id),
        "scenario": spec.name,
        "description": spec.description,
        "pings": pings + 1,
        "raised": sorted(set(findings)),
    }
