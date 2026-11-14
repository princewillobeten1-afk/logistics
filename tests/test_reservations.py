"""Inventory reservation.

Until this existed, `warehouse.allocate` emitted `allocation_reserved` while
reserving nothing. Two shipments could be allocated the same pallet and both
would believe they had it.
"""

from __future__ import annotations

import asyncio
from uuid import uuid4

from logistics.inventory import PostgresInventory

SKU = "DEFAULT"


async def _stock(db, code: str, quantity: int) -> None:
    """A warehouse with a known quantity on hand."""
    async with db.connection() as conn:
        cur = await conn.execute(
            "INSERT INTO locations (type, name, code, city) "
            " VALUES ('WAREHOUSE', %s, %s, %s) "
            " ON CONFLICT (org_id, type, code) WHERE code IS NOT NULL DO UPDATE"
            "   SET name = EXCLUDED.name RETURNING id",
            (code, code, code),
        )
        location = (await cur.fetchone())["id"]
        cur = await conn.execute(
            "INSERT INTO warehouses (code, name, location_id) VALUES (%s, %s, %s)"
            " ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id",
            (code, code, location),
        )
        warehouse = (await cur.fetchone())["id"]
        await conn.execute(
            "INSERT INTO inventory (warehouse_id, sku, on_hand, reserved)"
            " VALUES (%s, %s, %s, 0)"
            " ON CONFLICT (warehouse_id, sku) DO UPDATE"
            "   SET on_hand = EXCLUDED.on_hand, reserved = 0",
            (warehouse, SKU, quantity),
        )


async def _levels(db, code: str) -> tuple[int, int]:
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT i.on_hand, i.reserved FROM inventory i"
            " JOIN warehouses w ON w.id = i.warehouse_id WHERE w.code = %s",
            (code,),
        )
        row = await cur.fetchone()
    return row["on_hand"], row["reserved"]


# ------------------------------------------------------------- reserving


async def test_reserving_holds_the_stock(db, repo, reference):
    await _stock(db, "RES-A", 100)
    shipment = await repo.create(reference=reference)

    result = await PostgresInventory(db).reserve(
        shipment.id, SKU, [{"warehouse": "RES-A", "quantity": 40}]
    )

    assert result.ok is True
    assert await _levels(db, "RES-A") == (100, 40)


async def test_a_reservation_row_is_written(db, repo, reference):
    """The table that had zero rows and zero writers."""
    await _stock(db, "RES-B", 100)
    shipment = await repo.create(reference=reference)
    await PostgresInventory(db).reserve(
        shipment.id, SKU, [{"warehouse": "RES-B", "quantity": 40}]
    )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT quantity, state FROM inventory_reservations WHERE shipment_id = %s",
            (shipment.id,),
        )
        row = await cur.fetchone()
    assert row["quantity"] == 40
    assert row["state"] == "HELD"


async def test_reserving_twice_does_not_take_it_twice(db, repo, reference):
    """Handlers get retried; reserving must be safe to run again."""
    await _stock(db, "RES-C", 100)
    shipment = await repo.create(reference=reference)
    inventory = PostgresInventory(db)

    await inventory.reserve(shipment.id, SKU, [{"warehouse": "RES-C", "quantity": 40}])
    second = await inventory.reserve(
        shipment.id, SKU, [{"warehouse": "RES-C", "quantity": 40}]
    )

    assert second.ok is True
    assert second.reason == "already held"
    assert await _levels(db, "RES-C") == (100, 40), "still only 40 held"


async def test_stock_cannot_be_oversold(db, repo, reference):
    """The bug this whole change exists to fix."""
    await _stock(db, "RES-D", 50)
    first = await repo.create(reference=reference)
    second = await repo.create(reference=f"{reference}-2")
    inventory = PostgresInventory(db)

    a = await inventory.reserve(first.id, SKU, [{"warehouse": "RES-D", "quantity": 40}])
    b = await inventory.reserve(second.id, SKU, [{"warehouse": "RES-D", "quantity": 40}])

    assert a.ok is True
    assert b.ok is False, "the second shipment must not get stock that is gone"
    assert await _levels(db, "RES-D") == (50, 40)


