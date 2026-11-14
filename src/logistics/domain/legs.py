"""Leg lifecycle.

A multimodal shipment is a sequence of legs, each with its own carrier,
conveyance and state. Lagos → Tema is truck → vessel → truck, and the shipment
is only as advanced as its legs.

Follows the same shape as `domain/states.py`: an explicit transition table,
validated at write time, so a buggy handler fails its own step rather than
corrupting a shipment.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from enum import StrEnum
from typing import Final

from logistics.domain.states import ShipmentState


class TransportMode(StrEnum):
    ROAD = "ROAD"
    AIR = "AIR"
    SEA = "SEA"
    RAIL = "RAIL"


class LegState(StrEnum):
    PLANNED = "PLANNED"
    SOURCING = "SOURCING"
    BOOKED = "BOOKED"
    AT_ORIGIN = "AT_ORIGIN"
    IN_TRANSIT = "IN_TRANSIT"
    AT_DESTINATION = "AT_DESTINATION"

    HANDED_OFF = "HANDED_OFF"
    """Cargo transferred to the next leg's custody but that leg has not started.

    Distinct from COMPLETED on purpose. A container discharged at Apapa with
    nobody booked to collect it is the classic way a multi-leg shipment dies
    quietly — this state makes that gap queryable instead of invisible.
    """

    COMPLETED = "COMPLETED"
    EXCEPTION = "EXCEPTION"
    CANCELLED = "CANCELLED"


_L = LegState

LEG_TERMINAL_STATES: Final[frozenset[LegState]] = frozenset(
    {_L.COMPLETED, _L.CANCELLED}
)

_TRANSITIONS: Final[dict[LegState, frozenset[LegState]]] = {
    _L.PLANNED: frozenset({_L.SOURCING, _L.BOOKED, _L.EXCEPTION, _L.CANCELLED}),
    _L.SOURCING: frozenset({_L.BOOKED, _L.EXCEPTION, _L.CANCELLED}),
    _L.BOOKED: frozenset({_L.AT_ORIGIN, _L.SOURCING, _L.EXCEPTION, _L.CANCELLED}),
    _L.AT_ORIGIN: frozenset({_L.IN_TRANSIT, _L.EXCEPTION, _L.CANCELLED}),
    _L.IN_TRANSIT: frozenset({_L.AT_DESTINATION, _L.EXCEPTION}),
    # The final leg completes outright; an intermediate one hands off.
    _L.AT_DESTINATION: frozenset({_L.HANDED_OFF, _L.COMPLETED, _L.EXCEPTION}),
    _L.HANDED_OFF: frozenset({_L.COMPLETED, _L.EXCEPTION}),
    # Recovery re-enters wherever the leg actually is.
    _L.EXCEPTION: frozenset(
        {_L.SOURCING, _L.BOOKED, _L.AT_ORIGIN, _L.IN_TRANSIT,
         _L.AT_DESTINATION, _L.COMPLETED, _L.CANCELLED}
    ),
    _L.COMPLETED: frozenset(),
    _L.CANCELLED: frozenset(),
}


class InvalidLegTransition(Exception):
    def __init__(self, current: LegState, proposed: LegState) -> None:
        self.current = current
        self.proposed = proposed
        allowed = sorted(_TRANSITIONS.get(current, frozenset()))
        super().__init__(
            f"leg {current} cannot transition to {proposed}. "
            f"Allowed: {', '.join(allowed) if allowed else '(terminal)'}"
        )


def can_transition(current: LegState, proposed: LegState) -> bool:
    return proposed in _TRANSITIONS.get(current, frozenset())


def assert_transition(current: LegState, proposed: LegState) -> None:
    if not can_transition(current, proposed):
        raise InvalidLegTransition(current, proposed)


def is_terminal(state: LegState) -> bool:
    return state in LEG_TERMINAL_STATES


def allowed_from(state: LegState) -> frozenset[LegState]:
    return _TRANSITIONS.get(state, frozenset())


# --------------------------------------------------------------- mode rules

# Modes that cannot carry particular cargo. Enforced when planning legs, so an
# impossible plan is never proposed rather than being rejected by a carrier.
HAZMAT_PROHIBITED_MODES: Final[frozenset[TransportMode]] = frozenset({TransportMode.AIR})


def modes_for_cargo(*, hazmat: bool = False, temperature_controlled: bool = False) -> frozenset[TransportMode]:
    """Which modes may legally and practically carry this cargo."""
    modes = set(TransportMode)
    if hazmat:
        modes -= HAZMAT_PROHIBITED_MODES
    if temperature_controlled:
        # Reefer capability is a conveyance attribute, not a mode restriction —
        # every mode has temperature-controlled equipment available.
        pass
    return frozenset(modes)


# ------------------------------------------------------------------ rollup


def rollup_state(leg_states: Sequence[LegState] | Iterable[LegState]) -> ShipmentState | None:
    """Derive a shipment's state from its legs.

    Returns None when the legs imply nothing the shipment machine can express —
    the caller then leaves the shipment where it is. Deliberately conservative:
    it never invents a forward transition the legs do not justify.
    """
    states = list(leg_states)
    if not states:
        return None

    if all(s is _L.CANCELLED for s in states):
        return ShipmentState.CANCELLED

    active = [s for s in states if s is not _L.CANCELLED]
    if not active:
        return ShipmentState.CANCELLED

    # One leg in trouble puts the whole shipment in exception — the operator
    # needs to see it regardless of which leg it was.
    if any(s is _L.EXCEPTION for s in active):
        return ShipmentState.EXCEPTION

    if all(s is _L.COMPLETED for s in active):
        return ShipmentState.DELIVERED

    if any(s in (_L.IN_TRANSIT, _L.AT_DESTINATION, _L.HANDED_OFF) for s in active):
        return ShipmentState.IN_TRANSIT

    # AT_ORIGIN means a vehicle is loading — the shipment is booked and moving
    # imminently, but nothing is in transit yet.
    if all(s in (_L.BOOKED, _L.AT_ORIGIN, _L.COMPLETED) for s in active):
        return ShipmentState.BOOKED

    if any(s is _L.SOURCING for s in active):
        return ShipmentState.SOURCING

    return None


def stuck_at_handoff(leg_states: Sequence[LegState]) -> bool:
    """True when a leg has handed off but the next has not picked up.

    The condition worth alarming on: custody transferred, nobody moving it.
    """
    for i, state in enumerate(leg_states[:-1]):
        if state is _L.HANDED_OFF and leg_states[i + 1] in (_L.PLANNED, _L.SOURCING):
            return True
    return False
