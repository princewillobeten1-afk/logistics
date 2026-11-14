from __future__ import annotations

import pytest

from logistics.domain.legs import (
    LEG_TERMINAL_STATES,
    InvalidLegTransition,
    LegState,
    TransportMode,
    allowed_from,
    assert_transition,
    can_transition,
    is_terminal,
    modes_for_cargo,
    rollup_state,
    stuck_at_handoff,
)
from logistics.domain.states import ShipmentState

L = LegState
S = ShipmentState


def test_final_leg_walks_to_completed():
    path = [L.PLANNED, L.SOURCING, L.BOOKED, L.AT_ORIGIN, L.IN_TRANSIT,
            L.AT_DESTINATION, L.COMPLETED]
    for current, nxt in zip(path, path[1:], strict=False):
        assert can_transition(current, nxt), f"{current} -> {nxt} should be legal"


def test_intermediate_leg_hands_off_before_completing():
    assert can_transition(L.AT_DESTINATION, L.HANDED_OFF)
    assert can_transition(L.HANDED_OFF, L.COMPLETED)


def test_terminal_leg_states_are_dead_ends():
    for state in LEG_TERMINAL_STATES:
        assert is_terminal(state)
        assert allowed_from(state) == frozenset()


def test_illegal_leg_transitions_are_refused():
    assert not can_transition(L.PLANNED, L.IN_TRANSIT)
    assert not can_transition(L.COMPLETED, L.IN_TRANSIT)
    with pytest.raises(InvalidLegTransition, match="cannot transition"):
        assert_transition(L.PLANNED, L.COMPLETED)


def test_exception_can_re_enter_where_the_leg_actually_is():
    for target in (L.SOURCING, L.BOOKED, L.AT_ORIGIN, L.IN_TRANSIT, L.AT_DESTINATION):
        assert can_transition(L.EXCEPTION, target)


# ------------------------------------------------------------- cargo rules


def test_hazmat_cannot_fly():
    assert TransportMode.AIR not in modes_for_cargo(hazmat=True)
    assert TransportMode.SEA in modes_for_cargo(hazmat=True)


def test_ordinary_cargo_can_use_every_mode():
    assert modes_for_cargo() == frozenset(TransportMode)


# ----------------------------------------------------------------- rollup


def test_no_legs_implies_nothing():
    assert rollup_state([]) is None


def test_all_completed_means_delivered():
    assert rollup_state([L.COMPLETED, L.COMPLETED]) is S.DELIVERED


def test_any_leg_in_transit_means_in_transit():
    assert rollup_state([L.COMPLETED, L.IN_TRANSIT, L.PLANNED]) is S.IN_TRANSIT


def test_handed_off_still_counts_as_in_transit():
    """Custody has moved but the journey has not ended."""
    assert rollup_state([L.HANDED_OFF, L.PLANNED]) is S.IN_TRANSIT


def test_one_bad_leg_puts_the_whole_shipment_in_exception():
    assert rollup_state([L.COMPLETED, L.EXCEPTION, L.PLANNED]) is S.EXCEPTION


def test_exception_outranks_in_transit():
    assert rollup_state([L.IN_TRANSIT, L.EXCEPTION]) is S.EXCEPTION


def test_all_booked_means_booked():
    assert rollup_state([L.BOOKED, L.BOOKED]) is S.BOOKED


def test_loading_at_origin_is_still_booked():
    assert rollup_state([L.AT_ORIGIN, L.BOOKED]) is S.BOOKED


def test_sourcing_when_a_leg_is_still_being_quoted():
    assert rollup_state([L.BOOKED, L.SOURCING]) is S.SOURCING


def test_all_cancelled_means_cancelled():
    assert rollup_state([L.CANCELLED, L.CANCELLED]) is S.CANCELLED


def test_cancelled_legs_are_ignored_alongside_live_ones():
    assert rollup_state([L.CANCELLED, L.IN_TRANSIT]) is S.IN_TRANSIT


def test_rollup_never_invents_a_transition_it_cannot_justify():
    """All planned: the shipment machine has no state for that, so leave it."""
    assert rollup_state([L.PLANNED, L.PLANNED]) is None


# ---------------------------------------------------------------- handoff


def test_detects_cargo_stranded_at_a_handoff():
    """The Apapa case: discharged, and nobody booked to collect it."""
    assert stuck_at_handoff([L.HANDED_OFF, L.PLANNED]) is True
    assert stuck_at_handoff([L.COMPLETED, L.HANDED_OFF, L.SOURCING]) is True


def test_handoff_with_the_next_leg_moving_is_fine():
    assert stuck_at_handoff([L.HANDED_OFF, L.IN_TRANSIT]) is False
    assert stuck_at_handoff([L.HANDED_OFF, L.BOOKED]) is False


def test_final_leg_handed_off_is_not_stranded():
    """Nothing follows it, so there is nothing to be waiting on."""
    assert stuck_at_handoff([L.COMPLETED, L.HANDED_OFF]) is False
