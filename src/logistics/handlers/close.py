"""shipment.close — the last step."""

from __future__ import annotations

from logistics.domain.events import EventDraft
from logistics.domain.models import StepResult
from logistics.domain.states import ShipmentState
from logistics.handlers.base import StepContext, handler


@handler("shipment.close")
async def close_shipment(ctx: StepContext) -> StepResult:
    shipment = ctx.require_shipment()

    # The goods have shipped, so the hold becomes a drawdown rather than being
    # handed back. Releasing instead would put stock back that has left.
    from logistics.handlers.allocate import get_inventory_source

    consumed = await get_inventory_source().release(shipment.id, consume=True)

    ctx.log.info("shipment.closing", reference=shipment.reference, consumed=consumed)
    return StepResult(
        transition=ShipmentState.CLOSED,
        events=(
            EventDraft(
                type="shipment.closed",
                actor="system",
                payload={"reference": shipment.reference},
            ),
        ),
    )
