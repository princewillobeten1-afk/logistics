"""Turning a decision into orchestrator work.

This is where "the support agent talks to the orchestrator" actually happens.
It never calls another agent — it produces `WorkRequest`s, and the orchestrator
routes them exactly as it routes everything else. Each hand-off is therefore a
durable row that can be retried, replayed and audited.

Pure by design: no database, no clock, no model. The whole hand-off table can
be tested by passing a decision in and reading the requests out, which matters
because this is the layer that decides whether a customer message becomes an
action.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from logistics.domain.models import WorkRequest
from logistics.support.decide import Intent, SupportDecision


@dataclass(frozen=True, slots=True)
class Delegation:
    requests: tuple[WorkRequest, ...]
    draft: dict | None
    """Booking state to persist on the contact, or None to clear it."""
    reason: str
    """Why this routing was chosen. Logged, and shown in the ops inbox."""


def plan_delegation(
    decision: SupportDecision,
    *,
    contact_id: UUID,
    communication_id: UUID,
    shipment_id: UUID | None,
) -> Delegation:
    """Decide what work a customer message causes."""

    # An uncertain read produces a reply and nothing else. The customer still
    # gets an answer; the system does not act on a guess.
    if not decision.may_act and decision.intent is not Intent.ESCALATE:
        return Delegation(
            requests=(),
            draft=_draft_of(decision),
            reason=f"confidence {decision.confidence:.2f} is below the action threshold",
        )

    if decision.intent is Intent.NEW_ORDER:
        return _new_order(decision, contact_id, communication_id)

    if decision.intent is Intent.CHANGE_REQUEST:
        return _change_request(decision, contact_id, communication_id, shipment_id)

    if decision.intent is Intent.ESCALATE:
        return Delegation(
            requests=(
                WorkRequest(
                    kind="support.escalate",
                    shipment_id=shipment_id,
                    payload={
                        "contact_id": str(contact_id),
                        "communication_id": str(communication_id),
                        "reason": decision.escalate_reason or "customer asked for a person",
                    },
                    dedupe_key=f"escalate:{communication_id}",
                    priority=5,
                ),
            ),
            # Escalating abandons a half-collected order; a person takes over.
            draft=None,
            reason="handed to a human",
        )

    # STATUS and CHITCHAT are answered from the view alone. Nothing to delegate:
    # the reply is the whole action.
    return Delegation(requests=(), draft=_draft_of(decision), reason="answered directly")


def _new_order(
    decision: SupportDecision, contact_id: UUID, communication_id: UUID
) -> Delegation:
    order = decision.order

    if order is None or not order.complete:
        # Still collecting. Keep what we have so the next turn does not ask
        # again, and create nothing.
        return Delegation(
            requests=(),
            draft=_draft_of(decision),
            reason=(
                f"still collecting: {', '.join(order.missing)}"
                if order
                else "no booking details yet"
            ),
        )

    return Delegation(
        requests=(
            WorkRequest(
                kind="support.create_shipment",
                payload={
                    "contact_id": str(contact_id),
                    "communication_id": str(communication_id),
                    "order": order.model_dump(),
                },
                # Keyed on the message: a retried step must not book twice.
                dedupe_key=f"create:{communication_id}",
                priority=5,
            ),
        ),
        draft=None,
        reason="booking details complete",
    )


def _change_request(
    decision: SupportDecision,
    contact_id: UUID,
    communication_id: UUID,
    shipment_id: UUID | None,
) -> Delegation:
    if shipment_id is None:
        # Cannot change a shipment we have not identified. Ask, do not guess —
        # applying a change to the wrong shipment is the worst outcome here.
        return Delegation(
            requests=(),
            draft=_draft_of(decision),
            reason="no shipment identified for the change request",
        )

    assert decision.change is not None  # guaranteed by the schema validator
    return Delegation(
        requests=(
            WorkRequest(
                kind="support.change_request",
                shipment_id=shipment_id,
                payload={
                    "contact_id": str(contact_id),
                    "communication_id": str(communication_id),
                    "kind": decision.change.kind,
                    "detail": decision.change.detail,
                },
                dedupe_key=f"change:{communication_id}",
                priority=5,
            ),
        ),
        draft=_draft_of(decision),
        reason=f"change request: {decision.change.kind}",
    )


def _draft_of(decision: SupportDecision) -> dict | None:
    """Booking state worth carrying to the next turn."""
    if decision.intent is not Intent.NEW_ORDER or decision.order is None:
        return None
    draft = {k: v for k, v in decision.order.model_dump().items() if v is not None}
    draft.pop("ready", None)
    return draft or None
