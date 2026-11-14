from __future__ import annotations

import pytest

from logistics.domain.states import (
    TERMINAL_STATES,
    InvalidTransition,
    ShipmentState,
    allowed_from,
    assert_transition,
    can_transition,
    is_terminal,
)
from logistics.orchestrator.routing import STATE_ROUTES, next_step

S = ShipmentState


def test_happy_path_is_walkable():
    path = [
        S.DRAFT, S.VALIDATED, S.ALLOCATED, S.PLANNED,
        S.SOURCING, S.AWAITING_APPROVAL, S.BOOKED, S.IN_TRANSIT,
        S.DELIVERED, S.POD_VERIFIED, S.CLOSED,
    ]
    for current, nxt in zip(path, path[1:], strict=False):
        assert can_transition(current, nxt), f"{current} → {nxt} should be legal"


def test_terminal_states_are_dead_ends():
    for state in TERMINAL_STATES:
        assert is_terminal(state)
        assert allowed_from(state) == frozenset()


def test_illegal_transitions_are_rejected():
    # Skipping straight from intake to booked would bypass allocation,
    # planning and the policy gate.
    assert not can_transition(S.DRAFT, S.BOOKED)
    assert not can_transition(S.CLOSED, S.IN_TRANSIT)
    assert not can_transition(S.DELIVERED, S.IN_TRANSIT)


def test_assert_transition_names_the_alternatives():
    with pytest.raises(InvalidTransition) as excinfo:
        assert_transition(S.DRAFT, S.BOOKED)
    message = str(excinfo.value)
    assert "DRAFT cannot transition to BOOKED" in message
    assert "VALIDATED" in message


def test_exception_can_recover_or_fail():
    for target in (S.IN_TRANSIT, S.SOURCING, S.AWAITING_APPROVAL, S.DELIVERED):
        assert can_transition(S.EXCEPTION, target)
    assert can_transition(S.EXCEPTION, S.FAILED)


def test_approval_rejection_returns_to_sourcing():
    """Rejecting a carrier must not kill the shipment — it tries the next one."""
    assert can_transition(S.AWAITING_APPROVAL, S.SOURCING)


def test_pod_discrepancy_reopens_as_exception():
    assert can_transition(S.DELIVERED, S.EXCEPTION)


def test_wait_states_have_no_auto_route():
    """States that wait on the outside world must not be auto-advanced."""
    for state in (S.NEEDS_INFO, S.SOURCING, S.AWAITING_APPROVAL, S.BOOKED, S.IN_TRANSIT):
        assert next_step(state) is None, f"{state} should wait, not auto-advance"


def test_every_route_targets_a_real_handler_kind():
    for state, kind in STATE_ROUTES.items():
        assert isinstance(kind, str) and "." in kind, f"{state} routes to a malformed kind"


def test_no_terminal_state_is_routed():
    for state in TERMINAL_STATES:
        assert next_step(state) is None
