"""Detection rules.

Pure functions: state in, findings out. No database, no model, no clock of
their own — `now` is always passed in, so every rule is deterministic and
replayable against historical events.

Two families, and the split matters:

  * **On-event** rules fire from something that happened — a position implying
    a late arrival, a vehicle off course, a temperature out of range.
  * **Absence** rules fire from something that did *not* happen — a checkpoint
    never reached, a vehicle that stopped reporting. These cannot be
    event-driven, because no event arrives to trigger them. They need a sweep.

Missing that distinction is how systems end up never noticing a truck that
simply went quiet.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any

from logistics.tracking.eta import Progress


class Severity(StrEnum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class DetectionKind(StrEnum):
    ETA_DRIFT = "ETA_DRIFT"
    SLA_BREACH_RISK = "SLA_BREACH_RISK"
    ROUTE_DEVIATION = "ROUTE_DEVIATION"
    DWELL = "DWELL"
    TEMPERATURE_EXCURSION = "TEMPERATURE_EXCURSION"
    MISSED_CHECKPOINT = "MISSED_CHECKPOINT"
    SIGNAL_LOST = "SIGNAL_LOST"
    POD_DISCREPANCY = "POD_DISCREPANCY"
    ALLOCATION_SHORT = "ALLOCATION_SHORT"
    NO_CARRIERS = "NO_CARRIERS"
    SOURCING_EXHAUSTED = "SOURCING_EXHAUSTED"


@dataclass(frozen=True, slots=True)
class Detection:
    kind: DetectionKind
    severity: Severity
    summary: str
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Thresholds:
    """Tuning lives in one place so it can move to policy data later."""

    eta_drift_minutes: float = 30.0
    eta_drift_high_minutes: float = 120.0

    # Deviation is measured against the straight line between origin and
    # destination, because that is all we have until the routing provider
    # gives us a polyline. Roads do not follow great circles: Ibadan sits
    # ~46 km off the Lagos→Abuja line and is *on* the normal route, so a tight
    # corridor would alert on every correctly-routed truck.
    #
    # Replace this with distance-to-polyline once real routes exist; the
    # corridor can then tighten to ~15 km and actually mean something.
    deviation_km: float = 90.0
    deviation_high_km: float = 180.0
    dwell_minutes: float = 90.0
    dwell_high_minutes: float = 240.0
    signal_lost_hours: float = 4.0
    signal_lost_high_hours: float = 12.0
    checkpoint_grace_minutes: float = 60.0


def _scale(value: float, warn: float, high: float) -> Severity:
    if value >= high * 2:
        return Severity.CRITICAL
    if value >= high:
        return Severity.HIGH
    if value >= warn:
        return Severity.MEDIUM
    return Severity.LOW


def check_eta_drift(
    progress: Progress,
    planned_arrival: datetime | None,
    thresholds: Thresholds,
) -> Detection | None:
    if planned_arrival is None or progress.eta is None:
        return None

    drift_min = (progress.eta - planned_arrival).total_seconds() / 60
    if drift_min < thresholds.eta_drift_minutes:
        return None

    return Detection(
        kind=DetectionKind.ETA_DRIFT,
        severity=_scale(
            drift_min, thresholds.eta_drift_minutes, thresholds.eta_drift_high_minutes
        ),
        summary=f"Running {drift_min:.0f} min behind the planned arrival",
        detail={
            "planned_arrival": planned_arrival.isoformat(),
            "projected_arrival": progress.eta.isoformat(),
            "drift_minutes": round(drift_min, 1),
            "distance_remaining_km": round(progress.distance_remaining_km, 1),
            "effective_speed_kph": round(progress.effective_speed_kph, 1),
        },
    )


def check_sla_breach(
    progress: Progress, deadline: datetime | None, thresholds: Thresholds
) -> Detection | None:
    """The contracted promise, not the internal plan. Always at least HIGH —
    this is the one that costs money and customers."""
    if deadline is None or progress.eta is None:
        return None
    if progress.eta <= deadline:
        return None

    over_min = (progress.eta - deadline).total_seconds() / 60
    return Detection(
        kind=DetectionKind.SLA_BREACH_RISK,
        severity=Severity.CRITICAL if over_min >= 120 else Severity.HIGH,
        summary=f"Projected to miss the delivery deadline by {over_min:.0f} min",
        detail={
            "deadline": deadline.isoformat(),
            "projected_arrival": progress.eta.isoformat(),
            "over_by_minutes": round(over_min, 1),
            "distance_remaining_km": round(progress.distance_remaining_km, 1),
        },
    )


def check_route_deviation(
    progress: Progress, thresholds: Thresholds
) -> Detection | None:
    if progress.cross_track_km < thresholds.deviation_km:
        return None
    return Detection(
        kind=DetectionKind.ROUTE_DEVIATION,
        severity=_scale(
            progress.cross_track_km, thresholds.deviation_km, thresholds.deviation_high_km
        ),
        summary=f"{progress.cross_track_km:.0f} km off the direct route",
        detail={
            "cross_track_km": round(progress.cross_track_km, 1),
            "fraction_complete": round(progress.fraction_complete, 3),
        },
    )


def check_dwell(
    stationary_since: datetime | None, now: datetime, thresholds: Thresholds
) -> Detection | None:
    """Stopped in transit. Distinct from a scheduled stop, which the caller
    filters out before asking."""
    if stationary_since is None:
        return None

    minutes = (now - stationary_since).total_seconds() / 60
    if minutes < thresholds.dwell_minutes:
        return None

    return Detection(
        kind=DetectionKind.DWELL,
        severity=_scale(minutes, thresholds.dwell_minutes, thresholds.dwell_high_minutes),
        summary=f"Stationary for {minutes / 60:.1f} h in transit",
        detail={
            "stationary_since": stationary_since.isoformat(),
            "dwell_minutes": round(minutes, 1),
        },
    )


def check_temperature(
    temperature_c: float | None, min_c: float | None, max_c: float | None
) -> Detection | None:
    """Reefer cargo out of range. Always CRITICAL — a temperature excursion
    can write off an entire load, and it cannot be undone later."""
    if temperature_c is None or (min_c is None and max_c is None):
        return None

    if min_c is not None and temperature_c < min_c:
        breach, limit = min_c - temperature_c, min_c
        direction = "below"
    elif max_c is not None and temperature_c > max_c:
        breach, limit = temperature_c - max_c, max_c
        direction = "above"
    else:
        return None

    return Detection(
        kind=DetectionKind.TEMPERATURE_EXCURSION,
        severity=Severity.CRITICAL,
        summary=f"Temperature {temperature_c}°C is {breach:.1f}°C {direction} the limit",
        detail={
            "temperature_c": temperature_c,
            "limit_c": limit,
            "breach_c": round(breach, 2),
            "direction": direction,
        },
    )


def detect_on_event(
    *,
    progress: Progress,
    now: datetime,
    planned_arrival: datetime | None = None,
    deadline: datetime | None = None,
    stationary_since: datetime | None = None,
    temperature_c: float | None = None,
    temp_min_c: float | None = None,
    temp_max_c: float | None = None,
    thresholds: Thresholds | None = None,
) -> list[Detection]:
    """Every on-event rule, most severe first."""
    t = thresholds or Thresholds()
    found = [
        check_sla_breach(progress, deadline, t),
        check_eta_drift(progress, planned_arrival, t),
        check_route_deviation(progress, t),
        check_dwell(stationary_since, now, t),
        check_temperature(temperature_c, temp_min_c, temp_max_c),
    ]
    return _ranked([d for d in found if d is not None])


# ------------------------------------------------------------------ absence


def check_missed_checkpoint(
    *, name: str, expected_at: datetime, now: datetime, tolerance_minutes: float
) -> Detection | None:
    late_min = (now - expected_at).total_seconds() / 60 - tolerance_minutes
    if late_min <= 0:
        return None
    return Detection(
        kind=DetectionKind.MISSED_CHECKPOINT,
        severity=_scale(late_min, 0, 180),
        summary=f"Checkpoint “{name}” missed by {late_min:.0f} min",
        detail={
            "checkpoint": name,
            "expected_at": expected_at.isoformat(),
            "late_minutes": round(late_min, 1),
            "tolerance_minutes": tolerance_minutes,
        },
    )


def check_signal_lost(
    *, last_seen: datetime | None, now: datetime, thresholds: Thresholds
) -> Detection | None:
    """A shipment that stopped reporting.

    The rule that only a sweep can catch: silence produces no event to react
    to, so nothing else in the system would ever notice.
    """
    if last_seen is None:
        return None

    hours = (now - last_seen).total_seconds() / 3600
    if hours < thresholds.signal_lost_hours:
        return None

    return Detection(
        kind=DetectionKind.SIGNAL_LOST,
        severity=_scale(
            hours, thresholds.signal_lost_hours, thresholds.signal_lost_high_hours
        ),
        summary=f"No tracking signal for {hours:.1f} h",
        detail={"last_seen": last_seen.isoformat(), "silent_hours": round(hours, 2)},
    )


def detect_stale(
    *,
    now: datetime,
    last_seen: datetime | None = None,
    checkpoints: list[tuple[str, datetime, float]] | None = None,
    thresholds: Thresholds | None = None,
) -> list[Detection]:
    """Absence rules. `checkpoints` is (name, expected_at, tolerance_minutes)."""
    t = thresholds or Thresholds()
    found = [check_signal_lost(last_seen=last_seen, now=now, thresholds=t)]
    for name, expected_at, tolerance in checkpoints or []:
        found.append(
            check_missed_checkpoint(
                name=name, expected_at=expected_at, now=now, tolerance_minutes=tolerance
            )
        )
    return _ranked([d for d in found if d is not None])


_ORDER = {
    Severity.CRITICAL: 0,
    Severity.HIGH: 1,
    Severity.MEDIUM: 2,
    Severity.LOW: 3,
}


def _ranked(detections: list[Detection]) -> list[Detection]:
    return sorted(detections, key=lambda d: _ORDER[d.severity])


def worst(detections: list[Detection]) -> Severity | None:
    return detections[0].severity if detections else None


def actionable(detections: list[Detection]) -> list[Detection]:
    """Findings worth waking a reasoning agent for.

    LOW is recorded but does not escalate — the whole economics of the design
    rests on the model being invoked ~370 times a day, not a million.
    """
    return [d for d in detections if d.severity is not Severity.LOW]
