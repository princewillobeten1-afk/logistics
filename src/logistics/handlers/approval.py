"""Approval lifecycle steps.

An approval that nobody answers is an operational failure, not a neutral wait:
a truck is idling at a gate while a decision sits unread. These two steps make
that visible and eventually resolve it either way.
"""

from __future__ import annotations

from datetime import UTC, datetime

from logistics.approvals import ApprovalRepo
from logistics.domain.events import EventDraft, EventType
from logistics.domain.models import StepResult, WorkRequest
from logistics.domain.states import ShipmentState
from logistics.handlers.base import StepContext, handler


@handler("approval.escalate")
async def escalate(ctx: StepContext) -> StepResult:
    """Fires when an approval has gone unanswered past its escalation time."""
    shipment = ctx.require_shipment()
    repo = ApprovalRepo(ctx.db)

    approvals = {str(a.id): a for a in await repo.pending()}
    approval = approvals.get(str(ctx.item.payload.get("approval_id")))

    if approval is None:
        # Answered, or already expired. Nothing to chase.
        return StepResult()

    waited = (datetime.now(UTC) - approval.requested_at).total_seconds() / 3600
    ctx.log.warning(
        "approval.unanswered",
        shipment=shipment.reference,
        waited_hours=round(waited, 1),
        expires_at=approval.expires_at.isoformat(),
    )

    return StepResult(
        events=(
            EventDraft(
                type="policy.approval_escalated",
                actor="system",
                payload={
                    "approval_id": str(approval.id),
                    "waited_hours": round(waited, 1),
                    "expires_at": approval.expires_at.isoformat(),
                    "summary": approval.summary,
                },
            ),
        ),
        enqueue=(
            # Check again at expiry, so a never-answered approval resolves
            # rather than leaving the shipment stuck forever.
            WorkRequest(
                kind="approval.expire",
                shipment_id=shipment.id,
                payload={"approval_id": str(approval.id)},
                run_after=approval.expires_at,
                dedupe_key=f"expire:{approval.id}",
            ),
        ),
    )


@handler("approval.expire")
async def expire(ctx: StepContext) -> StepResult:
    """Close out an approval nobody answered in time."""
    shipment = ctx.require_shipment()
    expired = await ApprovalRepo(ctx.db).expire_overdue()

    if not expired:
        return StepResult()

    if shipment.state is not ShipmentState.AWAITING_APPROVAL:
        return StepResult()

    ctx.log.warning("approval.timed_out", shipment=shipment.reference)

    # Back to PLANNED to source again. An expired approval is not a rejection
    # of the shipment, only of this particular booking.
    return StepResult(
        transition=ShipmentState.PLANNED,
        events=(
            EventDraft(
                type=EventType.APPROVAL_DECIDED,
                actor="system",
                payload={"decision": "EXPIRED", "expired": [str(i) for i in expired]},
            ),
        ),
    )


@handler("approval.granted")
async def granted(ctx: StepContext) -> StepResult:
    """Enqueued when a human approves. Moves the shipment on to booking."""
    shipment = ctx.require_shipment()
    payload = ctx.item.payload

    if shipment.state is not ShipmentState.AWAITING_APPROVAL:
        ctx.log.info("approval.granted_ignored", state=str(shipment.state))
        return StepResult()

    return StepResult(
        events=(
            EventDraft(
                type=EventType.APPROVAL_DECIDED,
                actor=f"user:{payload.get('decided_by', 'unknown')}",
                payload={"decision": "APPROVED", "approval_id": payload.get("approval_id")},
            ),
        ),
        enqueue=(
            WorkRequest(
                kind="carrier.book",
                shipment_id=shipment.id,
                payload={
                    "proposed_action_id": payload.get("proposed_action_id"),
                    "round": payload.get("round", 1),
                },
                dedupe_key=f"book:{shipment.id}:{payload.get('round', 1)}",
                priority=10,
            ),
        ),
    )


@handler("approval.refused")
async def refused(ctx: StepContext) -> StepResult:
    """Enqueued when a human rejects. Sources again rather than giving up."""
    shipment = ctx.require_shipment()
    payload = ctx.item.payload

    if shipment.state is not ShipmentState.AWAITING_APPROVAL:
        return StepResult()

    ctx.log.info("approval.refused", shipment=shipment.reference)

    return StepResult(
        transition=ShipmentState.PLANNED,
        events=(
            EventDraft(
                type=EventType.APPROVAL_DECIDED,
                actor=f"user:{payload.get('decided_by', 'unknown')}",
                payload={
                    "decision": "REJECTED",
                    "note": payload.get("note"),
                    "approval_id": payload.get("approval_id"),
                },
            ),
        ),
    )
