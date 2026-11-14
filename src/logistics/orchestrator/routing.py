"""State → next step.

The whole "what should happen next" decision, in a dict. This is the piece a
naive design hands to an LLM planner; it does not need one. The lifecycle is
identical for every shipment, so planning it per-shipment would buy nothing and
cost a model call, a second of latency, and the ability to predict behaviour.

States absent from this table are deliberate waits — the orchestrator does not
advance them. Something external does:

    NEEDS_INFO         a customer reply
    SOURCING           a quote arriving, or the window timer expiring
    AWAITING_APPROVAL  a human decision, or the escalation timer
    BOOKED, IN_TRANSIT a tracking event
    CLOSED/CANCELLED/FAILED   terminal
"""

from __future__ import annotations

from typing import Final

from logistics.domain.states import ShipmentState

STATE_ROUTES: Final[dict[ShipmentState, str]] = {
    ShipmentState.DRAFT: "order.validate",
    ShipmentState.VALIDATED: "warehouse.allocate",
    ShipmentState.ALLOCATED: "planning.plan",
    ShipmentState.PLANNED: "carrier.source",
    ShipmentState.EXCEPTION: "exception.investigate",
    ShipmentState.DELIVERED: "pod.verify",
    ShipmentState.POD_VERIFIED: "shipment.close",
}


def next_step(state: ShipmentState) -> str | None:
    """The work kind to schedule on entering `state`, or None if it waits."""
    return STATE_ROUTES.get(state)
