"""Shipment persistence."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from logistics.db import Database
from logistics.domain.models import Shipment
from logistics.domain.states import ShipmentState

_COLUMNS = """
    id, reference, state, version, customer_ref, origin, destination,
    cargo, deadline, allocation, plan, booking
"""


def row_to_shipment(row: dict[str, Any]) -> Shipment:
    return Shipment(
        id=row["id"],
        reference=row["reference"],
        state=ShipmentState(row["state"]),
        version=row["version"],
        customer_ref=row["customer_ref"],
        origin=row["origin"] or {},
        destination=row["destination"] or {},
        cargo=row["cargo"] or {},
        deadline=row["deadline"],
        allocation=row["allocation"],
        plan=row["plan"],
        booking=row["booking"],
    )


class ShipmentRepo:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def create(
        self,
        *,
        reference: str,
        origin: dict[str, Any] | None = None,
        destination: dict[str, Any] | None = None,
        cargo: dict[str, Any] | None = None,
        deadline: datetime | None = None,
        customer_ref: str | None = None,
        state: ShipmentState = ShipmentState.DRAFT,
        conn: AsyncConnection | None = None,
    ) -> Shipment:
        async def _run(c: AsyncConnection) -> Shipment:
            # `customer_ref` is free text from an order; `customer_id` is the
            # foreign key everything else joins on. Nothing populated it until
            # now, which quietly broke inbound email routing — a customer
            # writing in about their shipment was matched through
            # `JOIN customers c ON c.id = s.customer_id`, and that join could
            # never find a row. Resolving it here is the one place every
            # shipment passes through.
            customer_id = await _resolve_customer(c, customer_ref)

            cur = await c.execute(
                f"""
                INSERT INTO shipments
                    (reference, state, customer_ref, customer_id, origin,
                     destination, cargo, deadline)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING {_COLUMNS}
                """,
                (
                    reference,
                    str(state),
                    customer_ref,
                    customer_id,
                    Jsonb(origin or {}),
                    Jsonb(destination or {}),
                    Jsonb(cargo or {}),
                    deadline,
                ),
            )
            row = await cur.fetchone()
            assert row is not None
            shipment = row_to_shipment(row)
            await c.execute(
                """
                INSERT INTO shipment_events
                    (shipment_id, seq, type, to_state, payload, actor)
                VALUES (%s, 1, 'shipment.created', %s, %s, 'system')
                """,
                (shipment.id, str(state), Jsonb({"reference": reference})),
            )
            return shipment

        if conn is not None:
            return await _run(conn)
        async with self._db.transaction() as owned:
            return await _run(owned)

    async def get(self, shipment_id: UUID, *, conn: AsyncConnection | None = None) -> Shipment | None:
        sql = f"SELECT {_COLUMNS} FROM shipments WHERE id = %s"
        if conn is not None:
            cur = await conn.execute(sql, (shipment_id,))
            row = await cur.fetchone()
        else:
            async with self._db.connection() as owned:
                cur = await owned.execute(sql, (shipment_id,))
                row = await cur.fetchone()
        return row_to_shipment(row) if row else None

    async def get_by_reference(self, reference: str) -> Shipment | None:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_COLUMNS} FROM shipments WHERE reference = %s", (reference,)
            )
            row = await cur.fetchone()
        return row_to_shipment(row) if row else None

    async def lock(self, conn: AsyncConnection, shipment_id: UUID) -> Shipment | None:
        """Row-lock for the duration of the caller's transaction.

        Serialises concurrent steps on one shipment, which is what makes the
        per-shipment event `seq` safe to allocate with a MAX()+1.
        """
        cur = await conn.execute(
            f"SELECT {_COLUMNS} FROM shipments WHERE id = %s FOR UPDATE", (shipment_id,)
        )
        row = await cur.fetchone()
        return row_to_shipment(row) if row else None

    async def list_by_state(self, state: ShipmentState, limit: int = 100) -> list[Shipment]:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_COLUMNS} FROM shipments WHERE state = %s"
                " ORDER BY created_at DESC LIMIT %s",
                (str(state), limit),
            )
            return [row_to_shipment(r) for r in await cur.fetchall()]

    async def counts_by_state(self) -> dict[str, int]:
        async with self._db.connection() as conn:
            cur = await conn.execute("SELECT state, count(*) AS n FROM shipments GROUP BY state")
            return {row["state"]: row["n"] for row in await cur.fetchall()}


async def _resolve_customer(
    conn: AsyncConnection, customer_ref: str | None
) -> UUID | None:
    """Match an order's free-text customer against the customer table.

    Code first, then exact name — both case-insensitive. Deliberately no fuzzy
    matching: attaching a shipment to the wrong customer is worse than
    attaching it to none, because the wrong one then receives the updates.
    An unmatched ref is normal and stays in `customer_ref` for a human to see.
    """
    ref = (customer_ref or "").strip()
    if not ref:
        return None

    cur = await conn.execute(
        "SELECT id FROM customers"
        " WHERE active AND (upper(code) = upper(%s) OR lower(name) = lower(%s))"
        " ORDER BY (upper(code) = upper(%s)) DESC"
        " LIMIT 1",
        (ref, ref, ref),
    )
    row = await cur.fetchone()
    return row["id"] if row else None
