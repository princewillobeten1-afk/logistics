"""Approval lifecycle steps.

An approval that nobody answers is an operational failure, not a neutral wait:
a truck is idling at a gate while a decision sits unread. These two steps make
that visible and eventually resolve it either way.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from logistics.approvals import ApprovalRepo
from logistics.domain.events import EventDraft, EventType
from logistics.domain.models import StepResult, WorkRequest
from logistics.domain.states import ShipmentState
from logistics.handlers.base import StepContext, handler

_CANCELLABLE_STATES = frozenset(
    {
        ShipmentState.DRAFT,
        ShipmentState.NEEDS_INFO,
        ShipmentState.VALIDATED,
        ShipmentState.ALLOCATED,
        ShipmentState.PLANNED,
        ShipmentState.SOURCING,
        ShipmentState.AWAITING_APPROVAL,
        ShipmentState.BOOKED,
        ShipmentState.EXCEPTION,
    }
)


def is_standard_booking(action_name: str | None, action_params: dict[str, Any]) -> bool:
    """True for a standard carrier sourcing booking (not an exception re-source).

    `exception_agent/resolve.py::RESOURCE_CARRIER` always includes the
    `'replacing'` key in `params` (even when `None`), whereas `close_window.py`
    never sets it.
    """
    return action_name in (None, "book_shipment") and "replacing" not in action_params


def decision_transition(
    action_name: str | None,
    action_params: dict[str, Any],
    current_state: ShipmentState,
    *,
    approved: bool,
    has_booking: bool,
) -> ShipmentState | None:
    """Pure state transition table for `approval.granted`, `approval.refused`,
    and `approval.expire`."""
    if not approved:
        if current_state is not ShipmentState.AWAITING_APPROVAL:
            return None
        if is_standard_booking(action_name, action_params):
            # Re-source with the next carrier rather than giving up.
            return ShipmentState.PLANNED
        if action_name in ("cancel_shipment", "change_delivery_address"):
            return ShipmentState.IN_TRANSIT if has_booking else ShipmentState.EXCEPTION
        # Exception-originated approval (RESOURCE_CARRIER, EXPEDITE, ACCEPT_DELAY):
        # return to EXCEPTION rather than erroneously re-sourcing an in-transit truck.
        return ShipmentState.EXCEPTION

    if is_standard_booking(action_name, action_params):
        # Standard booking stays in AWAITING_APPROVAL until carrier.book confirms.
        return None

    if action_name == "book_shipment" and "replacing" in action_params:
        return (
            ShipmentState.PLANNED
            if current_state in (ShipmentState.AWAITING_APPROVAL, ShipmentState.EXCEPTION)
            else None
        )

    if action_name == "reroute_vehicle":
        return (
            ShipmentState.PLANNED
            if current_state in (ShipmentState.AWAITING_APPROVAL, ShipmentState.EXCEPTION)
            else None
        )

    if action_name in ("send_whatsapp", "send_email", "send_message"):
        if current_state is ShipmentState.AWAITING_APPROVAL:
            return ShipmentState.IN_TRANSIT if has_booking else ShipmentState.PLANNED
        return None

    if action_name == "cancel_shipment":
        return ShipmentState.CANCELLED if current_state in _CANCELLABLE_STATES else None

    if action_name == "change_delivery_address":
        if current_state is ShipmentState.AWAITING_APPROVAL and has_booking:
            return ShipmentState.IN_TRANSIT
        return None

    return None


async def _load_proposed_action(
    ctx: StepContext,
    proposed_action_id: str | None,
    approval_id: str | None,
) -> tuple[str | None, dict[str, Any]]:
    async with ctx.db.connection() as conn:
        if proposed_action_id:
            cur = await conn.execute(
                "SELECT action, params FROM proposed_actions WHERE id = %s",
                (UUID(str(proposed_action_id)),),
            )
            row = await cur.fetchone()
            if row is not None:
                return row["action"], dict(row["params"] or {})
        if approval_id:
            cur = await conn.execute(
                """
                SELECT pa.action, pa.params
                  FROM approvals a
                  JOIN proposed_actions pa ON pa.id = a.proposed_action_id
                 WHERE a.id = %s
                """,
                (UUID(str(approval_id)),),
            )
            row = await cur.fetchone()
            if row is not None:
                return row["action"], dict(row["params"] or {})
    return None, {}


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

    payload = ctx.item.payload
    action_name, action_params = await _load_proposed_action(
        ctx,
        payload.get("proposed_action_id"),
        payload.get("approval_id"),
    )
    transition = decision_transition(
        action_name,
        action_params,
        shipment.state,
        approved=False,
        has_booking=bool(shipment.booking),
    )

    ctx.log.warning("approval.timed_out", shipment=shipment.reference, action=action_name)

    return StepResult(
        transition=transition,
        events=(
            EventDraft(
                type=EventType.APPROVAL_DECIDED,
                actor="system",
                payload={
                    "decision": "EXPIRED",
                    "action": action_name,
                    "expired": [str(i) for i in expired],
                },
            ),
        ),
    )


@handler("approval.granted")
async def granted(ctx: StepContext) -> StepResult:
    """Enqueued when a human approves. Executes or queues the approved action."""
    shipment = ctx.require_shipment()
    payload = ctx.item.payload
    proposed_action_id = payload.get("proposed_action_id")
    approval_id = payload.get("approval_id")

    action_name, action_params = await _load_proposed_action(
        ctx, proposed_action_id, approval_id
    )

    decided_event = EventDraft(
        type=EventType.APPROVAL_DECIDED,
        actor=f"user:{payload.get('decided_by', 'unknown')}",
        payload={
            "decision": "APPROVED",
            "approval_id": approval_id,
            "action": action_name,
        },
    )

    # Standard carrier booking from a sourcing round.
    if is_standard_booking(action_name, action_params):
        if shipment.state is not ShipmentState.AWAITING_APPROVAL:
            ctx.log.info("approval.granted_ignored", state=str(shipment.state))
            return StepResult()

        round_no = payload.get("round", action_params.get("round", 1))
        return StepResult(
            events=(decided_event,),
            enqueue=(
                WorkRequest(
                    kind="carrier.book",
                    shipment_id=shipment.id,
                    payload={
                        "proposed_action_id": proposed_action_id,
                        "round": round_no,
                    },
                    dedupe_key=f"book:{shipment.id}:{round_no}",
                    priority=10,
                ),
            ),
        )

    # Non-booking or exception-originated approvals: mark executed and route
    # according to the approved action type.
    if proposed_action_id:
        async with ctx.db.connection() as conn:
            await conn.execute(
                """
                UPDATE proposed_actions
                   SET state = 'EXECUTED'
                 WHERE id = %s AND state = 'APPROVED'
                """,
                (UUID(str(proposed_action_id)),),
            )

    transition = decision_transition(
        action_name,
        action_params,
        shipment.state,
        approved=True,
        has_booking=bool(shipment.booking),
    )

    if action_name == "book_shipment" and "replacing" in action_params:
        # Exception Agent RESOURCE_CARRIER: re-enter PLANNED so carrier.source
        # runs a fresh sourcing round automatically.
        return StepResult(transition=transition, events=(decided_event,))

    if action_name == "reroute_vehicle":
        return StepResult(
            transition=transition,
            events=(
                decided_event,
                EventDraft(
                    type="shipment.reroute_approved",
                    actor=f"user:{payload.get('decided_by', 'unknown')}",
                    payload=action_params,
                ),
            ),
        )

    if action_name in ("send_whatsapp", "send_email", "send_message"):
        follow_up: list[WorkRequest] = []
        if message := action_params.get("message"):
            follow_up.append(
                WorkRequest(
                    kind="customer.notify",
                    shipment_id=shipment.id,
                    payload={"message": str(message), "reason": "approved notification"},
                    dedupe_key=f"notify-approved:{proposed_action_id or ctx.item.id}",
                    priority=10,
                )
            )
        return StepResult(
            transition=transition,
            events=(decided_event,),
            enqueue=tuple(follow_up),
        )

    if action_name == "cancel_shipment":
        from logistics.handlers.allocate import get_inventory_source

        await get_inventory_source().release(shipment.id, consume=False)
        follow_up = []
        if action_params.get("requested_by") == "customer":
            follow_up.append(
                WorkRequest(
                    kind="customer.notify",
                    shipment_id=shipment.id,
                    payload={
                        "message": f"Your cancellation request for shipment {shipment.reference} has been approved.",
                        "reason": "cancellation approved",
                    },
                    dedupe_key=f"notify-cancel:{proposed_action_id or ctx.item.id}",
                    priority=10,
                )
            )
        return StepResult(
            transition=transition,
            events=(decided_event,),
            enqueue=tuple(follow_up),
        )

    if action_name == "change_delivery_address":
        follow_up = []
        if action_params.get("requested_by") == "customer":
            detail = action_params.get("detail") or "your requested delivery update"
            follow_up.append(
                WorkRequest(
                    kind="customer.notify",
                    shipment_id=shipment.id,
                    payload={
                        "message": (
                            f"Your delivery change request for shipment {shipment.reference} "
                            f"has been approved ({detail})."
                        ),
                        "reason": "delivery change approved",
                    },
                    dedupe_key=f"notify-addr:{proposed_action_id or ctx.item.id}",
                    priority=10,
                )
            )
        return StepResult(
            transition=transition,
            events=(
                decided_event,
                EventDraft(
                    type="shipment.address_change_approved",
                    actor=f"user:{payload.get('decided_by', 'unknown')}",
                    payload=action_params,
                ),
            ),
            enqueue=tuple(follow_up),
        )

    ctx.log.info(
        "approval.granted_recorded",
        action=action_name,
        state=str(shipment.state),
    )
    return StepResult(events=(decided_event,))


@handler("approval.refused")
async def refused(ctx: StepContext) -> StepResult:
    """Enqueued when a human rejects. Routes according to the rejected action."""
    shipment = ctx.require_shipment()
    payload = ctx.item.payload
    proposed_action_id = payload.get("proposed_action_id")
    approval_id = payload.get("approval_id")

    action_name, action_params = await _load_proposed_action(
        ctx, proposed_action_id, approval_id
    )

    is_customer_change = action_name in ("cancel_shipment", "change_delivery_address")
    if shipment.state is not ShipmentState.AWAITING_APPROVAL and not is_customer_change:
        return StepResult()

    transition = decision_transition(
        action_name,
        action_params,
        shipment.state,
        approved=False,
        has_booking=bool(shipment.booking),
    )
    ctx.log.info("approval.refused", shipment=shipment.reference, action=action_name)

    follow_up: list[WorkRequest] = []
    if is_customer_change and action_params.get("requested_by") == "customer":
        kind_label = "cancellation" if action_name == "cancel_shipment" else "delivery change"
        follow_up.append(
            WorkRequest(
                kind="customer.notify",
                shipment_id=shipment.id,
                payload={
                    "message": (
                        f"We could not approve your {kind_label} request for shipment "
                        f"{shipment.reference}. Please reply here if you need assistance."
                    ),
                    "reason": f"{kind_label} rejected",
                },
                dedupe_key=f"notify-refused:{proposed_action_id or approval_id or ctx.item.id}",
                priority=10,
            )
        )

    return StepResult(
        transition=transition,
        events=(
            EventDraft(
                type=EventType.APPROVAL_DECIDED,
                actor=f"user:{payload.get('decided_by', 'unknown')}",
                payload={
                    "decision": "REJECTED",
                    "action": action_name,
                    "note": payload.get("note"),
                    "approval_id": approval_id,
                },
            ),
        ),
        enqueue=tuple(follow_up),
    )
