"""warehouse.allocate — no model involved.

Allocation is a constraint problem with a correct answer. The interesting part
is not "who has stock" but the trade-off the brief poses:

    Warehouse A: 100 units, 480 km away, dispatches in 8 hours
    Warehouse B: 100 units, 120 km away, dispatches in 16 hours
    → Use B only if the deadline can still be met. Otherwise A.

Nearest is usually cheapest, but nearest is not fastest when its dispatch lead
is long. So the rule is: filter to warehouses that can actually make the
deadline, then pick the nearest of those. Only if none can make it does speed
override distance.

A language model would be slower, costlier, occasionally wrong, and could not
explain itself as precisely as `rationale` below.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime

from logistics.domain.events import EventDraft, EventType
from logistics.domain.models import StepResult, WorkRequest
from logistics.domain.states import ShipmentState
from logistics.handlers.base import StepContext, handler
from logistics.inventory import (
    ROAD_AVG_KPH,
    InMemoryInventory,
    InventorySource,
    StockLine,
)

_inventory: InventorySource = InMemoryInventory()


def set_inventory_source(source: InventorySource) -> None:
    """Swap the source. Tests use the in-memory stub; the app wires Postgres."""
    global _inventory
    _inventory = source


def get_inventory_source() -> InventorySource:
    return _inventory


@dataclass(frozen=True, slots=True)
class AllocationPlan:
    lines: list[dict] = field(default_factory=list)
    shortfall: int = 0
    meets_deadline: bool | None = None
    """None when no deadline was given or distances are unknown."""
    rationale: str = ""

    @property
    def allocated(self) -> int:
        return sum(entry["quantity"] for entry in self.lines)


def _feasible(line: StockLine, hours_available: float | None, kph: float) -> bool:
    """Can this warehouse still make the deadline?

    Unknown distance counts as feasible — refusing to allocate because a
    warehouse has no coordinates would be worse than allocating optimistically
    and letting tracking catch the slip.
    """
    if hours_available is None:
        return True
    hours = line.hours_to_deliver(kph)
    return hours is None or hours <= hours_available


def plan_allocation(
    lines: list[StockLine],
    needed: int,
    preferred: str | None = None,
    *,
    hours_available: float | None = None,
    kph: float = ROAD_AVG_KPH,
) -> AllocationPlan:
    """Decide where the stock comes from. Pure, so it is trivially testable."""
    if needed <= 0:
        return AllocationPlan(rationale="nothing to allocate")

    whole = [line for line in lines if line.available >= needed]
    if whole:
        return _single(whole, needed, preferred, hours_available, kph)
    return _split(lines, needed, preferred, hours_available, kph)


def _single(
    candidates: list[StockLine],
    needed: int,
    preferred: str | None,
    hours_available: float | None,
    kph: float,
) -> AllocationPlan:
    on_time = [line for line in candidates if _feasible(line, hours_available, kph)]

    if on_time:
        # Among warehouses that make the deadline, nearest wins — distance is
        # the cost proxy. The named origin breaks ties.
        on_time.sort(
            key=lambda line: (
                line.warehouse != preferred,
                line.distance_km if line.distance_km is not None else float("inf"),
                -line.available,
            )
        )
        chosen = on_time[0]
        reason = (
            f"{chosen.warehouse} can fill the order and meet the deadline"
            if hours_available is not None
            else f"{chosen.warehouse} can fill the order outright"
        )
        return AllocationPlan(
            lines=[{"warehouse": chosen.warehouse, "quantity": needed}],
            meets_deadline=True if hours_available is not None else None,
            rationale=reason,
        )

    # Nothing makes it. Take the fastest and flag the miss rather than
    # silently picking the nearest and arriving late.
    fastest = min(
        candidates,
        key=lambda line: line.hours_to_deliver(kph) or float("inf"),
    )
    hours = fastest.hours_to_deliver(kph)
    return AllocationPlan(
        lines=[{"warehouse": fastest.warehouse, "quantity": needed}],
        meets_deadline=False,
        rationale=(
            f"no warehouse can meet the deadline; {fastest.warehouse} is fastest "
            f"at {hours:.1f}h against {hours_available:.1f}h available"
            if hours is not None and hours_available is not None
            else f"no warehouse can meet the deadline; {fastest.warehouse} is fastest"
        ),
    )


def _split(
    lines: list[StockLine],
    needed: int,
    preferred: str | None,
    hours_available: float | None,
    kph: float,
) -> AllocationPlan:
    """Split across sites. Deadline-feasible warehouses are drawn down first."""
    ordered = sorted(
        lines,
        key=lambda line: (
            not _feasible(line, hours_available, kph),
            line.warehouse != preferred,
            -line.available,
        ),
    )

    remaining = needed
    allocation: list[dict] = []
    all_on_time = True
    for line in ordered:
        if remaining <= 0:
            break
        take = min(line.available, remaining)
        if take > 0:
            allocation.append({"warehouse": line.warehouse, "quantity": take})
            remaining -= take
            if not _feasible(line, hours_available, kph):
                all_on_time = False

    return AllocationPlan(
        lines=allocation,
        shortfall=max(0, remaining),
        meets_deadline=(
            None if hours_available is None else (all_on_time and remaining == 0)
        ),
        rationale=(
            f"split across {len(allocation)} warehouse(s); "
            f"{needed - remaining} of {needed} units available"
        ),
    )


def _hours_until(deadline: datetime | None) -> float | None:
    if deadline is None:
        return None
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=UTC)
    return (deadline - datetime.now(UTC)).total_seconds() / 3600


@handler("warehouse.allocate")
async def allocate(ctx: StepContext) -> StepResult:
    shipment = ctx.require_shipment()
    cargo = shipment.cargo or {}
    sku = cargo.get("sku", "DEFAULT")
    needed = int(cargo.get("quantity") or 0)
    preferred = (shipment.origin or {}).get("warehouse")

    destination = None
    dest = shipment.destination or {}
    if dest.get("latitude") is not None and dest.get("longitude") is not None:
        destination = (float(dest["latitude"]), float(dest["longitude"]))

    lines = await _inventory.availability(sku, destination=destination)
    plan = plan_allocation(
        lines,
        needed,
        preferred,
        hours_available=_hours_until(shipment.deadline),
    )

    if plan.shortfall > 0:
        # A genuine operational exception: the order cannot be filled. One of
        # the few places that legitimately wakes a reasoning agent.
        ctx.log.warning("allocate.short", needed=needed, available=plan.allocated)
        return StepResult(
            transition=ShipmentState.EXCEPTION,
            events=(
                EventDraft(
                    type=EventType.ALLOCATION_SHORT,
                    actor="warehouse",
                    payload={
                        "sku": sku,
                        "needed": needed,
                        "available": plan.allocated,
                        "shortfall": plan.shortfall,
                        "by_warehouse": plan.lines,
                        "rationale": plan.rationale,
                    },
                ),
            ),
        )

    # Take the stock. Until this landed, allocation emitted
    # `warehouse.allocation_reserved` while reserving nothing, so two shipments
    # could be allocated the same pallet and both believe they had it.
    reservation = await _inventory.reserve(shipment.id, sku, plan.lines)

    if not reservation.ok:
        # Someone took it between planning and reserving. Re-plan rather than
        # proceed on stock we do not have.
        ctx.log.warning("allocate.reservation_lost", reason=reservation.reason)
        return StepResult(
            events=(
                EventDraft(
                    type="warehouse.reservation_lost",
                    actor="warehouse",
                    payload={"sku": sku, "reason": reservation.reason},
                ),
            ),
            enqueue=(
                WorkRequest(
                    kind="warehouse.allocate",
                    shipment_id=shipment.id,
                    dedupe_key=f"realloc:{shipment.id}:{ctx.item.id}",
                    priority=10,
                ),
            ),
        )

    if plan.meets_deadline is False:
        # Stock exists but not in time. Worth an exception now rather than a
        # missed delivery later — the Exception Agent can expedite or re-plan.
        ctx.log.warning("allocate.deadline_at_risk", rationale=plan.rationale)
        return StepResult(
            transition=ShipmentState.EXCEPTION,
            patch={"allocation": _allocation_payload(sku, needed, plan)},
            events=(
                EventDraft(
                    type="warehouse.deadline_at_risk",
                    actor="warehouse",
                    payload={"sku": sku, "quantity": needed,
                             "lines": plan.lines, "rationale": plan.rationale},
                ),
            ),
        )

    return StepResult(
        transition=ShipmentState.ALLOCATED,
        patch={"allocation": _allocation_payload(sku, needed, plan)},
        events=(
            EventDraft(
                type=EventType.ALLOCATION_RESERVED,
                actor="warehouse",
                payload={"sku": sku, "quantity": needed,
                         "lines": plan.lines, "rationale": plan.rationale},
            ),
        ),
    )


def _allocation_payload(sku: str, needed: int, plan: AllocationPlan) -> dict:
    return {
        "sku": sku,
        "quantity": needed,
        "lines": plan.lines,
        "meets_deadline": plan.meets_deadline,
        "rationale": plan.rationale,
    }
