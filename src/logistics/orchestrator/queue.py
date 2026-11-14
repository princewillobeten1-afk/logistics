"""The durable work queue.

Postgres rather than a broker, because the shipment lifecycle already lives
here and the dashboard has to query it anyway. A second source of truth next to
the shipments table would buy ordering guarantees we do not need and cost us
the ability to answer "what is this shipment waiting on" in one join.

Claiming uses FOR UPDATE SKIP LOCKED under a lease, so a worker killed
mid-step releases its item when the lease expires instead of stranding the
shipment forever.
"""

from __future__ import annotations

import random
from typing import Any
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from logistics.config import Settings, get_settings
from logistics.db import Database, system_context
from logistics.domain.models import WorkItem, WorkRequest
from logistics.obs import get_logger

log = get_logger(__name__)

_CLAIM_SQL = """
WITH claimable AS (
    SELECT id
      FROM work_items
     WHERE state = 'PENDING'
       AND run_after <= now()
     ORDER BY priority, run_after
       FOR UPDATE SKIP LOCKED
     LIMIT 1
)
UPDATE work_items w
   SET state            = 'RUNNING',
       attempts         = w.attempts + 1,
       locked_by        = %(worker_id)s,
       locked_at        = now(),
       lease_expires_at = now() + make_interval(secs => %(lease_s)s)
  FROM claimable c
 WHERE w.id = c.id
RETURNING w.id, w.shipment_id, w.kind, w.payload, w.attempts, w.max_attempts,
          w.org_id
"""


