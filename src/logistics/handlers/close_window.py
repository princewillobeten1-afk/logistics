"""carrier.close_window — where the money decision actually gets made.

This is the dead-end that stranded every shipment reaching SOURCING. It closes
the quote window on a timer, scores whoever answered, and hands the winner to
the policy gate. It never books anything itself: the agent proposes, policy
decides, and a separate step executes.

The gate's three answers map to three different shipment outcomes, and all
three are real:

    ALLOW             → book it
    REQUIRE_APPROVAL  → AWAITING_APPROVAL, with a token a human must use
    DENY              → try another round, or give up and raise an exception
"""

from __future__ import annotations

from datetime import UTC, datetime

from logistics.approvals import ApprovalRepo
from logistics.carriers.repo import CarrierRepo, QuoteRepo
from logistics.carriers.scoring import Excluded, explain, score_quotes, slack_ratio
from logistics.domain.events import EventDraft, EventType
from logistics.domain.money import CurrencyConverter
from logistics.domain.models import StepResult, WorkRequest
from logistics.domain.states import ShipmentState
from logistics.handlers.base import StepContext, handler
from logistics.orchestrator.policy import Decision

# Give up after this many sourcing rounds rather than looping forever.
MAX_ROUNDS = 3


@handler("carrier.close_window")
async def close_window(ctx: StepContext) -> StepResult:
    shipment = ctx.require_shipment()
    policy = ctx.require_policy()
    round_no = int(ctx.item.payload.get("round") or 1)

    quotes = QuoteRepo(ctx.db)
    carriers = CarrierRepo(ctx.db)

    expired = await quotes.expire_outstanding(shipment.id, round_no)
    usable = await quotes.usable(shipment.id, round_no)

    ctx.log.info(
        "sourcing.window_closed", round=round_no, usable=len(usable), expired=expired
    )

    if not usable:
        return _nothing_usable(shipment, round_no, expired)

    # Scoring is canonical here, in Python. The dashboard renders what this
    # writes rather than recomputing it, so the score that spends money is the
    # score on the screen.
    loaded = await policy.active()
    rules = loaded[1] if loaded else {}
    base_currency = rules.get("base_currency", "NGN")

    # How much room the schedule has left. On a tight deadline an unreliable
    # carrier is excluded rather than discounted — see carriers/scoring.py.
    hours_left = None
    if shipment.deadline is not None:
        deadline = shipment.deadline
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=UTC)
        hours_left = (deadline - datetime.now(UTC)).total_seconds() / 3600

    slack = slack_ratio((shipment.plan or {}).get("transit_hours"), hours_left)
    excluded: list[Excluded] = []

    scored = await score_quotes(
        usable,
        await carriers.signals(),
        converter=CurrencyConverter(ctx.db),
        base_currency=base_currency,
        fx_max_age_hours=rules.get("fx_max_age_hours"),
        slack=slack,
        excluded=excluded,
    )

    if excluded:
        ctx.log.info(
            "sourcing.excluded",
            slack=round(slack, 3) if slack is not None else None,
            carriers=[e.carrier_code for e in excluded],
        )

    if not scored:
        # Quotes existed but none could be priced in the base currency.
        # Failing closed, exactly as the policy gate does.
        ctx.log.error("sourcing.unpriceable", round=round_no, quotes=len(usable))
        return _nothing_usable(shipment, round_no, expired, reason="no quote could be priced")

    for entry in scored:
        await quotes.save_score(
            shipment.id, entry.quote.carrier_id, round_no,
            entry.score, entry.breakdown.as_json(),
        )

    winner, *runners_up = scored
    await quotes.select(shipment.id, winner.quote.carrier_id, round_no)

    assert winner.normalised_cost is not None
    rationale = explain(winner, runners_up, excluded)

    # Propose. Nothing is booked by this call — it records what the system
    # wants and what policy decided about it.
    proposal = await policy.propose(
        shipment_id=shipment.id,
        action="book_shipment",
        params={
            "amount_minor": winner.normalised_cost.amount_minor,
            "currency": winner.normalised_cost.currency,
            "carrier_code": winner.signals.code,
            "carrier_id": str(winner.quote.carrier_id),
            "carrier_approved": True,
            "round": round_no,
            "score": round(winner.score, 4),
        },
        tier=3,
        rationale=rationale,
        work_item_id=ctx.item.id,
    )

    decision_event = EventDraft(
        type=EventType.ACTION_GATED,
        actor="carrier",
        payload={
            "round": round_no,
            "carrier": winner.signals.code,
            "amount": winner.normalised_cost.format(),
            "score": round(winner.score, 4),
            "considered": len(scored),
            "decision": str(proposal.result.decision),
            "reason": proposal.result.reason,
            "rationale": rationale,
        },
    )

    if proposal.result.decision is Decision.ALLOW:
        return StepResult(
            events=(decision_event,),
            enqueue=(
                WorkRequest(
                    kind="carrier.book",
                    shipment_id=shipment.id,
                    payload={"proposed_action_id": str(proposal.id), "round": round_no},
                    dedupe_key=f"book:{shipment.id}:{round_no}",
                    priority=10,
                ),
            ),
        )

    if proposal.result.decision is Decision.REQUIRE_APPROVAL:
        approval = await ApprovalRepo(ctx.db).request(
            proposed_action_id=proposal.id,
            shipment_id=shipment.id,
            summary=(
                f"Book {winner.signals.code} for {shipment.reference} at "
                f"{winner.normalised_cost.format()} — {rationale}"
            ),
            amount_minor=winner.normalised_cost.amount_minor,
            currency=winner.normalised_cost.currency,
        )
        ctx.log.info("sourcing.approval_requested", token=approval.token[:8])

        return StepResult(
            transition=ShipmentState.AWAITING_APPROVAL,
            events=(
                decision_event,
                EventDraft(
                    type=EventType.APPROVAL_REQUESTED,
                    actor="carrier",
                    payload={
                        "approval_id": str(approval.id),
                        "expires_at": approval.expires_at.isoformat(),
                        "summary": approval.summary,
                    },
                ),
            ),
            enqueue=(
                # An unanswered approval is itself an operational failure.
                WorkRequest(
                    kind="approval.escalate",
                    shipment_id=shipment.id,
                    payload={"approval_id": str(approval.id)},
                    run_after=approval.escalate_at,
                    dedupe_key=f"escalate:{approval.id}",
                ),
            ),
        )

    # DENY.
    return _denied(shipment, round_no, proposal.result.reason, decision_event)


