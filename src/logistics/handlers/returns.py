"""returns.process — Reverse logistics, RMA inspection, and inventory disposition."""

from __future__ import annotations

from typing import Final
from uuid import UUID

from logistics.domain.models import StepResult
from logistics.handlers.base import StepContext, handler

RETURN_TRANSITIONS: Final[dict[str, frozenset[str]]] = {
    "RETURN_REQUESTED": frozenset({"PICKUP_SCHEDULED", "IN_TRANSIT", "RECEIVED", "RECALLED", "REJECTED"}),
    "PICKUP_SCHEDULED": frozenset({"IN_TRANSIT", "RECEIVED", "REJECTED"}),
    "IN_TRANSIT": frozenset({"RECEIVED", "REJECTED"}),
    "RECEIVED": frozenset({"INSPECTED", "RECALLED"}),
    "INSPECTED": frozenset({"RESTOCKED", "REFURBISHED", "SCRAPPED"}),
    "RESTOCKED": frozenset({"CLOSED"}),
    "REFURBISHED": frozenset({"RESTOCKED", "CLOSED"}),
    "SCRAPPED": frozenset({"CLOSED"}),
    "RECALLED": frozenset({"SCRAPPED", "CLOSED"}),
    "CLOSED": frozenset(),
    "REJECTED": frozenset(),
}


def can_transition_rma(current_state: str, target_state: str) -> bool:
    return target_state in RETURN_TRANSITIONS.get(current_state, frozenset())


def recommend_disposition(reason: str, condition_notes: str | None = None) -> tuple[str, str]:
    """Recommend (target_rma_state, disposition) for inspection outcomes."""
    r = (reason or "").strip().upper()
    notes = (condition_notes or "").lower()
    if any(word in notes for word in ("crushed", "water", "leak", "expired", "shattered", "burn")):
        return ("SCRAPPED", "SCRAP")
    if r in ("DAMAGED", "END_OF_LIFE", "RECALL"):
        return ("SCRAPPED", "SCRAP")
    if r in ("DEFECTIVE", "WARRANTY"):
        return ("REFURBISHED", "REFURBISH")
    return ("RESTOCKED", "RESTOCK")


@handler("returns.process")
async def process_return(ctx: StepContext) -> StepResult:
    """Advance an RMA through its lifecycle and restock good returned inventory."""
    payload = ctx.item.payload or {}
    rma_id_raw = payload.get("rma_id")
    rma_number = payload.get("rma_number")
    target_state = str(payload.get("target_state") or "").upper()
    disposition = payload.get("disposition")
    inspector = str(payload.get("inspector") or "agent:returns")

    if not rma_id_raw and not rma_number:
        return StepResult()

    async with ctx.db.transaction() as conn:
        if rma_id_raw:
            cur = await conn.execute(
                "SELECT * FROM return_authorizations WHERE id = %s",
                (UUID(str(rma_id_raw)),),
            )
        else:
            cur = await conn.execute(
                "SELECT * FROM return_authorizations WHERE rma_number = %s",
                (str(rma_number),),
            )
        rma = await cur.fetchone()
        if rma is None:
            return StepResult()

        current_state = str(rma["state"])
        if not target_state:
            if current_state == "RECEIVED":
                target_state = "INSPECTED"
            elif current_state == "INSPECTED":
                target_state, auto_disp = recommend_disposition(
                    str(rma["reason"]), rma.get("condition_notes")
                )
                disposition = disposition or auto_disp
            else:
                return StepResult()

        if not can_transition_rma(current_state, target_state):
            ctx.log.warning(
                "returns.invalid_transition",
                rma=rma["rma_number"],
                current=current_state,
                target=target_state,
            )
            return StepResult()

        if target_state == "RESTOCKED" and rma["warehouse_id"] is not None:
            await conn.execute(
                """
                INSERT INTO inventory (warehouse_id, sku, on_hand, reserved)
                VALUES (%s, %s, %s, 0)
                ON CONFLICT (warehouse_id, sku) DO UPDATE
                    SET on_hand = inventory.on_hand + EXCLUDED.on_hand
                """,
                (rma["warehouse_id"], rma["sku"], int(rma["quantity"])),
            )

        await conn.execute(
            """
            UPDATE return_authorizations
               SET state = %s,
                   disposition = COALESCE(%s, disposition),
                   inspected_by = CASE WHEN %s IN ('INSPECTED', 'RESTOCKED', 'REFURBISHED', 'SCRAPPED') THEN %s ELSE inspected_by END,
                   inspected_at = CASE WHEN %s IN ('INSPECTED', 'RESTOCKED', 'REFURBISHED', 'SCRAPPED') THEN COALESCE(inspected_at, now()) ELSE inspected_at END,
                   resolved_at = CASE WHEN %s IN ('CLOSED', 'REJECTED') THEN now() ELSE resolved_at END
             WHERE id = %s
            """,
            (
                target_state,
                str(disposition).upper() if disposition else None,
                target_state,
                inspector,
                target_state,
                target_state,
                rma["id"],
            ),
        )

    ctx.log.info(
        "returns.processed",
        rma=rma["rma_number"],
        from_state=current_state,
        to_state=target_state,
    )
    return StepResult()
