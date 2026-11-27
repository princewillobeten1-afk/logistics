from __future__ import annotations

from uuid import uuid4

import pytest

from logistics.domain.models import WorkItem
from logistics.domain.states import ShipmentState
from logistics.handlers import registry
from logistics.handlers.base import StepContext
from logistics.handlers.consolidation import (
    ConsolidationCandidate,
    consolidate_shipments,
    estimate_volume_cbm,
    plan_consolidation_pools,
)
from logistics.handlers.replenishment import (
    compute_holding_cost,
    evaluate_reorder_status,
    replenishment_sweep,
)
from logistics.handlers.returns import (
    can_transition_rma,
    process_return,
    recommend_disposition,
)


def _step_ctx(db, settings, kind: str, payload: dict | None = None, shipment=None) -> StepContext:
    return StepContext(
        item=WorkItem(
            id=uuid4(),
            kind=kind,
            payload=payload or {},
            attempts=1,
            max_attempts=5,
            shipment_id=shipment.id if shipment else None,
        ),
        shipment=shipment,
        db=db,
        settings=settings,
    )


def test_new_handlers_are_registered():
    for kind in ("inventory.replenishment_sweep", "planning.consolidate", "returns.process"):
        assert registry.get(kind) is not None


def test_holding_cost_and_reorder_thresholds():
    metrics = compute_holding_cost(on_hand=100, unit_cost_minor=500_000, annual_holding_rate=0.20)
    assert metrics.inventory_value_minor == 50_000_000
    assert metrics.annual_carrying_minor == 10_000_000
    assert metrics.daily_carrying_minor == round(10_000_000 / 365)

    assert evaluate_reorder_status(available=15, reorder_point=40, safety_stock=20) == (True, "CRITICAL")
    assert evaluate_reorder_status(available=35, reorder_point=40, safety_stock=20) == (True, "REORDER")
    assert evaluate_reorder_status(available=60, reorder_point=40, safety_stock=20) == (False, None)


def test_consolidation_pools_group_matching_ltl_lanes_and_respect_capacity():
    candidates = [
        ConsolidationCandidate(
            shipment_id=uuid4(),
            reference="LG-101",
            origin_city="Lagos",
            destination_city="Abuja",
            mode="ROAD",
            load_type="LTL",
            weight_kg=1200,
            volume_cbm=4.0,
            estimated_cost_minor=15_000_000,
        ),
        ConsolidationCandidate(
            shipment_id=uuid4(),
            reference="LG-102",
            origin_city="Lagos",
            destination_city="Abuja",
            mode="ROAD",
            load_type="LTL",
            weight_kg=1800,
            volume_cbm=6.0,
            estimated_cost_minor=20_000_000,
        ),
        ConsolidationCandidate(
            shipment_id=uuid4(),
            reference="LG-103",
            origin_city="Lagos",
            destination_city="Kano",
            mode="ROAD",
            load_type="LTL",
            weight_kg=900,
            volume_cbm=3.0,
            estimated_cost_minor=12_000_000,
        ),
        ConsolidationCandidate(
            shipment_id=uuid4(),
            reference="LG-104",
            origin_city="Lagos",
            destination_city="Abuja",
            mode="ROAD",
            load_type="FTL",
            weight_kg=9000,
            volume_cbm=25.0,
        ),
    ]

    pools = plan_consolidation_pools(candidates)
    assert len(pools) == 1
    assert {item.reference for item in pools[0].items} == {"LG-101", "LG-102"}
    assert pools[0].total_weight_kg == 3000.0
    assert pools[0].load_type == "CONSOLIDATED_LTL"
    assert pools[0].estimated_savings_minor == round(35_000_000 * 0.28)
    assert estimate_volume_cbm(500, {"length_cm": 100, "width_cm": 100, "height_cm": 100, "quantity": 2}) == 2.0


def test_rma_transitions_and_disposition_rules():
    assert can_transition_rma("RETURN_REQUESTED", "PICKUP_SCHEDULED")
    assert can_transition_rma("INSPECTED", "RESTOCKED")
    assert not can_transition_rma("RETURN_REQUESTED", "CLOSED")

    assert recommend_disposition("CUSTOMER_REMORSE", "sealed box") == ("RESTOCKED", "RESTOCK")
    assert recommend_disposition("DEFECTIVE", "loose power connector") == ("REFURBISHED", "REFURBISH")
    assert recommend_disposition("RECALL", None) == ("SCRAPPED", "SCRAP")
    assert recommend_disposition("WRONG_ITEM", "water damaged carton") == ("SCRAPPED", "SCRAP")


