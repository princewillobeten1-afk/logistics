"""The shipment lifecycle.

Deliberately a plain state machine rather than an LLM planner. The lifecycle is
known in advance and identical for every shipment, so there is nothing for a
model to plan — and a state machine is replayable, testable, and cannot invent
a transition that does not exist.

Only states that represent a genuine wait are modelled. There is no VALIDATING
or BOOKING state: work in flight is recorded in `work_items`, not smeared
across the shipment's own state.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Final


class ShipmentState(StrEnum):
    DRAFT = "DRAFT"
    """Intake landed. Nothing validated yet."""

    NEEDS_INFO = "NEEDS_INFO"
    """Blocked on the customer — a bad address, a missing field."""

    VALIDATED = "VALIDATED"
    ALLOCATED = "ALLOCATED"
    PLANNED = "PLANNED"

    SOURCING = "SOURCING"
    """Quote window is open. A real wait: WhatsApp carriers reply on their own
    schedule, so this state carries a deadline and a best-so-far fallback."""

    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    """A human must decide. Can last hours; must survive deploys."""

    BOOKED = "BOOKED"
    IN_TRANSIT = "IN_TRANSIT"

    EXCEPTION = "EXCEPTION"
    """Detection fired. This is the only state that wakes a reasoning agent."""

    DELIVERED = "DELIVERED"
    POD_VERIFIED = "POD_VERIFIED"

    CLOSED = "CLOSED"
    CANCELLED = "CANCELLED"
    FAILED = "FAILED"


TERMINAL_STATES: Final[frozenset[ShipmentState]] = frozenset(
    {ShipmentState.CLOSED, ShipmentState.CANCELLED, ShipmentState.FAILED}
)

_S = ShipmentState

# Every legal edge. Anything absent is rejected at write time, which means a
# buggy handler corrupts nothing — it just fails its step.
_TRANSITIONS: Final[dict[ShipmentState, frozenset[ShipmentState]]] = {
    _S.DRAFT: frozenset({_S.NEEDS_INFO, _S.VALIDATED, _S.CANCELLED, _S.FAILED}),
    _S.NEEDS_INFO: frozenset({_S.VALIDATED, _S.CANCELLED, _S.FAILED}),
    # EXCEPTION is reachable here because allocation runs from VALIDATED and
    # can find the stock short or unable to reach the destination in time.
    _S.VALIDATED: frozenset(
        {_S.ALLOCATED, _S.NEEDS_INFO, _S.EXCEPTION, _S.CANCELLED, _S.FAILED}
    ),
    _S.ALLOCATED: frozenset({_S.PLANNED, _S.EXCEPTION, _S.CANCELLED, _S.FAILED}),
    _S.PLANNED: frozenset({_S.SOURCING, _S.EXCEPTION, _S.CANCELLED, _S.FAILED}),
    # PLANNED is reachable again so a sourcing round that found nothing usable
    # can re-run through the normal route rather than a handler reaching around
    # the orchestrator to re-enqueue itself.
    _S.SOURCING: frozenset(
        {_S.AWAITING_APPROVAL, _S.BOOKED, _S.PLANNED, _S.EXCEPTION, _S.CANCELLED, _S.FAILED}
    ),
    # A rejected approval goes back to PLANNED to source again with the next
    # carrier; SOURCING stays reachable for a re-open that keeps the round.
    _S.AWAITING_APPROVAL: frozenset(
        {_S.BOOKED, _S.SOURCING, _S.PLANNED, _S.EXCEPTION, _S.CANCELLED, _S.FAILED}
    ),
    _S.BOOKED: frozenset({_S.IN_TRANSIT, _S.EXCEPTION, _S.CANCELLED, _S.FAILED}),
    _S.IN_TRANSIT: frozenset({_S.DELIVERED, _S.EXCEPTION, _S.FAILED}),
    _S.EXCEPTION: frozenset(
        {_S.IN_TRANSIT, _S.SOURCING, _S.AWAITING_APPROVAL, _S.DELIVERED, _S.CANCELLED, _S.FAILED}
    ),
    # A short-delivery or damage finding at POD reopens as an exception.
    _S.DELIVERED: frozenset({_S.POD_VERIFIED, _S.EXCEPTION}),
    _S.POD_VERIFIED: frozenset({_S.CLOSED}),
    _S.CLOSED: frozenset(),
    _S.CANCELLED: frozenset(),
    _S.FAILED: frozenset(),
}


class InvalidTransition(Exception):
    """Raised when a handler proposes an edge the lifecycle does not have."""

    def __init__(self, current: ShipmentState, proposed: ShipmentState) -> None:
        self.current = current
        self.proposed = proposed
        allowed = sorted(_TRANSITIONS.get(current, frozenset()))
        super().__init__(
            f"{current} cannot transition to {proposed}. "
            f"Allowed: {', '.join(allowed) if allowed else '(terminal)'}"
        )


def can_transition(current: ShipmentState, proposed: ShipmentState) -> bool:
    return proposed in _TRANSITIONS.get(current, frozenset())


def assert_transition(current: ShipmentState, proposed: ShipmentState) -> None:
    if not can_transition(current, proposed):
        raise InvalidTransition(current, proposed)


def is_terminal(state: ShipmentState) -> bool:
    return state in TERMINAL_STATES


def allowed_from(state: ShipmentState) -> frozenset[ShipmentState]:
    return _TRANSITIONS.get(state, frozenset())