async def test_a_multi_line_reservation_is_all_or_nothing(db, repo, reference):
    """A partial hold would silently under-supply the shipment."""
    await _stock(db, "RES-E", 30)
    await _stock(db, "RES-F", 5)
    shipment = await repo.create(reference=reference)

    result = await PostgresInventory(db).reserve(
        shipment.id,
        SKU,
        [
            {"warehouse": "RES-E", "quantity": 30},
            {"warehouse": "RES-F", "quantity": 20},  # only 5 available
        ],
    )

    assert result.ok is False
    assert await _levels(db, "RES-E") == (30, 0), "the first line must roll back too"


async def test_concurrent_reservations_do_not_both_win(db, repo, reference):
    await _stock(db, "RES-G", 50)
    first = await repo.create(reference=reference)
    second = await repo.create(reference=f"{reference}-2")
    inventory = PostgresInventory(db)

    results = await asyncio.gather(
        inventory.reserve(first.id, SKU, [{"warehouse": "RES-G", "quantity": 40}]),
        inventory.reserve(second.id, SKU, [{"warehouse": "RES-G", "quantity": 40}]),
        return_exceptions=True,
    )
    won = [r for r in results if not isinstance(r, Exception) and r.ok]

    assert len(won) == 1
    on_hand, reserved = await _levels(db, "RES-G")
    assert reserved <= on_hand, "never oversold"


# -------------------------------------------------------------- releasing


async def test_releasing_gives_the_stock_back(db, repo, reference):
    await _stock(db, "RES-H", 100)
    shipment = await repo.create(reference=reference)
    inventory = PostgresInventory(db)

    await inventory.reserve(shipment.id, SKU, [{"warehouse": "RES-H", "quantity": 40}])
    released = await inventory.release(shipment.id)

    assert released == 1
    assert await _levels(db, "RES-H") == (100, 0)


async def test_consuming_draws_it_down(db, repo, reference):
    """Once the goods have shipped they have left the building."""
    await _stock(db, "RES-I", 100)
    shipment = await repo.create(reference=reference)
    inventory = PostgresInventory(db)

    await inventory.reserve(shipment.id, SKU, [{"warehouse": "RES-I", "quantity": 40}])
    await inventory.release(shipment.id, consume=True)

    assert await _levels(db, "RES-I") == (60, 0)


async def test_released_stock_can_be_reserved_again(db, repo, reference):
    await _stock(db, "RES-J", 50)
    first = await repo.create(reference=reference)
    second = await repo.create(reference=f"{reference}-2")
    inventory = PostgresInventory(db)

    await inventory.reserve(first.id, SKU, [{"warehouse": "RES-J", "quantity": 40}])
    await inventory.release(first.id)
    result = await inventory.reserve(
        second.id, SKU, [{"warehouse": "RES-J", "quantity": 40}]
    )

    assert result.ok is True


async def test_releasing_nothing_is_not_an_error(db, repo, reference):
    shipment = await repo.create(reference=reference)
    assert await PostgresInventory(db).release(shipment.id) == 0


async def test_availability_reflects_what_is_held(db, repo, reference):
    """Allocation reads availability, so a hold must reduce it."""
    await _stock(db, "RES-K", 100)
    shipment = await repo.create(reference=reference)
    inventory = PostgresInventory(db)

    before = {s.warehouse: s.available for s in await inventory.availability(SKU)}
    await inventory.reserve(shipment.id, SKU, [{"warehouse": "RES-K", "quantity": 40}])
    after = {s.warehouse: s.available for s in await inventory.availability(SKU)}

    assert before["RES-K"] == 100
    assert after["RES-K"] == 60
