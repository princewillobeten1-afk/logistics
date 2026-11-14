"""Human approvals.

The state that breaks naive implementations: it can last hours, must survive
deploys, and needs escalation — an unanswered approval is itself an operational
failure, not a neutral wait.

Two invariants, both enforced by the database rather than by care:

  * **One pending approval per proposed action** (`approvals_one_pending_idx`).
  * **A token decides once.** The decision is a conditional UPDATE, so a
    double-clicked Approve at ₦650,000 cannot spend ₦1.3M.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from logistics.db import Database
from logistics.obs import get_logger

log = get_logger(__name__)

DEFAULT_TTL = timedelta(hours=12)
DEFAULT_ESCALATE_AFTER = timedelta(hours=2)


class ApprovalError(Exception):
    pass


@dataclass(frozen=True, slots=True)
class Approval:
    id: UUID
    proposed_action_id: UUID
    shipment_id: UUID
    token: str
    summary: str
    state: str
    amount_minor: int | None
    currency: str
    requested_at: datetime
    expires_at: datetime
    escalate_at: datetime | None = None
    decided_by: str | None = None
    note: str | None = None

    @property
    def pending(self) -> bool:
        return self.state == "PENDING"


def _row(row: dict[str, Any]) -> Approval:
    return Approval(
        id=row["id"],
        proposed_action_id=row["proposed_action_id"],
        shipment_id=row["shipment_id"],
        token=row["token"],
        summary=row["summary"],
        state=row["state"],
        amount_minor=row["amount_minor"],
        currency=row["currency"],
        requested_at=row["requested_at"],
        expires_at=row["expires_at"],
        escalate_at=row.get("escalate_at"),
        decided_by=row.get("decided_by"),
        note=row.get("note"),
    )


class ApprovalRepo:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def request(
        self,
        *,
        proposed_action_id: UUID,
        shipment_id: UUID,
        summary: str,
        amount_minor: int | None = None,
        currency: str = "NGN",
        ttl: timedelta = DEFAULT_TTL,
        escalate_after: timedelta = DEFAULT_ESCALATE_AFTER,
    ) -> Approval:
        now = datetime.now(UTC)
        # 32 bytes of entropy: the token is a bearer credential that authorises
        # spending, so it must not be guessable.
        token = secrets.token_urlsafe(32)

        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                INSERT INTO approvals
                    (proposed_action_id, shipment_id, token, summary,
                     amount_minor, currency, expires_at, escalate_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (proposed_action_id) WHERE state = 'PENDING'
                    DO NOTHING
                RETURNING id, proposed_action_id, shipment_id, token, summary, state,
                          amount_minor, currency, requested_at, expires_at, escalate_at,
                          decided_by, note
                """,
                (
                    proposed_action_id,
                    shipment_id,
                    token,
                    summary,
                    amount_minor,
                    currency,
                    now + ttl,
                    now + escalate_after,
                ),
            )
            row = await cur.fetchone()

            if row is None:
                # Already pending for this action — return the existing one so
                # a retried step does not open a second approval.
                cur = await conn.execute(
                    """
                    SELECT id, proposed_action_id, shipment_id, token, summary, state,
                           amount_minor, currency, requested_at, expires_at, escalate_at,
                           decided_by, note
                      FROM approvals
                     WHERE proposed_action_id = %s AND state = 'PENDING'
                    """,
                    (proposed_action_id,),
                )
                row = await cur.fetchone()
                if row is None:  # pragma: no cover
                    raise ApprovalError("approval conflicted but could not be read back")

        log.info("approval.requested", shipment_id=str(shipment_id), summary=summary)
        return _row(row)

    async def decide(
        self, token: str, *, approved: bool, by: str, note: str | None = None
    ) -> Approval | None:
        """Approve or reject. Returns None when the token has already been
        used, has expired, or does not exist.

        The `state = 'PENDING'` predicate is what makes this single-use: a
        second click matches no row and changes nothing.
        """
        state = "APPROVED" if approved else "REJECTED"
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                UPDATE approvals
                   SET state = %s, decided_by = %s, decided_at = now(), note = %s
                 WHERE token = %s AND state = 'PENDING' AND expires_at > now()
                RETURNING id, proposed_action_id, shipment_id, token, summary, state,
                          amount_minor, currency, requested_at, expires_at, escalate_at,
                          decided_by, note
                """,
                (state, by, note, token),
            )
            row = await cur.fetchone()

            if row is None:
                log.warning("approval.not_actionable", token=token[:8])
                return None

            # Move the proposed action in the same breath. An approval that
            # does not advance its action is a decision nothing acts on.
            await conn.execute(
                """
                UPDATE proposed_actions
                   SET state = %s, decided_at = now()
                 WHERE id = %s AND state = 'PROPOSED'
                """,
                ("APPROVED" if approved else "REJECTED", row["proposed_action_id"]),
            )

        log.info("approval.decided", state=state, by=by, shipment_id=str(row["shipment_id"]))
        return _row(row)

    async def get(self, token: str) -> Approval | None:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                SELECT id, proposed_action_id, shipment_id, token, summary, state,
                       amount_minor, currency, requested_at, expires_at, escalate_at,
                       decided_by, note
                  FROM approvals WHERE token = %s
                """,
                (token,),
            )
            row = await cur.fetchone()
        return _row(row) if row else None

    async def pending(self) -> list[Approval]:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                SELECT id, proposed_action_id, shipment_id, token, summary, state,
                       amount_minor, currency, requested_at, expires_at, escalate_at,
                       decided_by, note
                  FROM approvals WHERE state = 'PENDING' ORDER BY requested_at
                """
            )
            return [_row(r) for r in await cur.fetchall()]

    async def expire_overdue(self) -> list[UUID]:
        """Close approvals nobody answered. Expiry is a decision too — the
        shipment must not sit in AWAITING_APPROVAL forever."""
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                UPDATE approvals
                   SET state = 'EXPIRED', decided_at = now()
                 WHERE state = 'PENDING' AND expires_at <= now()
                RETURNING id, shipment_id, proposed_action_id
                """
            )
            rows = await cur.fetchall()
            for row in rows:
                await conn.execute(
                    "UPDATE proposed_actions SET state = 'EXPIRED', decided_at = now()"
                    " WHERE id = %s AND state = 'PROPOSED'",
                    (row["proposed_action_id"],),
                )
        for row in rows:
            log.warning("approval.expired", shipment_id=str(row["shipment_id"]))
        return [r["id"] for r in rows]
