"""ETA computation.

Arithmetic, not inference. Position plus remaining distance plus an effective
speed gives an arrival time; comparing that to the promise gives drift. A
model adds nothing here except cost, latency and the ability to be wrong in
novel ways.

Effective speed comes from the shipment's own recent history where there is
any, because a truck's observed average on this lane today beats a table.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from logistics.geo import Coordinates, along_track_km, cross_track_km, haversine_km

# Fallback when a shipment has no usable speed history. Nigerian highway
# average including stops, not motorway cruising speed.
DEFAULT_SPEED_KPH = 55.0

# Below this, a vehicle is stopped rather than crawling. Averaging stationary
# pings into the speed estimate would push every ETA to infinity.
MOVING_THRESHOLD_KPH = 5.0


@dataclass(frozen=True, slots=True)
class Progress:
    distance_remaining_km: float
    distance_travelled_km: float
    fraction_complete: float
    effective_speed_kph: float
    eta: datetime | None
    cross_track_km: float
    """How far off the direct origin→destination path the vehicle is."""

    @property
    def hours_remaining(self) -> float:
        return self.distance_remaining_km / max(self.effective_speed_kph, 1.0)


def effective_speed(
    observed: list[float], *, fallback: float = DEFAULT_SPEED_KPH
) -> float:
    """Average of the moving samples. Stationary pings are excluded: a truck
    parked for an hour has not changed how fast it travels when it travels."""
    moving = [s for s in observed if s is not None and s >= MOVING_THRESHOLD_KPH]
    if not moving:
        return fallback
    return sum(moving) / len(moving)


def estimate_progress(
    *,
    position: Coordinates,
    origin: Coordinates,
    destination: Coordinates,
    at: datetime | None = None,
    observed_speeds: list[float] | None = None,
    speed_fallback: float = DEFAULT_SPEED_KPH,
) -> Progress:
    """Where the shipment is along its path, and when it will arrive."""
    at = at or datetime.now(UTC)

    remaining = haversine_km(position, destination)
    total = haversine_km(origin, destination)

    travelled = along_track_km(position, origin, destination)
    travelled = max(0.0, min(travelled, total))
    fraction = (travelled / total) if total > 0 else 1.0

    speed = effective_speed(observed_speeds or [], fallback=speed_fallback)
    eta = at + timedelta(hours=remaining / max(speed, 1.0))

    return Progress(
        distance_remaining_km=remaining,
        distance_travelled_km=travelled,
        fraction_complete=min(1.0, max(0.0, fraction)),
        effective_speed_kph=speed,
        eta=eta,
        cross_track_km=cross_track_km(position, origin, destination),
    )