class WorkQueue:
    def __init__(self, db: Database, settings: Settings | None = None) -> None:
        self._db = db
        self._settings = settings or get_settings()

    # ------------------------------------------------------------ enqueue
    async def enqueue(
        self, request: WorkRequest, *, conn: AsyncConnection | None = None
    ) -> UUID | None:
        """Schedule a step. Returns None when `dedupe_key` collided, meaning the
        step is already scheduled — a normal outcome on retry, not an error."""

        async def _run(c: AsyncConnection) -> UUID | None:
            cur = await c.execute(
                """
                INSERT INTO work_items
                    (shipment_id, kind, payload, run_after, dedupe_key,
                     max_attempts, priority)
                VALUES
                    (%s, %s, %s, COALESCE(%s, now()), %s, %s, %s)
                ON CONFLICT (org_id, dedupe_key) DO NOTHING
                RETURNING id
                """,
                (
                    request.shipment_id,
                    request.kind,
                    Jsonb(request.payload),
                    request.run_after,
                    request.dedupe_key,
                    request.max_attempts,
                    request.priority,
                ),
            )
            row = await cur.fetchone()
            return row["id"] if row else None

        if conn is not None:
            return await _run(conn)
        async with self._db.connection() as owned:
            return await _run(owned)

    # -------------------------------------------------------------- claim
    async def claim(self, *, worker_id: str | None = None, lease_s: int | None = None) -> WorkItem | None:
        """Take the next due item from *any* organisation's queue.

        Sanctioned system-context caller #2, and the only one in the runtime.
        A worker serves every tenant, so it must see every tenant's queue to
        know whose work is due — but it learns the org from the item it claims
        and hands that straight to `system_mode`-free execution. Scoping the
        claim itself would mean one worker process per organisation.
        """
        with system_context():
            async with self._db.connection() as conn:
                cur = await conn.execute(
                    _CLAIM_SQL,
                    {
                        "worker_id": worker_id or self._settings.worker_id,
                        "lease_s": lease_s or self._settings.worker_lease_s,
                    },
                )
                row = await cur.fetchone()
        if row is None:
            return None
        return WorkItem(
            id=row["id"],
            shipment_id=row["shipment_id"],
            kind=row["kind"],
            payload=row["payload"] or {},
            attempts=row["attempts"],
            max_attempts=row["max_attempts"],
            org_id=row["org_id"],
        )

    # ----------------------------------------------------------- lifecycle
    async def complete(self, item_id: UUID, *, conn: AsyncConnection | None = None) -> None:
        sql = """
            UPDATE work_items
               SET state = 'DONE', locked_by = NULL, locked_at = NULL,
                   lease_expires_at = NULL, last_error = NULL
             WHERE id = %s
        """
        if conn is not None:
            await conn.execute(sql, (item_id,))
        else:
            async with self._db.connection() as owned:
                await owned.execute(sql, (item_id,))

    async def fail(self, item: WorkItem, error: str) -> bool:
        """Record a failed attempt. Returns True if it will be retried, False if
        the item is now DEAD and needs a human."""
        retryable = item.attempts < item.max_attempts
        if retryable:
            delay = self._backoff(item.attempts)
            async with self._db.connection() as conn:
                await conn.execute(
                    """
                    UPDATE work_items
                       SET state = 'PENDING', locked_by = NULL, locked_at = NULL,
                           lease_expires_at = NULL, last_error = %s,
                           run_after = now() + make_interval(secs => %s)
                     WHERE id = %s
                    """,
                    (error[:2000], delay, item.id),
                )
            log.warning(
                "work.retry", kind=item.kind, item_id=str(item.id),
                attempt=item.attempts, retry_in_s=round(delay, 1),
            )
        else:
            async with self._db.connection() as conn:
                await conn.execute(
                    """
                    UPDATE work_items
                       SET state = 'DEAD', locked_by = NULL, locked_at = NULL,
                           lease_expires_at = NULL, last_error = %s
                     WHERE id = %s
                    """,
                    (error[:2000], item.id),
                )
            log.error(
                "work.dead", kind=item.kind, item_id=str(item.id),
                shipment_id=str(item.shipment_id), attempts=item.attempts,
            )
        return retryable

    def _backoff(self, attempt: int) -> float:
        """Exponential with full jitter — without the jitter, a provider outage
        synchronises every retry into a thundering herd."""
        ceiling = min(
            self._settings.retry_base_delay_s * (2 ** max(0, attempt - 1)),
            self._settings.retry_max_delay_s,
        )
        return random.uniform(self._settings.retry_base_delay_s, ceiling)  # noqa: S311

    # ------------------------------------------------------------- leases
    async def extend_lease(self, item_id: UUID, lease_s: int | None = None) -> None:
        async with self._db.connection() as conn:
            await conn.execute(
                """
                UPDATE work_items
                   SET lease_expires_at = now() + make_interval(secs => %s)
                 WHERE id = %s AND state = 'RUNNING'
                """,
                (lease_s or self._settings.worker_lease_s, item_id),
            )

    async def reclaim_expired(self) -> int:
        """Return items whose worker died to the queue. Items already at their
        attempt ceiling go straight to DEAD rather than looping.

        Cross-org for the same reason `claim` is: one reclaimer serves every
        tenant, and a dead worker's items must come back whichever org they
        belong to. It reads no business data — only queue bookkeeping.
        """
        with system_context():
            async with self._db.connection() as conn:
                cur = await conn.execute(
                    """
                    UPDATE work_items
                       SET state = CASE WHEN attempts >= max_attempts
                                        THEN 'DEAD' ELSE 'PENDING' END,
                           locked_by = NULL, locked_at = NULL, lease_expires_at = NULL,
                           last_error = COALESCE(last_error,
                                        'lease expired; worker presumed dead')
                     WHERE state = 'RUNNING' AND lease_expires_at < now()
                    RETURNING id, kind, attempts, max_attempts
                    """
                )
                rows = await cur.fetchall()
        for row in rows:
            log.warning("work.reclaimed", item_id=str(row["id"]), kind=row["kind"])
        return len(rows)

    # -------------------------------------------------------------- stats
    async def stats(self) -> dict[str, Any]:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT state, count(*) AS n FROM work_items GROUP BY state"
            )
            return {row["state"]: row["n"] for row in await cur.fetchall()}
