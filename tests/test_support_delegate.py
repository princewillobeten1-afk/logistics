"""Delegation routing — pure, no model and no database.

This is the layer that decides whether a customer message becomes an action,
so it is worth testing exhaustively without anything else in the way.
"""

from __future__ import annotations

from uuid import uuid4

from logistics.support.decide import (
    ChangeRequest,
    Intent,
    OrderDraft,
    SupportDecision,
)
from logistics.support.delegate import plan_delegation

CONTACT = uuid4()
MESSAGE = uuid4()
SHIPMENT = uuid4()

COMPLETE_ORDER = OrderDraft(
    shipper_name="Chidi Okonkwo",
    shipper_phone="08023334444",
    pickup="Plot 14 Acme Way, Ikeja, Lagos",
    receiver_name="Musa Danjuma",
    receiver_phone="08031112222",
    destination="12 Ahmadu Bello Way, Garki, Abuja",
    description="cartons of soap",
    quantity=50,
    weight_kg=900,
    ready=True,
)


def _decision(intent: Intent, **kw) -> SupportDecision:
    return SupportDecision(
        reply="ok", intent=intent, confidence=kw.pop("confidence", 0.9), **kw
    )


def _plan(decision, shipment_id=None):  # noqa: ANN001, ANN202
    return plan_delegation(
        decision,
        contact_id=CONTACT,
        communication_id=MESSAGE,
        shipment_id=shipment_id,
    )


# ------------------------------------------------------------ no action


def test_status_delegates_nothing():
    """The reply is the whole action."""
    result = _plan(_decision(Intent.STATUS), shipment_id=SHIPMENT)
    assert result.requests == ()


def test_chitchat_delegates_nothing():
    assert _plan(_decision(Intent.CHITCHAT)).requests == ()


def test_low_confidence_replies_but_does_not_act():
    """An uncertain read should produce a question, not a shipment."""
    result = _plan(
        _decision(Intent.NEW_ORDER, order=COMPLETE_ORDER, confidence=0.3)
    )
    assert result.requests == ()
    assert "below the action threshold" in result.reason


def test_low_confidence_still_escalates():
    """Not being sure what someone wants is itself a reason to fetch a human."""
    result = _plan(
        _decision(Intent.ESCALATE, escalate_reason="unclear", confidence=0.1)
    )
    assert [r.kind for r in result.requests] == ["support.escalate"]


# ---------------------------------------------------------- new orders


def test_a_complete_order_creates_a_shipment():
    result = _plan(_decision(Intent.NEW_ORDER, order=COMPLETE_ORDER))
    assert [r.kind for r in result.requests] == ["support.create_shipment"]
    assert result.draft is None, "a placed order is no longer a draft"


def test_an_incomplete_order_creates_nothing():
    """A shipment with no destination is worse than one more question."""
    partial = OrderDraft(destination="Abuja", quantity=50)
    result = _plan(_decision(Intent.NEW_ORDER, order=partial))

    assert result.requests == ()
    assert "still collecting" in result.reason
    assert result.draft["destination"] == "Abuja"


def test_a_partial_order_is_carried_to_the_next_turn():
    partial = OrderDraft(destination="Abuja", description="cartons")
    result = _plan(_decision(Intent.NEW_ORDER, order=partial))
    assert result.draft == {"destination": "Abuja", "description": "cartons"}


def test_new_order_intent_with_nothing_collected_yet():
    result = _plan(_decision(Intent.NEW_ORDER, order=None))
    assert result.requests == ()
    assert result.draft is None


def test_creation_is_keyed_on_the_message():
    """A retried step must not book twice."""
    result = _plan(_decision(Intent.NEW_ORDER, order=COMPLETE_ORDER))
    assert result.requests[0].dedupe_key == f"create:{MESSAGE}"


# ------------------------------------------------------ change requests


def test_a_change_request_is_delegated_not_applied():
    result = _plan(
        _decision(
            Intent.CHANGE_REQUEST,
            change=ChangeRequest(kind="address", detail="deliver to Wuse instead"),
        ),
        shipment_id=SHIPMENT,
    )
    assert [r.kind for r in result.requests] == ["support.change_request"]
    assert result.requests[0].payload["kind"] == "address"


def test_a_change_request_without_a_shipment_asks_rather_than_guesses():
    """Applying a change to the wrong shipment is the worst outcome here."""
    result = _plan(
        _decision(
            Intent.CHANGE_REQUEST,
            change=ChangeRequest(kind="address", detail="change it"),
        ),
        shipment_id=None,
    )
    assert result.requests == ()
    assert "no shipment identified" in result.reason


# ------------------------------------------------------------ escalation


def test_escalation_abandons_a_half_collected_order():
    """A person takes over; a stale draft would confuse them."""
    result = _plan(
        _decision(Intent.ESCALATE, escalate_reason="customer is unhappy")
    )
    assert result.draft is None
    assert result.requests[0].payload["reason"] == "customer is unhappy"


# ------------------------------------------------- the safety invariant


def test_nothing_money_moving_is_ever_delegated_directly():
    """The support agent can start work; it can never book or spend. Booking
    happens only behind the policy gate, from carrier sourcing."""
    forbidden = {"carrier.book", "carrier.close_window", "approval.granted"}

    decisions = [
        _decision(Intent.NEW_ORDER, order=COMPLETE_ORDER),
        _decision(
            Intent.CHANGE_REQUEST,
            change=ChangeRequest(kind="cancellation", detail="cancel it"),
        ),
        _decision(Intent.ESCALATE, escalate_reason="x"),
        _decision(Intent.STATUS),
        _decision(Intent.CHITCHAT),
    ]

    for decision in decisions:
        result = _plan(decision, shipment_id=SHIPMENT)
        assert not ({r.kind for r in result.requests} & forbidden)


def test_every_intent_is_routed():
    """A new intent with no branch would silently do nothing."""
    for intent in Intent:
        decision = _decision(
            intent,
            order=COMPLETE_ORDER if intent is Intent.NEW_ORDER else None,
            change=(
                ChangeRequest(kind="address", detail="x")
                if intent is Intent.CHANGE_REQUEST
                else None
            ),
        )
        result = _plan(decision, shipment_id=SHIPMENT)
        assert result.reason, f"{intent} produced no routing reason"
