"""Turning a resolution into orchestrator work.

Pure — no model, no database, no clock. This is the layer that decides whether
an agent's reasoning becomes an action, so it is worth being able to test the
whole table by passing an investigation in and reading the requests out.

Nothing here executes. Each resolution becomes a proposal for the policy gate,
or a transition the orchestrator validates.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from logistics.domain.states import ShipmentState
from logistics.exception_agent.reason import Investigation, Resolution, ResolutionKind


@dataclass(frozen=True, slots=True)
class ResolutionPlan:
    """What the agent wants to happen. The gate still decides."""

    action: str | None
    """Policy action to propose, or None when nothing needs gating."""
    params: dict[str, Any] = field(default_factory=dict)
    tier: int = 2
    transition: ShipmentState | None = None
    notify: str | None = None
    escalate: bool = False
    reason: str = ""


# Re-sourcing and expediting spend money, so they are tier 3 and hit the spend
# caps. Notifying and accepting a delay do not, but a customer message is still
# irreversible socially, so it stays gated at tier 2.
_TIER = {
    ResolutionKind.RESOURCE_CARRIER: 3,
    ResolutionKind.EXPEDITE: 3,
    ResolutionKind.NOTIFY_CUSTOMER: 2,
    ResolutionKind.ACCEPT_DELAY: 2,
}


def plan_resolution(
    investigation: Investigation, *, shipment_id: UUID, current_carrier: str | None
) -> ResolutionPlan:
    """Map the recommended resolution to something the orchestrator can carry out."""
    resolution: Resolution = investigation.recommended
    kind = resolution.kind

    if kind is ResolutionKind.NO_ACTION:
        return ResolutionPlan(
            action=None,
            reason="the condition has cleared; nothing to do",
        )

    if kind is ResolutionKind.ESCALATE:
        return ResolutionPlan(
            action=None,
            escalate=True,
            notify=investigation.customer_message,
            reason=f"needs a person: {resolution.rationale}",
        )

    if kind is ResolutionKind.RESOURCE_CARRIER:
        return ResolutionPlan(
            action="book_shipment",
            params={
                "amount_minor": resolution.estimated_cost_minor,
                "currency": "NGN",
                "carrier_code": resolution.carrier_code,
                "carrier_approved": True,
                "replacing": current_carrier,
                "reason": resolution.rationale,
            },
            tier=_TIER[kind],
            # Back to PLANNED so the standard route re-runs carrier.source,
            # rather than this handler reaching around the orchestrator.
            transition=ShipmentState.PLANNED,
            notify=investigation.customer_message,
            reason=f"re-source to {resolution.carrier_code}",
        )

    if kind is ResolutionKind.EXPEDITE:
        return ResolutionPlan(
            action="reroute_vehicle",
            params={
                "amount_minor": resolution.estimated_cost_minor,
                "currency": "NGN",
                "carrier_code": current_carrier,
                "reason": resolution.rationale,
            },
            tier=_TIER[kind],
            notify=investigation.customer_message,
            reason="expedite with the current carrier",
        )

    # ACCEPT_DELAY and NOTIFY_CUSTOMER: nothing is bought, but the customer is
    # told. A message cannot be unsent, so it is still proposed rather than
    # simply done.
    return ResolutionPlan(
        action="send_whatsapp" if investigation.customer_message else None,
        params={
            "reason": resolution.rationale,
            "message": investigation.customer_message,
        },
        tier=_TIER.get(kind, 2),
        notify=investigation.customer_message,
        reason=(
            "accept the delay and tell the customer"
            if kind is ResolutionKind.ACCEPT_DELAY
            else "keep the customer informed"
        ),
    )


def should_resolve_exception(investigation: Investigation) -> bool:
    """Whether the exception rows can be closed now.

    Only when the agent is confident nothing is wrong any more. Everything else
    stays open until the condition actually clears, so an exception is never
    closed by having been discussed.
    """
    return (
        investigation.recommended.kind is ResolutionKind.NO_ACTION
        and investigation.confidence >= 0.7
    )
