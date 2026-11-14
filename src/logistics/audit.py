"""The audit trail.

`audit_logs` has had a schema since migration 005 and zero writers since
migration 005. It records what a *principal* did — a human approving spend, an
admin changing a channel credential — as distinct from `shipment_events` and
`agent_runs`, which record what the system did to a shipment.

The actor is stored as an email string rather than a foreign key on purpose: an
audit row must survive the deletion of the account it names.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from logistics.db import Database


class Action(StrEnum):
    LOGIN = "LOGIN"
    LOGIN_FAILED = "LOGIN_FAILED"
    LOGOUT = "LOGOUT"
    APPROVAL_GRANTED = "APPROVAL_GRANTED"
    APPROVAL_DENIED = "APPROVAL_DENIED"
    CHANNEL_CONFIGURED = "CHANNEL_CONFIGURED"
    CHANNEL_DISABLED = "CHANNEL_DISABLED"
    POLICY_CHANGED = "POLICY_CHANGED"
    SHIPMENT_CREATED = "SHIPMENT_CREATED"
    USER_CREATED = "USER_CREATED"
    PASSWORD_RESET = "PASSWORD_RESET"


async def record(
    db: Database,
    *,
    actor: str,
    action: Action | str,
    actor_type: str = "USER",
    entity_type: str | None = None,
    entity_id: UUID | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    """Write one audit row.

    Never raises: an audit write failing must not roll back the action it was
    describing — losing the record of an approval is bad, but refusing an
    approval that already went through is worse, and the caller has no sensible
    recovery either way. Failures surface in the logs.
    """
    try:
        async with db.connection() as conn:
            await conn.execute(
                """
                INSERT INTO audit_logs
                    (actor, actor_type, action, entity_type, entity_id,
                     before, after, ip_address, user_agent)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    actor, actor_type, str(action), entity_type, entity_id,
                    Jsonb(before) if before is not None else None,
                    Jsonb(after) if after is not None else None,
                    ip, (user_agent or "")[:500] or None,
                ),
            )
    except Exception:  # noqa: BLE001
        from logistics.obs import get_logger

        get_logger(__name__).error(
            "audit.write_failed", action=str(action), actor=actor, exc_info=True
        )


async def recent(db: Database, limit: int = 100) -> list[dict[str, Any]]:
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id, actor, actor_type, action, entity_type, entity_id,"
            "       before, after, ip_address, created_at"
            "  FROM audit_logs ORDER BY id DESC LIMIT %s",
            (limit,),
        )
        return list(await cur.fetchall())
