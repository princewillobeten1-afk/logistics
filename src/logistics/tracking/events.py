"""Tracking event shapes.

Deliberately narrow. Whatever a carrier API, a telematics box or a driver's
phone sends gets normalised into this before it reaches detection, so the rules
never branch on provider quirks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from logistics.geo import Coordinates


class TrackingSource(StrEnum):
    GPS = "GPS"
    """Fleet telematics."""

    DRIVER_APP = "DRIVER_APP"
    """The driver's phone. Often the only source available on the long tail."""

    CARRIER_API = "CARRIER_API"
    SCAN = "SCAN"
    """Warehouse or depot barcode scan."""

    MANUAL = "MANUAL"
    CUSTOMS = "CUSTOMS"


class TrackingEventType(StrEnum):
    PING = "PING"
    DEPARTED = "DEPARTED"
    ARRIVED = "ARRIVED"
    CHECKPOINT = "CHECKPOINT"
    DELAY_REPORTED = "DELAY_REPORTED"
    EXCEPTION_REPORTED = "EXCEPTION_REPORTED"
    DELIVERED = "DELIVERED"
    TEMPERATURE = "TEMPERATURE"


@dataclass(frozen=True, slots=True)
class TrackingEvent:
    shipment_id: UUID
    occurred_at: datetime
    source: TrackingSource = TrackingSource.GPS
    event_type: TrackingEventType = TrackingEventType.PING
    leg_id: UUID | None = None
    latitude: float | None = None
    longitude: float | None = None
    speed_kph: float | None = None
    heading_deg: float | None = None
    temperature_c: float | None = None
    payload: dict[str, Any] = field(default_factory=dict)

    @property
    def position(self) -> Coordinates | None:
        if self.latitude is None or self.longitude is None:
            return None
        return (self.latitude, self.longitude)