def _nothing_usable(
    shipment, round_no: int, expired: int, reason: str = "no usable quotes"  # noqa: ANN001
) -> StepResult:
    """No price to act on. Reopen sourcing, or stop trying."""
    event = EventDraft(
        type="carrier.window_empty",
        actor="carrier",
        payload={"round": round_no, "expired": expired, "reason": reason},
    )

    if round_no >= MAX_ROUNDS:
        return StepResult(
            transition=ShipmentState.EXCEPTION,
            events=(
                event,
                EventDraft(
                    type="carrier.sourcing_exhausted",
                    actor="carrier",
                    payload={"rounds": round_no, "reason": reason},
                ),
            ),
        )

    # Back to PLANNED so the standard route re-runs carrier.source for the
    # next round, rather than this handler reaching around the orchestrator.
    return StepResult(transition=ShipmentState.PLANNED, events=(event,))


def _denied(shipment, round_no: int, reason: str, decision_event: EventDraft) -> StepResult:  # noqa: ANN001
    if round_no >= MAX_ROUNDS:
        return StepResult(
            transition=ShipmentState.EXCEPTION,
            events=(
                decision_event,
                EventDraft(
                    type="carrier.sourcing_exhausted",
                    actor="policy",
                    payload={"rounds": round_no, "reason": reason},
                ),
            ),
        )
    return StepResult(transition=ShipmentState.PLANNED, events=(decision_event,))
