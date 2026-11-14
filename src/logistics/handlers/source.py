"""carrier.source — open the quote window.

Broadcasts the load to every reachable carrier and stops. SOURCING is a genuine
wait state: API carriers answer within the call, Telegram carriers answer in
forty minutes, in free text, or never. A quote row is written when we *ask*, so
a carrier who never replies shows as an unanswered request rather than as
missing data.

The window closes on a timer, not on everyone replying — because not everyone
replies.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from logistics.carriers.adapter import LoadRequest
from logistics.carriers.api import ApiCarrierAdapter
from logistics.carriers.repo import CarrierRepo, QuoteRepo
from logistics.carriers.telegram import TelegramError
from logistics.domain.events import EventDraft
from logistics.domain.models import StepResult, WorkRequest
from logistics.domain.states import ShipmentState
from logistics.handlers.base import StepContext, handler

QUOTE_WINDOW = timedelta(minutes=45)


def load_from_shipment(shipment) -> LoadRequest:  # noqa: ANN001
    cargo = shipment.cargo or {}
    plan = shipment.plan or {}
    handling = []
    if cargo.get("hazmat") or cargo.get("hazmat_class"):
        handling.append("hazardous")
    if cargo.get("temperature_controlled"):
        handling.append("temperature-controlled")

    return LoadRequest(
        shipment_reference=shipment.reference,
        origin=(shipment.origin or {}).get("city")
        or (shipment.origin or {}).get("warehouse")
        or "?",
        destination=(shipment.destination or {}).get("city") or "?",
        mode=(plan.get("modes") or ["ROAD"])[0],
        weight_kg=float(cargo.get("weight_kg") or 0),
        quantity=cargo.get("quantity"),
        deliver_by=shipment.deadline,
        load_type=plan.get("load_type"),
        special_handling=handling,
    )


@handler("carrier.source")
async def open_quote_window(ctx: StepContext) -> StepResult:
    shipment = ctx.require_shipment()
    load = load_from_shipment(shipment)

    carriers = CarrierRepo(ctx.db)
    quotes = QuoteRepo(ctx.db)
    round_no = await quotes.current_round(shipment.id) + 1

    candidates = await carriers.eligible(load.mode)
    if not candidates:
        # Nothing to ask. An exception rather than a silent wait — a shipment
        # with no reachable carrier is not going to move on its own.
        ctx.log.warning("sourcing.no_carriers", mode=load.mode)
        return StepResult(
            transition=ShipmentState.EXCEPTION,
            events=(
                EventDraft(
                    type="carrier.no_candidates",
                    actor="carrier",
                    payload={"mode": load.mode, "round": round_no},
                ),
            ),
        )

    api = ApiCarrierAdapter()
    telegram = ctx.telegram
    asked, answered, unreachable = 0, 0, []

    for carrier in candidates:
        await quotes.request(
            shipment_id=shipment.id,
            carrier_id=carrier.id,
            round=round_no,
            source=carrier.integration,
        )
        asked += 1

        try:
            if carrier.integration == "API":
                quote = await api.request_quote(carrier, load)
                if quote is not None:
                    await quotes.record(
                        shipment_id=shipment.id, round=round_no,
                        quote=quote, source="API",
                    )
                    answered += 1
            elif telegram is not None:
                # Returns None by design: a person cannot answer synchronously.
                await telegram.request_quote(carrier, load)
            else:
                unreachable.append(carrier.code)
        except TelegramError as exc:
            # Not onboarded, or Telegram refused. Actionable, not fatal — the
            # other carriers still get asked.
            ctx.log.warning("sourcing.unreachable", carrier=carrier.code, error=str(exc))
            unreachable.append(carrier.code)

    closes_at = datetime.now(UTC) + QUOTE_WINDOW
    ctx.log.info(
        "sourcing.opened",
        round=round_no, asked=asked, answered=answered,
        unreachable=len(unreachable), closes_at=closes_at.isoformat(),
    )

    return StepResult(
        transition=ShipmentState.SOURCING,
        events=(
            EventDraft(
                type="carrier.sourcing_opened",
                actor="carrier",
                payload={
                    "round": round_no,
                    "asked": asked,
                    "answered_immediately": answered,
                    "unreachable": unreachable,
                    "closes_at": closes_at.isoformat(),
                },
            ),
        ),
        enqueue=(
            # A timer, not a poll. Fires once when the window shuts, whether or
            # not anyone replied — no reply at all is itself a decision the
            # operator needs to see.
            WorkRequest(
                kind="carrier.close_window",
                shipment_id=shipment.id,
                run_after=closes_at,
                payload={"round": round_no},
                dedupe_key=f"quote-window:{shipment.id}:{round_no}",
            ),
        ),
    )
