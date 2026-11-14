"""Inventory sources.

The Protocol is the seam. `handlers/allocate.py` is written against it, so the
in-memory stub used by tests and the Postgres implementation used in anger are
interchangeable with no handler change.

A stock line carries more than a quantity: allocation has to weigh dispatch
lead time and distance against the deadline, so the source supplies both.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from logistics.db import Database
from logistics.geo import Coordinates, haversine_km
from logistics.obs import get_logger

log = get_logger(__name__)

# Planning speed by mode, km/h. Deliberately pessimistic for road — Nigerian
# highway averages including stops, not motorway cruising speed.
ROAD_AVG_KPH = 55.0


@dataclass(frozen=True, slots=True)
class StockLine:
    warehouse: str
    sku: str
    available: int
    dispatch_lead_hours: float = 8.0
    """Hours from pick instruction to goods on a vehicle."""
    distance_km: float | None = None
    """To the shipment's destination, when the source could compute it."""

    def hours_to_deliver(self, kph: float = ROAD_AVG_KPH) -> float | None:
        """Dispatch lead plus transit. None when distance is unknown."""
        if self.distance_km is None:
            return None
        return self.dispatch_lead_hours + (self.distance_km / kph)


__all__ = [
    "ROAD_AVG_KPH",
    "Coordinates",
    "InMemoryInventory",
    "InventorySource",
    "PostgresInventory",
    "StockLine",
    "haversine_km",
]


@dataclass(frozen=True, slots=True)
class ReservationResult:
    ok: bool
    reserved: list[dict]
    reason: str = ""

    @property
    def held(self) -> int:
        return sum(line["quantity"] for line in self.reserved)


class InventorySource(Protocol):
    async def availability(
        self, sku: str, *, destination: Coordinates | None = None
    ) -> list[StockLine]: ...

    async def reserve(
        self, shipment_id: UUID, sku: str, lines: list[dict]
    ) -> ReservationResult:
        """Hold stock. All lines or none.

        Must be idempotent: handlers get retried, so reserving twice for the
        same shipment must not take the stock twice.
        """
        ...

    async def release(self, shipment_id: UUID, *, consume: bool = False) -> int:
        """Give the stock back, or mark it used once it has shipped."""
        ...


class InMemoryInventory:
    """Deterministic stand-in for tests. Not durable, by design.

    Seeded from the worked example in the brief (Lagos 130 / Ibadan 20 /
    Abuja 80).
    """

    def __init__(
        self,
        stock: dict[tuple[str, str], int] | None = None,
        *,
        lead_hours: dict[str, float] | None = None,
        distances: dict[str, float] | None = None,
    ) -> None:
        self._stock: dict[tuple[str, str], int] = dict(
            stock
            if stock is not None
            else {
                ("Lagos", "DEFAULT"): 130,
                ("Ibadan", "DEFAULT"): 20,
                ("Abuja", "DEFAULT"): 80,
            }
        )
        self._lead_hours = lead_hours or {}
        self._distances = distances or {}
        self._held: dict[UUID, list[dict]] = {}

    async def availability(
        self, sku: str, *, destination: Coordinates | None = None
    ) -> list[StockLine]:
        return [
            StockLine(
                warehouse=wh,
                sku=s,
                available=qty,
                dispatch_lead_hours=self._lead_hours.get(wh, 8.0),
                distance_km=self._distances.get(wh),
            )
            for (wh, s), qty in self._stock.items()
            if s == sku and qty > 0
        ]

    def set(self, warehouse: str, sku: str, quantity: int) -> None:
        self._stock[(warehouse, sku)] = quantity

    async def reserve(
        self, shipment_id: UUID, sku: str, lines: list[dict]
    ) -> ReservationResult:
        """Deduct from the stub's stock, so tests see the same contention the
        real source enforces."""
        held = self._held.setdefault(shipment_id, [])
        if held:
            return ReservationResult(True, held, "already held")

        for line in lines:
            available = self._stock.get((line["warehouse"], sku), 0)
            if available < line["quantity"]:
                return ReservationResult(
                    False, [], f"{line['warehouse']} has {available}, needs {line['quantity']}"
                )

        for line in lines:
            self._stock[(line["warehouse"], sku)] -= line["quantity"]
            held.append(dict(line))
        return ReservationResult(True, held)

    async def release(self, shipment_id: UUID, *, consume: bool = False) -> int:
        held = self._held.pop(shipment_id, [])
        if not consume:
            for line in held:
                key = (line["warehouse"], line.get("sku", "DEFAULT"))
                self._stock[key] = self._stock.get(key, 0) + line["quantity"]
        return len(held)


