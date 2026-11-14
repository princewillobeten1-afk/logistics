"""Exception records.

An exception is a finding, not a shipment state change. This writes the record;
the orchestrator does the transition, so state still moves in exactly one place.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from logistics.db import Database
from logistics.obs import get_logger
from logistics.tracking.detection import Detection

log = get_logger(__name__)


class ExceptionRepo:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def raise_detection(
        self,
        *,
        shipment_id: UUID,
        detection: Detection,
        leg_id: UUID | None = None,
        detected_by: str = "detector",
        conn: AsyncConnection | None = None,
    ) -> UUID | None:
        """Record a finding. Returns None when one of this kind is already open.

        The dedupe is the partial unique index from migration 007, not a
        SELECT-then-INSERT — two workers ingesting concurrently would both pass
        a read check and both insert.
        """

        async def _run(c: AsyncConnection) -> UUID | None:
            cur = await c.execute(
                """
                INSERT INTO exceptions
                    (shipment_id, leg_id, kind, severity, detected_by, summary, detail)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (shipment_id, kind)
                    WHERE state NOT IN ('RESOLVED', 'ABANDONED')
                    DO NOTHING
                RETURNING id
                """,
                (
                    shipment_id,
                    leg_id,
                    str(detection.kind),
                    str(detection.severity),
                    detected_by,
                    detection.summary,
                    Jsonb(detection.detail),
                ),
            )
            row = await cur.fetchone()
            return row["id"] if row else None

        if conn is not None:
            return await _run(conn)
        async with self._db.connection() as owned:
            return await _run(owned)

    async def open_kinds(self, shipment_id: UUID) -> set[str]:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT kind FROM exceptions WHERE shipment_id = %s"
                " AND state NOT IN ('RESOLVED','ABANDONED')",
                (shipment_id,),
            )
            return {r["kind"] for r in await cur.fetchall()}

    async def resolve(
        self, exception_id: UUID, *, resolution: str, by: str = "system"
    ) -> None:
        async with self._db.connection() as conn:
            await conn.execute(
                """
                UPDATE exceptions
                   SET state = 'RESOLVED', resolution = %s, resolved_at = now()
                 WHERE id = %s
                """,
                (f"{resolution} ({by})", exception_id),
            )

    async def resolve_kind(
        self, shipment_id: UUID, kind: str, *, resolution: str
    ) -> int:
        """Close open findings of one kind — used when the condition clears,
        e.g. a truck that was off route rejoins it."""
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                UPDATE exceptions
                   SET state = 'RESOLVED', resolution = %s, resolved_at = now()
                 WHERE shipment_id = %s AND kind = %s
                   AND state NOT IN ('RESOLVED','ABANDONED')
                RETURNING id
                """,
                (resolution, shipment_id, kind),
            )
            return len(await cur.fetchall())

    async def counts_by_severity(self) -> dict[str, int]:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT severity, count(*) AS n FROM exceptions"
                " WHERE state <> 'RESOLVED' GROUP BY severity"
            )
            return {r["severity"]: r["n"] for r in await cur.fetchall()}
