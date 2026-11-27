"""planning.consolidate — pre-sourcing LTL/LCL/CONSOLIDATED order pooling."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from logistics.domain.models import StepResult
from logistics.handlers.base import StepContext, handler

DEFAULT_TRUCK_MAX_KG = 15_000.0
DEFAULT_TRUCK_MAX_CBM = 45.0
CONSOLIDATABLE_LOAD_TYPES = frozenset({"LTL", "LCL", "CONSOLIDATED"})


@dataclass(frozen=True, slots=True)
class ConsolidationCandidate:
    shipment_id: UUID
    reference: str
    origin_city: str
    destination_city: str
    mode: str
    load_type: str
    weight_kg: float
    volume_cbm: float
    estimated_cost_minor: int = 0
    currency: str = "NGN"


@dataclass(slots=True)
class PlannedPool:
    origin_city: str
    destination_city: str
    mode: str
    load_type: str
    items: list[ConsolidationCandidate] = field(default_factory=list)
    total_weight_kg: float = 0.0
    total_volume_cbm: float = 0.0
    utilization_pct: float = 0.0
    estimated_savings_minor: int = 0
    currency: str = "NGN"


def estimate_volume_cbm(weight_kg: float, cargo: dict | None = None) -> float:
    """Compute cubic metres from cargo dimensions if provided, else volumetric weight proxy."""
    c = cargo or {}
    dims = (c.get("length_cm"), c.get("width_cm"), c.get("height_cm"))
    qty = max(1, int(c.get("quantity") or 1)) if isinstance(c.get("quantity"), int | float) else 1
    if all(isinstance(v, int | float) and not isinstance(v, bool) and v > 0 for v in dims):
        length, width, height = (float(dims[0]), float(dims[1]), float(dims[2]))
        return round((length * width * height * qty) / 1_000_000.0, 4)
    # 333 kg/cbm road volumetric baseline
    return round(max(0.05, float(weight_kg or 100.0) / 333.0), 4)


def plan_consolidation_pools(
    candidates: list[ConsolidationCandidate],
    *,
    max_weight_kg: float = DEFAULT_TRUCK_MAX_KG,
    max_volume_cbm: float = DEFAULT_TRUCK_MAX_CBM,
) -> list[PlannedPool]:
    """Group >= 2 small shipments sharing (origin, destination, mode) within vehicle capacity."""
    by_lane: dict[tuple[str, str, str], list[ConsolidationCandidate]] = {}
    for cand in candidates:
        if cand.load_type not in CONSOLIDATABLE_LOAD_TYPES:
            continue
        origin = cand.origin_city.strip()
        dest = cand.destination_city.strip()
        mode = cand.mode.strip().upper() or "ROAD"
        if not origin or not dest or origin == "?" or dest == "?":
            continue
        by_lane.setdefault((origin.lower(), dest.lower(), mode), []).append(cand)

    pools: list[PlannedPool] = []
    for (_o_key, _d_key, mode), items in by_lane.items():
        if len(items) < 2:
            continue
        sorted_items = sorted(items, key=lambda x: (-x.weight_kg, x.reference))
        current: list[ConsolidationCandidate] = []
        w_sum = 0.0
        v_sum = 0.0

        def _flush(group: list[ConsolidationCandidate], total_w: float, total_v: float) -> None:
            if len(group) < 2:
                return
            w_pct = (total_w / max_weight_kg) * 100.0 if max_weight_kg > 0 else 0.0
            v_pct = (total_v / max_volume_cbm) * 100.0 if max_volume_cbm > 0 else 0.0
            util = round(min(100.0, max(w_pct, v_pct)), 2)
            # Conservatively ~28% cost reduction on combined shipments vs individual dispatches.
            separate_cost = sum(max(0, it.estimated_cost_minor) for it in group)
            savings = round(separate_cost * 0.28) if separate_cost > 0 else (len(group) - 1) * 4_500_000
            load_label = "CONSOLIDATED_LCL" if mode == "SEA" else "CONSOLIDATED_LTL"
            pools.append(
                PlannedPool(
                    origin_city=group[0].origin_city,
                    destination_city=group[0].destination_city,
                    mode=mode,
                    load_type=load_label,
                    items=list(group),
                    total_weight_kg=round(total_w, 3),
                    total_volume_cbm=round(total_v, 4),
                    utilization_pct=util,
                    estimated_savings_minor=savings,
                    currency=group[0].currency or "NGN",
                )
            )

        for item in sorted_items:
            w = max(0.0, float(item.weight_kg))
            v = max(0.0, float(item.volume_cbm))
            if current and (w_sum + w > max_weight_kg or v_sum + v > max_volume_cbm):
                _flush(current, w_sum, v_sum)
                current = [item]
                w_sum = w
                v_sum = v
            else:
                current.append(item)
                w_sum += w
                v_sum += v
        _flush(current, w_sum, v_sum)

    return pools


@handler("planning.consolidate")
async def consolidate_shipments(ctx: StepContext) -> StepResult:
    """Pool eligible LTL/LCL shipments sharing lane + mode before individual sourcing."""
    now = datetime.now(UTC)

    async with ctx.db.transaction() as conn:
        cur = await conn.execute(
            """
            SELECT id, reference, origin, destination, cargo, plan
              FROM shipments
             WHERE state IN ('ALLOCATED', 'PLANNED')
               AND consolidation_group_id IS NULL
             ORDER BY created_at ASC
             LIMIT 100
            """
        )
        rows = await cur.fetchall()

        candidates: list[ConsolidationCandidate] = []
        plans_by_id: dict[UUID, dict] = {}
        for row in rows:
            plan = dict(row["plan"] or {})
            plans_by_id[row["id"]] = plan
            cargo = dict(row["cargo"] or {})
            origin = row["origin"] or {}
            dest = row["destination"] or {}
            weight = float(cargo.get("weight_kg") or 0)
            mode = str((plan.get("modes") or ["ROAD"])[0]).upper()
            load_type = str(
                plan.get("load_type")
                or ("LCL" if mode == "SEA" and weight < 10_000 else "LTL" if weight < 4_000 else "FTL")
            ).upper()
            candidates.append(
                ConsolidationCandidate(
                    shipment_id=row["id"],
                    reference=row["reference"],
                    origin_city=str(origin.get("city") or origin.get("warehouse") or ""),
                    destination_city=str(dest.get("city") or dest.get("address") or ""),
                    mode=mode,
                    load_type=load_type,
                    weight_kg=weight,
                    volume_cbm=estimate_volume_cbm(weight, cargo),
                    estimated_cost_minor=int(plan.get("estimated_cost_minor") or 0),
                    currency=str(plan.get("currency") or "NGN"),
                )
            )

        pools = plan_consolidation_pools(candidates)
        groups_created = 0
        shipments_pooled = 0

        for pool in pools:
            ref = f"POOL-{now.strftime('%m%d')}-{uuid4().hex[:6].upper()}"
            g_cur = await conn.execute(
                """
                INSERT INTO consolidation_groups
                    (reference, origin_city, destination_city, mode, load_type, status,
                     vehicle_capacity_kg, total_weight_kg, total_volume_cbm,
                     utilization_pct, estimated_savings_minor, currency)
                VALUES (%s, %s, %s, %s, %s, 'OPEN', %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    ref,
                    pool.origin_city,
                    pool.destination_city,
                    pool.mode,
                    pool.load_type,
                    DEFAULT_TRUCK_MAX_KG,
                    pool.total_weight_kg,
                    pool.total_volume_cbm,
                    pool.utilization_pct,
                    pool.estimated_savings_minor,
                    pool.currency,
                ),
            )
            group_row = await g_cur.fetchone()
            if group_row is None:
                continue
            group_id = group_row["id"]
            groups_created += 1

            for item in pool.items:
                await conn.execute(
                    """
                    INSERT INTO consolidation_items (group_id, shipment_id, weight_kg, volume_cbm)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (org_id, shipment_id) DO NOTHING
                    """,
                    (group_id, item.shipment_id, item.weight_kg, item.volume_cbm),
                )
                merged_plan = {
                    **plans_by_id.get(item.shipment_id, {}),
                    "consolidation_group_ref": ref,
                    "consolidation_load_type": pool.load_type,
                    "consolidation_utilization_pct": pool.utilization_pct,
                    "consolidation_count": len(pool.items),
                }
                await conn.execute(
                    """
                    UPDATE shipments
                       SET consolidation_group_id = %s,
                           plan = %s
                     WHERE id = %s
                    """,
                    (group_id, Jsonb(merged_plan), item.shipment_id),
                )
                shipments_pooled += 1

    ctx.log.info(
        "planning.consolidated",
        groups_created=groups_created,
        shipments_pooled=shipments_pooled,
    )
    return StepResult()
