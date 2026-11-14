"""exception.investigate — the Exception Management Agent.

Routed from `EXCEPTION` since the state machine was written, and unregistered
until now, so every shipment that hit trouble stranded with a DEAD work item.

Gather deterministically, reason once, propose. It never executes: each
resolution goes through `PolicyEngine.propose`, and phase-1 policy sends
anything with a price to a human. "Execute permitted solutions, request
approval when required" is what the gate does, not something this re-implements.
"""

from __future__ import annotations

from logistics.domain.events import EventDraft, EventType
from logistics.domain.models import StepResult, WorkRequest
from logistics.exception_agent import build_case, investigate, plan_resolution
from logistics.exception_agent.resolve import should_resolve_exception
from logistics.handlers.base import StepContext, handler
from logistics.orchestrator.policy import Decision


@handler("exception.investigate")
async def investigate_exception(ctx: StepContext) -> StepResult:
    shipment = ctx.require_shipment()
    policy = ctx.require_policy()

    case = await build_case(ctx.db, shipment.id)
    if case is None or not case.exceptions:
        # Cleared between detection and investigation — worth handling, since
        # the self-correcting detections do exactly that.
        ctx.log.info("exception.already_clear", reference=shipment.reference)
        return StepResult(
            events=(
                EventDraft(
                    type="exception.no_longer_open",
                    actor="agent:exception",
                    payload={"reference": shipment.reference},
                ),
            )
        )

    investigation = await investigate(
        ctx.require_llm(),
        case,
        shipment_id=shipment.id,
        work_item_id=ctx.item.id,
    )

    if investigation is None:
        # The agent could not read the situation. A human, not a guess.
        ctx.log.error("exception.unresolved", reference=shipment.reference)
        return StepResult(
            events=(
                EventDraft(
                    type="exception.needs_human",
                    actor="agent:exception",
                    payload={
                        "reason": "the exception agent could not produce a usable assessment",
                        "kinds": [e.kind for e in case.exceptions],
                    },
                ),
            )
        )

    plan = plan_resolution(
        investigation,
        shipment_id=shipment.id,
        current_carrier=case.current_carrier,
    )

    ctx.log.info(
        "exception.investigated",
        reference=shipment.reference,
        cause=investigation.cause[:80],
        recommended=str(investigation.recommended.kind),
        confidence=round(investigation.confidence, 2),
        plan=plan.reason,
    )

    events = [
        EventDraft(
            type="exception.investigated",
            actor="agent:exception",
            payload={
                "cause": investigation.cause,
                "impact": investigation.impact,
                "severity": investigation.severity,
                "deadline_at_risk": investigation.deadline_at_risk,
                "recommended": str(investigation.recommended.kind),
                "rationale": investigation.recommended.rationale,
                "options": [
                    {"kind": str(r.kind), "rationale": r.rationale}
                    for r in investigation.resolutions
                ],
                "confidence": investigation.confidence,
            },
        )
    ]

    follow_up: list[WorkRequest] = []
    transition = None

    if plan.escalate:
        events.append(
            EventDraft(
                type="exception.escalated_to_human",
                actor="agent:exception",
                payload={"reason": plan.reason},
            )
        )

    elif plan.action is not None:
        # Propose. Nothing is bought, rerouted or sent by this call — it
        # records what the agent wants and what policy decided about it.
        proposal = await policy.propose(
            shipment_id=shipment.id,
            action=plan.action,
            params=plan.params,
            tier=plan.tier,
            rationale=f"{investigation.cause} — {investigation.recommended.rationale}",
            work_item_id=ctx.item.id,
        )

        events.append(
            EventDraft(
                type=EventType.ACTION_GATED,
                actor="agent:exception",
                payload={
                    "action": plan.action,
                    "decision": str(proposal.result.decision),
                    "reason": proposal.result.reason,
                },
            )
        )

        if proposal.result.decision is Decision.ALLOW:
            transition = plan.transition
        elif proposal.result.decision is Decision.REQUIRE_APPROVAL:
            follow_up.append(
                WorkRequest(
                    kind="exception.await_approval",
                    shipment_id=shipment.id,
                    payload={
                        "proposed_action_id": str(proposal.id),
                        "summary": f"{investigation.cause} — {plan.reason}",
                        "amount_minor": plan.params.get("amount_minor"),
                    },
                    dedupe_key=f"exc-approval:{proposal.id}",
                    priority=5,
                )
            )

    if plan.notify:
        follow_up.append(
            WorkRequest(
                kind="customer.notify",
                shipment_id=shipment.id,
                payload={"message": plan.notify, "reason": "exception update"},
                dedupe_key=f"notify:{shipment.id}:{ctx.item.id}",
                priority=10,
            )
        )

    if should_resolve_exception(investigation):
        from logistics.exceptions import ExceptionRepo

        repo = ExceptionRepo(ctx.db)
        for exc in case.exceptions:
            await repo.resolve_kind(
                shipment.id, exc.kind, resolution="agent confirmed it had cleared"
            )
        # Back to moving; the condition is gone.
        transition = _recovery_state(case)

    return StepResult(
        transition=transition,
        events=tuple(events),
        enqueue=tuple(follow_up),
    )


def _recovery_state(case):  # noqa: ANN001, ANN202
    """Where a shipment goes once its exception clears."""
    from logistics.domain.states import ShipmentState

    # A booked shipment that was moving goes back to moving; one that never
    # left goes back to sourcing. Anything else stays put rather than guessing.
    if case.current_carrier:
        return ShipmentState.IN_TRANSIT
    return ShipmentState.SOURCING


@handler("exception.await_approval")
async def await_approval(ctx: StepContext) -> StepResult:
    """Raise the approval an exception resolution needs.

    Reuses the same `ApprovalRepo` and escalation timer the carrier booking
    path uses, so there is one approval mechanism rather than two.
    """
    from uuid import UUID

    from logistics.approvals import ApprovalRepo

    shipment = ctx.require_shipment()
    payload = ctx.item.payload
    action_id = payload.get("proposed_action_id")
    if not action_id:
        from logistics.handlers.base import PermanentFailure

        raise PermanentFailure("exception.await_approval requires a proposed_action_id")

    approval = await ApprovalRepo(ctx.db).request(
        proposed_action_id=UUID(action_id),
        shipment_id=shipment.id,
        summary=f"{shipment.reference}: {payload.get('summary', 'exception resolution')}",
        amount_minor=payload.get("amount_minor"),
    )

    ctx.log.info("exception.approval_requested", reference=shipment.reference)

    return StepResult(
        events=(
            EventDraft(
                type=EventType.APPROVAL_REQUESTED,
                actor="agent:exception",
                payload={
                    "approval_id": str(approval.id),
                    "summary": approval.summary,
                    "expires_at": approval.expires_at.isoformat(),
                },
            ),
        ),
        enqueue=(
            WorkRequest(
                kind="approval.escalate",
                shipment_id=shipment.id,
                payload={"approval_id": str(approval.id)},
                run_after=approval.escalate_at,
                dedupe_key=f"escalate:{approval.id}",
            ),
        ),
    )