@pytest.mark.asyncio
async def test_replenishment_sweep_proposes_po_idempotently(db, settings):
    async with db.transaction() as conn:
        w_cur = await conn.execute(
            "INSERT INTO warehouses (code, name) VALUES ('LAG-TEST', 'Lagos DC') RETURNING id"
        )
        wh_id = (await w_cur.fetchone())["id"]
        await conn.execute(
            """
            INSERT INTO inventory
                (warehouse_id, sku, on_hand, reserved, safety_stock, reorder_point, reorder_quantity, unit_cost_minor)
            VALUES (%s, 'SKU-LOW', 18, 3, 20, 40, 80, 250000)
            """,
            (wh_id,),
        )

    await replenishment_sweep(_step_ctx(db, settings, "inventory.replenishment_sweep"))
    # Running a second sweep must not duplicate the open replenishment order.
    await replenishment_sweep(_step_ctx(db, settings, "inventory.replenishment_sweep"))

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT warehouse_id, sku, quantity, status, estimated_cost_minor FROM replenishment_orders"
        )
        rows = await cur.fetchall()

    assert len(rows) == 1
    assert rows[0]["sku"] == "SKU-LOW"
    assert rows[0]["status"] == "PROPOSED"
    assert rows[0]["quantity"] >= 80
    assert rows[0]["estimated_cost_minor"] == rows[0]["quantity"] * 250_000


@pytest.mark.asyncio
async def test_planning_consolidate_persists_pool_and_links_shipments(db, repo, settings):
    from psycopg.types.json import Jsonb

    s1 = await repo.create(
        reference="LG-POOL-1",
        state=ShipmentState.PLANNED,
        origin={"city": "Lagos"},
        destination={"city": "Abuja"},
        cargo={"weight_kg": 900, "quantity": 5},
    )
    s2 = await repo.create(
        reference="LG-POOL-2",
        state=ShipmentState.PLANNED,
        origin={"city": "Lagos"},
        destination={"city": "Abuja"},
        cargo={"weight_kg": 1400, "quantity": 8},
    )
    solo = await repo.create(
        reference="LG-SOLO-1",
        state=ShipmentState.PLANNED,
        origin={"city": "Lagos"},
        destination={"city": "Kano"},
        cargo={"weight_kg": 600, "quantity": 3},
    )
    async with db.transaction() as conn:
        await conn.execute(
            "UPDATE shipments SET plan = %s WHERE id = %s",
            (Jsonb({"modes": ["ROAD"], "load_type": "LTL", "estimated_cost_minor": 12_000_000}), s1.id),
        )
        await conn.execute(
            "UPDATE shipments SET plan = %s WHERE id = %s",
            (Jsonb({"modes": ["ROAD"], "load_type": "LTL", "estimated_cost_minor": 18_000_000}), s2.id),
        )
        await conn.execute(
            "UPDATE shipments SET plan = %s WHERE id = %s",
            (Jsonb({"modes": ["ROAD"], "load_type": "LTL", "estimated_cost_minor": 10_000_000}), solo.id),
        )

    await consolidate_shipments(_step_ctx(db, settings, "planning.consolidate"))

    async with db.connection() as conn:
        g_cur = await conn.execute("SELECT * FROM consolidation_groups")
        groups = await g_cur.fetchall()
        s_cur = await conn.execute(
            "SELECT reference, consolidation_group_id, plan FROM shipments ORDER BY reference"
        )
        ships = {r["reference"]: r for r in await s_cur.fetchall()}

    assert len(groups) == 1
    assert groups[0]["origin_city"] == "Lagos"
    assert groups[0]["destination_city"] == "Abuja"
    assert float(groups[0]["total_weight_kg"]) == 2300.0
    assert ships[s1.reference]["consolidation_group_id"] == groups[0]["id"]
    assert ships[s2.reference]["consolidation_group_id"] == groups[0]["id"]
    assert ships[s1.reference]["plan"]["consolidation_group_ref"] == groups[0]["reference"]
    assert ships[solo.reference]["consolidation_group_id"] is None


@pytest.mark.asyncio
async def test_returns_process_restocks_warehouse_inventory(db, settings):
    async with db.transaction() as conn:
        w_cur = await conn.execute(
            "INSERT INTO warehouses (code, name) VALUES ('ABJ-RMA', 'Abuja DC') RETURNING id"
        )
        wh_id = (await w_cur.fetchone())["id"]
        await conn.execute(
            "INSERT INTO inventory (warehouse_id, sku, on_hand, reserved) VALUES (%s, 'SKU-RET', 10, 0)",
            (wh_id,),
        )
        r_cur = await conn.execute(
            """
            INSERT INTO return_authorizations
                (rma_number, warehouse_id, sku, quantity, reason, condition_notes, state)
            VALUES ('RMA-TEST-1', %s, 'SKU-RET', 4, 'CUSTOMER_REMORSE', 'Factory seal intact', 'RECEIVED')
            RETURNING id
            """,
            (wh_id,),
        )
        rma_id = (await r_cur.fetchone())["id"]

    await process_return(_step_ctx(db, settings, "returns.process", {"rma_id": str(rma_id)}))
    await process_return(_step_ctx(db, settings, "returns.process", {"rma_id": str(rma_id)}))

    async with db.connection() as conn:
        r_row = await (
            await conn.execute(
                "SELECT state, disposition, inspected_by FROM return_authorizations WHERE id = %s",
                (rma_id,),
            )
        ).fetchone()
        i_row = await (
            await conn.execute(
                "SELECT on_hand FROM inventory WHERE warehouse_id = %s AND sku = 'SKU-RET'",
                (wh_id,),
            )
        ).fetchone()

    assert r_row["state"] == "RESTOCKED"
    assert r_row["disposition"] == "RESTOCK"
    assert r_row["inspected_by"] == "agent:returns"
    assert i_row["on_hand"] == 14
