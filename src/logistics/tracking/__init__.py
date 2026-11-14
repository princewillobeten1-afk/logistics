"""Tracking and detection.

The load-bearing rule of the whole platform lives here: **deterministic code
detects, the model only reasons.**

ETA drift, route deviation, dwell and missed checkpoints are arithmetic over a
tracking event. They run on every event, cost nothing, and are unit-testable.
At 5,000 shipments/day this loop handles over a million checks; a model on that
path would cost six figures a year to compute what an `if` computes for free,
and would add latency and non-determinism to the most safety-critical code in
the system.

Nothing in this package imports the LLM layer. That is not an accident, and it
should stay true.
"""

from logistics.tracking.detection import (
    Detection,
    Severity,
    Thresholds,
    detect_on_event,
    detect_stale,
)
from logistics.tracking.eta import Progress, estimate_progress
from logistics.tracking.events import TrackingEvent, TrackingEventType, TrackingSource

__all__ = [
    "Detection",
    "Progress",
    "Severity",
    "Thresholds",
    "TrackingEvent",
    "TrackingEventType",
    "TrackingSource",
    "detect_on_event",
    "detect_stale",
    "estimate_progress",
]
