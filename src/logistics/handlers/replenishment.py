"""inventory.replenishment_sweep — carrying cost math and automated reorder proposals."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from logistics.domain.models import StepResult, WorkRequest
from logistics.handlers.base import StepContext, handler

DAILY = timedelta(hours=24)


@dataclass(frozen=True, slots=True)
class HoldingCostMetrics:
    inventory_value_minor: int
    annual_carrying_minor: int
    daily_carrying_minor: int


def compute_holding_cost(
    on_hand: int,
    unit_cost_minor: int,
    annual_holding_rate: float = 0.20,
) -> HoldingCostMetrics:
    """Compute valuation plus annual and daily holding cost in minor currency units."""
    qty = max(0, int(on_hand))
    unit = max(0, int(unit_cost_minor))
    rate = max(0.0, float(annual_holding_rate))
    value = qty * unit
    annual = round(value * rate)
    daily = round(annual / 365) if annual > 0 else 0
    return HoldingCostMetrics(
        inventory_value_minor=value,
        annual_carrying_minor=annual,
        daily_carrying_minor=daily,
    )


def evaluate_reorder_status(
    available: int,
    reorder_point: int,
    safety_stock: int,
) -> tuple[bool, str | None]:
    """Return (needs_reorder, severity_or_none) for an inventory stock line."""
    avail = int(available)
    rop = max(0, int(reorder_point))
    safety = max(0, int(safety_stock))
    if avail <= safety:
        return True, "CRITICAL"
    if avail <= rop:
        return True, "REORDER"
    return False, None


@handler("inventory.replenishment_sweep")
async def replenishment_sweep(ctx: StepContext) -> StepResult:
    """Scan warehouse inventory lines at or below reorder point and open PO proposals."""
    created = 0
    now = datetime.now(UTC)

    async with ctx.db.transaction() as conn:
        cur = await conn.execute(
            """
            SELECT i.warehouse_id,
                   w.code AS warehouse_code,
                   i.sku,
                   i.on_hand,
                   i.reserved,
                   (i.on_hand - i.reserved) AS available,
                   i.safety_stock,
                   i.reorder_point,
                   i.reorder_quantity,
                   i.unit_cost_minor,
                   i.currency
              FROM inventory i
              JOIN warehouses w ON w.id = i.warehouse_id
             WHERE w.active
               AND (i.on_hand - i.reserved) <= i.reorder_point
               AND NOT EXISTS (
                 SELECT 1 FROM replenishment_orders r
                  WHERE r.warehouse_id = i.warehouse_id
                    AND r.sku = i.sku
                    AND r.status IN ('PROPOSED', 'APPROVED', 'ORDERED')
               )
             ORDER BY (i.on_hand - i.reserved) ASC
            """
        )
        low_lines = await cur.fetchall()

        for row in low_lines:
            available = int(row["available"])
            reorder_point = int(row["reorder_point"])
            safety_stock = int(row["safety_stock"])
            needs, level = evaluate_reorder_status(available, reorder_point, safety_stock)
            if not needs:
                continue

            target_stock = reorder_point + safety_stock + int(row["reorder_quantity"])
            qty = max(int(row["reorder_quantity"]), target_stock - max(0, available))
            est_cost = qty * int(row["unit_cost_minor"] or 0)
            ref = f"RPL-{now.strftime('%m%d')}-{uuid4().hex[:6].upper()}"
            reason = (
                f"{level}: available {available} <= "
                f"{'safety stock ' + str(safety_stock) if level == 'CRITICAL' else 'reorder point ' + str(reorder_point)} "
                f"at {row['warehouse_code']}"
            )
            await conn.execute(
                """
                INSERT INTO replenishment_orders
                    (reference, warehouse_id, sku, quantity, estimated_cost_minor, currency, reason, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, 'PROPOSED')
                ON CONFLICT (org_id, warehouse_id, sku)
                    WHERE status IN ('PROPOSED', 'APPROVED', 'ORDERED') DO NOTHING
                """,
                (
                    ref,
                    row["warehouse_id"],
                    row["sku"],
                    qty,
                    est_cost,
                    row["currency"] or "NGN",
                    reason,
                ),
            )
            created += 1

    ctx.log.info("inventory.replenishment_swept", proposals_created=created)

    if ctx.item.payload.get("recurring"):
        next_at = now + DAILY
        return StepResult(
            enqueue=(
                WorkRequest(
                    kind="inventory.replenishment_sweep",
                    payload={"recurring": True},
                    run_after=next_at,
                    dedupe_key=f"replenish:{int(next_at.timestamp() // 3600)}",
                    priority=220,
                ),
            )
        )
    return StepResult()
