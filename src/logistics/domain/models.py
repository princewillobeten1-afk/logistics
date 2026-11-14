"""Core domain objects passed between the queue, the orchestrator, and handlers."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID

from logistics.domain.events import EventDraft
from logistics.domain.states import ShipmentState


@dataclass(frozen=True, slots=True)
class Shipment:
    id: UUID
    reference: str
    state: ShipmentState
    version: int
    customer_ref: str | None = None
    origin: dict[str, Any] = field(default_factory=dict)
    destination: dict[str, Any] = field(default_factory=dict)
    cargo: dict[str, Any] = field(default_factory=dict)
    deadline: datetime | None = None
    allocation: dict[str, Any] | None = None
    plan: dict[str, Any] | None = None
    booking: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class WorkItem:
    id: UUID
    kind: str
    payload: dict[str, Any]
    attempts: int
    max_attempts: int
    shipment_id: UUID | None = None
    # Which organisation this work belongs to. The claim runs across all orgs;
    # the handler then runs scoped to this one.
    org_id: UUID | None = None

    @property
    def is_final_attempt(self) -> bool:
        return self.attempts >= self.max_attempts


@dataclass(frozen=True, slots=True)
class WorkRequest:
    """A step to run later. `dedupe_key` makes enqueue idempotent — re-running a
    handler that already enqueued its follow-up collides instead of duplicating."""

    kind: str
    shipment_id: UUID | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    run_after: datetime | None = None
    dedupe_key: str | None = None
    max_attempts: int = 5
    priority: int = 100


@dataclass(frozen=True, slots=True)
class LegDraft:
    """A transport leg a handler wants created.

    Location ids are optional: planning knows "Apapa" before the location
    registry necessarily has a row for it, so names travel in `metadata` and a
    later resolver fills the ids.
    """

    sequence: int
    mode: str
    origin_name: str | None = None
    destination_name: str | None = None
    origin_id: UUID | None = None
    destination_id: UUID | None = None
    planned_departure: datetime | None = None
    planned_arrival: datetime | None = None
    distance_km: float | None = None
    cost_minor: int | None = None
    currency: str | None = None
    load_type: str | None = None
    co2e_kg: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.cost_minor is not None and not self.currency:
            raise ValueError(f"leg {self.sequence} has a cost with no currency")


@dataclass(frozen=True, slots=True)
class StepResult:
    """What a handler decided.

    Returned rather than written directly, so the orchestrator can apply the
    whole thing in one transaction: transition, events, and follow-up work
    either all land or none do.
    """

    transition: ShipmentState | None = None
    events: tuple[EventDraft, ...] = ()
    enqueue: tuple[WorkRequest, ...] = ()
    patch: dict[str, Any] = field(default_factory=dict)
    """Shallow update to shipment columns (allocation, plan, booking, ...)."""

    legs: tuple[LegDraft, ...] = ()
    """Transport legs to create. Replaces any existing legs for the shipment,
    so re-planning is idempotent rather than additive."""

    @classmethod
    def noop(cls) -> StepResult:
        return cls()