class PostgresInventory:
    """The real source. Reports available stock as on_hand minus reserved, so a
    held reservation is never offered to a second shipment."""

    def __init__(self, db: Database) -> None:
        self._db = db

    async def availability(
        self, sku: str, *, destination: Coordinates | None = None
    ) -> list[StockLine]:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                SELECT w.code                          AS warehouse,
                       i.sku                           AS sku,
                       (i.on_hand - i.reserved)        AS available,
                       w.dispatch_lead_hours           AS lead_hours,
                       l.latitude                      AS lat,
                       l.longitude                     AS lon
                  FROM inventory i
                  JOIN warehouses w ON w.id = i.warehouse_id
             LEFT JOIN locations  l ON l.id = w.location_id
                 WHERE i.sku = %s
                   AND w.active
                   AND (i.on_hand - i.reserved) > 0
                """,
                (sku,),
            )
            rows = await cur.fetchall()

        lines: list[StockLine] = []
        for row in rows:
            distance = None
            if destination and row["lat"] is not None and row["lon"] is not None:
                distance = haversine_km(
                    (float(row["lat"]), float(row["lon"])), destination
                )
            lines.append(
                StockLine(
                    warehouse=row["warehouse"],
                    sku=row["sku"],
                    available=int(row["available"]),
                    dispatch_lead_hours=float(row["lead_hours"]),
                    distance_km=distance,
                )
            )
        return lines

    async def reserve(
        self, shipment_id: UUID, sku: str, lines: list[dict]
    ) -> ReservationResult:
        """Hold stock atomically. All lines or none.

        The `WHERE (on_hand - reserved) >= %s` predicate is what actually
        prevents overselling — two shipments racing for the last pallet, one
        loses and gets told, rather than both being told they have it. The
        `inventory_not_oversold` CHECK is the backstop if that predicate is
        ever wrong.
        """
        try:
            return await self._reserve(shipment_id, sku, lines)
        except _ReservationLost as exc:
            # The transaction rolled back, so nothing is held. Allocation
            # re-plans rather than proceeding on stock it does not have.
            log.warning("inventory.reservation_lost", shipment_id=str(shipment_id))
            return ReservationResult(False, [], str(exc))

    async def _reserve(
        self, shipment_id: UUID, sku: str, lines: list[dict]
    ) -> ReservationResult:
        async with self._db.transaction() as conn:
            # Idempotency: a retried handler must not take the stock twice.
            cur = await conn.execute(
                "SELECT warehouse_id, sku, quantity FROM inventory_reservations"
                " WHERE shipment_id = %s AND state = 'HELD'",
                (shipment_id,),
            )
            if existing := await cur.fetchall():
                return ReservationResult(
                    True,
                    [{"warehouse_id": r["warehouse_id"], "quantity": r["quantity"]} for r in existing],
                    "already held",
                )

            taken: list[dict] = []
            for line in lines:
                cur = await conn.execute(
                    """
                    UPDATE inventory i
                       SET reserved = i.reserved + %s
                      FROM warehouses w
                     WHERE w.id = i.warehouse_id
                       AND w.code = %s
                       AND i.sku = %s
                       AND (i.on_hand - i.reserved) >= %s
                    RETURNING i.warehouse_id
                    """,
                    (line["quantity"], line["warehouse"], sku, line["quantity"]),
                )
                row = await cur.fetchone()

                if row is None:
                    # Someone took it between planning and reserving. The whole
                    # transaction rolls back, so no partial hold survives.
                    raise _ReservationLost(
                        f"{line['warehouse']} no longer has {line['quantity']} of {sku}"
                    )

                await conn.execute(
                    """
                    INSERT INTO inventory_reservations
                        (shipment_id, warehouse_id, sku, quantity, state)
                    VALUES (%s, %s, %s, %s, 'HELD')
                    ON CONFLICT (shipment_id, warehouse_id, sku)
                        WHERE state = 'HELD' DO NOTHING
                    """,
                    (shipment_id, row["warehouse_id"], sku, line["quantity"]),
                )
                taken.append({"warehouse": line["warehouse"], "quantity": line["quantity"]})

            log.info(
                "inventory.reserved", shipment_id=str(shipment_id), lines=len(taken)
            )
            return ReservationResult(True, taken)

    async def release(self, shipment_id: UUID, *, consume: bool = False) -> int:
        """Return held stock, or mark it consumed once the goods have shipped.

        Releasing gives the quantity back to `inventory.reserved`; consuming
        draws it down from `on_hand` too, because it has physically left.
        """
        async with self._db.transaction() as conn:
            cur = await conn.execute(
                """
                UPDATE inventory_reservations
                   SET state = %s
                 WHERE shipment_id = %s AND state = 'HELD'
                RETURNING warehouse_id, sku, quantity
                """,
                ("CONSUMED" if consume else "RELEASED", shipment_id),
            )
            rows = await cur.fetchall()

            for row in rows:
                if consume:
                    await conn.execute(
                        "UPDATE inventory SET on_hand = on_hand - %s,"
                        " reserved = reserved - %s"
                        " WHERE warehouse_id = %s AND sku = %s",
                        (row["quantity"], row["quantity"], row["warehouse_id"], row["sku"]),
                    )
                else:
                    await conn.execute(
                        "UPDATE inventory SET reserved = reserved - %s"
                        " WHERE warehouse_id = %s AND sku = %s",
                        (row["quantity"], row["warehouse_id"], row["sku"]),
                    )

        if rows:
            log.info(
                "inventory.released",
                shipment_id=str(shipment_id),
                lines=len(rows),
                consumed=consume,
            )
        return len(rows)


class _ReservationLost(Exception):
    """Raised inside the reserve transaction so it rolls back cleanly."""
