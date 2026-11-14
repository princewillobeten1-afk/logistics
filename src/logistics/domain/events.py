"""Event types for the append-only shipment log.

The DB column is TEXT, so handlers may emit types beyond this enum. These are
the ones the orchestrator itself writes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from logistics.domain.states import ShipmentState


class EventType(StrEnum):
    SHIPMENT_CREATED = "shipment.created"
    STATE_CHANGED = "shipment.state_changed"

    STEP_SCHEDULED = "step.scheduled"
    STEP_FAILED = "step.failed"
    STEP_ABANDONED = "step.abandoned"

    VALIDATION_PASSED = "order.validation_passed"
    INFO_REQUESTED = "order.info_requested"

    ALLOCATION_RESERVED = "warehouse.allocation_reserved"
    ALLOCATION_SHORT = "warehouse.allocation_short"

    ACTION_PROPOSED = "policy.action_proposed"
    ACTION_GATED = "policy.action_gated"
    APPROVAL_REQUESTED = "policy.approval_requested"
    APPROVAL_DECIDED = "policy.approval_decided"


@dataclass(frozen=True, slots=True)
class EventDraft:
    """An event a handler wants appended. `seq` is assigned by the
    orchestrator inside the transaction, never by the handler."""

    type: str
    payload: dict[str, Any] = field(default_factory=dict)
    actor: str = "system"
    from_state: ShipmentState | None = None
    to_state: ShipmentState | None = None
