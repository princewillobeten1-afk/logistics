"""Idempotent tool execution.

Everything with an external side effect goes through here. Agent frameworks
retry, workers get killed, networks time out — and a tender that succeeded at
the carrier but whose response we never saw must not be sent twice.

    INSERT intent  →  external call  →  UPDATE result

The window between the insert and the update is the only unsafe moment, and a
crash there leaves an `INTENT` row with no `RESULT`. That is deliberately *not*
retryable: the correct move is to ask the carrier what they already have for
our reference, never to call again and hope.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from logistics.db import Database
from logistics.obs import get_logger

log = get_logger(__name__)


class ToolError(Exception):
    """The external call failed. Safe to retry — nothing was committed."""


class NeedsReconciliation(Exception):
    """A previous attempt reached the external system and we never learned the
    outcome.

    Blind retry here is how a truck gets booked twice. The caller must query
    the carrier for this reference and record what it finds.
    """

    def __init__(self, idempotency_key: str, tool: str) -> None:
        super().__init__(
            f"{tool} with key {idempotency_key[:16]}… was started but never "
            "completed. Reconcile with the carrier before retrying."
        )
        self.idempotency_key = idempotency_key
        self.tool = tool


@dataclass(frozen=True, slots=True)
class ToolResult:
    ok: bool
    response: dict[str, Any]
    replayed: bool = False
    """True when a stored result was returned instead of calling out again."""


def idempotency_key(*parts: Any) -> str:
    """Stable across retries of the same logical action, distinct across
    different ones. Deliberately excludes timestamps and attempt counters —
    including them would make every retry a new call, which is the bug."""
    payload = "|".join(str(p) for p in parts)
    return hashlib.sha256(payload.encode()).hexdigest()


class ToolExecutor:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def execute(
        self,
        *,
        key: str,
        tool: str,
        tier: int,
        request: dict[str, Any],
        call: Callable[[], Awaitable[dict[str, Any]]],
        shipment_id: UUID | None = None,
        agent_run_id: UUID | None = None,
        reconcile: Callable[[], Awaitable[dict[str, Any] | None]] | None = None,
    ) -> ToolResult:
        """Run `call` at most once for this key."""
        claimed = await self._claim(
            key=key,
            tool=tool,
            tier=tier,
            request=request,
            shipment_id=shipment_id,
            agent_run_id=agent_run_id,
        )

        if not claimed:
            return await self._resume(key, tool, reconcile)

        try:
            response = await call()
        except Exception as exc:  # noqa: BLE001
            # A definite failure: the call raised, so nothing was committed at
            # the far end. Marking FAILED lets a later attempt start cleanly.
            await self._mark_failed(key, str(exc))
            log.warning("tool.failed", tool=tool, error=str(exc))
            raise ToolError(f"{tool} failed: {exc}") from exc

        await self._mark_result(key, response)
        log.info("tool.executed", tool=tool, shipment_id=str(shipment_id) if shipment_id else None)
        return ToolResult(ok=True, response=response)

    # ----------------------------------------------------------- internals

    async def _claim(
        self,
        *,
        key: str,
        tool: str,
        tier: int,
        request: dict[str, Any],
        shipment_id: UUID | None,
        agent_run_id: UUID | None,
    ) -> bool:
        """Insert the intent. False when this key has been seen before.

        The uniqueness check is the database's, not a prior SELECT — two
        workers racing would both pass a read check and both call out.
        """
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                INSERT INTO tool_calls
                    (idempotency_key, shipment_id, agent_run_id, tool, tier, request, state)
                VALUES (%s, %s, %s, %s, %s, %s, 'INTENT')
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING id
                """,
                (
                    key,
                    shipment_id,
                    agent_run_id,
                    tool,
                    tier,
                    Jsonb(json.loads(json.dumps(request, default=str))),
                ),
            )
            return await cur.fetchone() is not None

    async def _resume(
        self,
        key: str,
        tool: str,
        reconcile: Callable[[], Awaitable[dict[str, Any] | None]] | None,
    ) -> ToolResult:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT state, response, error FROM tool_calls WHERE idempotency_key = %s",
                (key,),
            )
            row = await cur.fetchone()

        if row is None:  # pragma: no cover - the conflict guarantees a row
            raise ToolError(f"{tool}: conflicting key vanished")

        if row["state"] == "RESULT":
            # Already done. Return what happened rather than doing it again.
            log.info("tool.replayed", tool=tool)
            return ToolResult(ok=True, response=row["response"] or {}, replayed=True)

        if row["state"] == "FAILED":
            # The previous attempt definitively failed, so retrying is safe.
            await self._reopen(key)
            raise ToolError(f"{tool} previously failed: {row['error']}; retry scheduled")

        # INTENT with no RESULT: the dangerous case.
        if reconcile is not None:
            found = await reconcile()
            if found is not None:
                await self._mark_result(key, found)
                log.warning("tool.reconciled", tool=tool)
                return ToolResult(ok=True, response=found, replayed=True)

        raise NeedsReconciliation(key, tool)

    async def _mark_result(self, key: str, response: dict[str, Any]) -> None:
        async with self._db.connection() as conn:
            await conn.execute(
                """
                UPDATE tool_calls
                   SET state = 'RESULT', response = %s, completed_at = now(), error = NULL
                 WHERE idempotency_key = %s
                """,
                (Jsonb(json.loads(json.dumps(response, default=str))), key),
            )

    async def _mark_failed(self, key: str, error: str) -> None:
        async with self._db.connection() as conn:
            await conn.execute(
                """
                UPDATE tool_calls
                   SET state = 'FAILED', error = %s, completed_at = now()
                 WHERE idempotency_key = %s
                """,
                (error[:2000], key),
            )

    async def _reopen(self, key: str) -> None:
        async with self._db.connection() as conn:
            await conn.execute(
                "DELETE FROM tool_calls WHERE idempotency_key = %s AND state = 'FAILED'",
                (key,),
            )

    async def dangling(self, older_than_minutes: int = 15) -> list[dict[str, Any]]:
        """Intents with no result. Each one is a call that may have landed at
        the carrier — an operations queue, not a background cleanup."""
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                SELECT idempotency_key, tool, shipment_id, request, created_at
                  FROM tool_calls
                 WHERE state = 'INTENT'
                   AND created_at < now() - make_interval(mins => %s)
                 ORDER BY created_at
                """,
                (older_than_minutes,),
            )
            return list(await cur.fetchall())
