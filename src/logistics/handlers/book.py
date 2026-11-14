"""carrier.book — the first real money path.

Everything upstream proposes; this is the only place that commits. Three
guards, in order, and none of them is optional:

  1. **The proposed action must be APPROVED or ALLOW-gated.** A booking with no
     decision behind it is refused outright.
  2. **The tender goes through the idempotent executor.** A retry after a
     timeout reconciles rather than tendering twice.
  3. **The amount is re-read from the quote**, never from the work item
     payload. A payload is a message; the quote row is the record.
"""

from __future__ import annotations

from uuid import UUID

from logistics.carriers.api import ApiCarrierAdapter
from logistics.carriers.repo import CarrierRepo, QuoteRepo
from logistics.domain.events import EventDraft
from logistics.domain.models import StepResult
from logistics.domain.states import ShipmentState
from logistics.handlers.base import PermanentFailure, StepContext, handler
from logistics.handlers.source import load_from_shipment
from logistics.tools import NeedsReconciliation, ToolError, ToolExecutor, idempotency_key


@handler("carrier.book")
async def book(ctx: StepContext) -> StepResult:
    shipment = ctx.require_shipment()
    payload = ctx.item.payload
    round_no = int(payload.get("round") or 1)
    action_id = payload.get("proposed_action_id")

    if not action_id:
        raise PermanentFailure("carrier.book requires a proposed_action_id")

    decision = await _action_state(ctx, UUID(action_id))
    if decision is None:
        raise PermanentFailure(f"proposed action {action_id} does not exist")

    state, policy_decision = decision
    if state not in ("APPROVED",) and policy_decision != "ALLOW":
        # The gate is the whole point. Nothing books without it.
        raise PermanentFailure(
            f"refusing to book: proposed action is {state}/{policy_decision}, "
            "not APPROVED or policy-ALLOW"
        )

    quotes = QuoteRepo(ctx.db)
    selected = await quotes.selected(shipment.id, round_no)
    if selected is None:
        raise PermanentFailure(f"no SELECTED quote for round {round_no}")

    carrier = await CarrierRepo(ctx.db).get(selected["carrier_id"])
    if carrier is None:
        raise PermanentFailure(f"carrier {selected['carrier_id']} no longer exists")

    load = load_from_shipment(shipment)

    # Stable across retries of this booking, distinct across different ones.
    # Deliberately excludes attempt counters and timestamps — including them
    # would make every retry a fresh call, which is exactly the bug.
    key = idempotency_key(
        "book_shipment", shipment.id, round_no, carrier.id, selected["amount_minor"]
    )

    adapter = ApiCarrierAdapter() if carrier.integration == "API" else ctx.telegram
    if adapter is None:
        raise PermanentFailure(
            f"no adapter available for {carrier.integration} carrier {carrier.code}"
        )

    from logistics.carriers.adapter import Quote, QuoteState
    from logistics.domain.money import Money

    quote = Quote(
        carrier_id=carrier.id,
        state=QuoteState.SELECTED,
        price=Money(int(selected["amount_minor"]), selected["currency"]),
        transit_hours=float(selected["transit_hours"]) if selected["transit_hours"] else None,
    )

    async def _tender() -> dict:
        result = await adapter.tender(carrier, load, quote, key)
        return {
            "accepted": result.accepted,
            "booking_ref": result.booking_ref,
            "vehicle": result.vehicle,
            "driver": result.driver,
            "pickup_at": result.pickup_at.isoformat() if result.pickup_at else None,
            "message": result.message,
            "carrier_code": carrier.code,
        }

    executor = ToolExecutor(ctx.db)
    try:
        outcome = await executor.execute(
            key=key,
            tool="book_shipment",
            tier=3,
            request={
                "shipment": shipment.reference,
                "carrier": carrier.code,
                "amount_minor": selected["amount_minor"],
                "currency": selected["currency"],
                "round": round_no,
            },
            call=_tender,
            shipment_id=shipment.id,
        )
    except NeedsReconciliation as exc:
        # A previous attempt reached the carrier and we never saw the outcome.
        # Retrying could double-book, so this stops and asks for a human.
        ctx.log.error("book.needs_reconciliation", key=key[:16])
        raise PermanentFailure(str(exc)) from exc
    except ToolError as exc:
        # The call definitively failed; nothing committed. Safe to retry.
        ctx.log.warning("book.failed", error=str(exc))
        raise

    response = outcome.response
    await _mark_executed(ctx, UUID(action_id), key)

    if not response.get("accepted"):
        # Telegram tenders are not acceptances: the carrier has been messaged
        # and must confirm. Recording this as BOOKED would be the platform
        # lying to itself about a commitment that does not exist.
        ctx.log.info("book.awaiting_confirmation", carrier=carrier.code)
        return StepResult(
            events=(
                EventDraft(
                    type="carrier.tender_sent",
                    actor="carrier",
                    payload={**response, "replayed": outcome.replayed},
                ),
            ),
        )

    ctx.log.info(
        "book.confirmed",
        carrier=carrier.code,
        booking_ref=response.get("booking_ref"),
        replayed=outcome.replayed,
    )

    return StepResult(
        transition=ShipmentState.BOOKED,
        patch={
            "booking": {
                "carrier_code": carrier.code,
                "carrier_id": str(carrier.id),
                "booking_ref": response.get("booking_ref"),
                "vehicle": response.get("vehicle"),
                "driver": response.get("driver"),
                "pickup_at": response.get("pickup_at"),
                "amount_minor": selected["amount_minor"],
                "currency": selected["currency"],
                "round": round_no,
            }
        },
        events=(
            EventDraft(
                type="carrier.booked",
                actor="carrier",
                payload={**response, "replayed": outcome.replayed},
            ),
        ),
    )


async def _action_state(ctx: StepContext, action_id: UUID) -> tuple[str, str] | None:
    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            "SELECT state, policy_decision FROM proposed_actions WHERE id = %s",
            (action_id,),
        )
        row = await cur.fetchone()
    return (row["state"], row["policy_decision"]) if row else None


async def _mark_executed(ctx: StepContext, action_id: UUID, key: str) -> None:
    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            "SELECT id FROM tool_calls WHERE idempotency_key = %s", (key,)
        )
        row = await cur.fetchone()
        await conn.execute(
            """
            UPDATE proposed_actions
               SET state = 'EXECUTED', tool_call_id = %s
             WHERE id = %s AND state IN ('PROPOSED', 'APPROVED')
            """,
            (row["id"] if row else None, action_id),
        )
