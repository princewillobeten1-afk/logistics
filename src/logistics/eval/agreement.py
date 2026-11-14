"""How often the humans agreed with the agents.

Every approval a person decides is a labelled example that normal operation
produced for free: the agent said "book this carrier for ₦109,132", a human
looked at it and said yes or no. Nobody had to write a test case.

This is the evidence that should gate autonomy, because it is the only kind
measured on the real distribution of situations rather than on cases someone
thought to imagine. `replay.py` complements it — that catches regressions, this
answers whether the agent deserves more rope.

Nothing here calls a model. It is SQL over rows the system already writes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from logistics.db import Database
from logistics.eval.stats import Proportion, median


@dataclass(frozen=True, slots=True)
class Decision:
    """One agent proposal that a human ruled on."""

    action: str
    tier: int
    amount_minor: int | None
    currency: str
    approved: bool
    decided_by: str
    decided_at: datetime | None
    reference: str | None
    policy_reason: str | None

    @property
    def agreed(self) -> bool:
        """The agent proposed it; approval means the human would have made the
        same call. A rejection is the agent being wrong in the way that
        matters — it wanted to spend money it should not have."""
        return self.approved


@dataclass(frozen=True, slots=True)
class ActionAgreement:
    action: str
    decisions: list[Decision] = field(default_factory=list)

    @property
    def proportion(self) -> Proportion:
        return Proportion(
            successes=sum(1 for d in self.decisions if d.agreed),
            total=len(self.decisions),
        )

    @property
    def approved_amounts(self) -> list[int]:
        return [
            d.amount_minor
            for d in self.decisions
            if d.agreed and d.amount_minor is not None
        ]

    @property
    def median_approved_minor(self) -> int:
        return median(self.approved_amounts)

    @property
    def largest_approved_minor(self) -> int:
        return max(self.approved_amounts, default=0)

    @property
    def rejected(self) -> list[Decision]:
        """Worth reading individually rather than as a rate. At these sample
        sizes each rejection is a specific thing the agent got wrong, and the
        reason matters more than the count."""
        return [d for d in self.decisions if not d.agreed]


async def gather_decisions(db: Database, *, since_days: int | None = None) -> list[Decision]:
    """Every approval a person has actually ruled on.

    Deliberately excludes EXPIRED. An approval that timed out is not a human
    disagreeing with the agent — it is nobody looking, and counting it as a
    rejection would punish the agent for an operational gap.
    """
    where = ["a.state IN ('APPROVED', 'REJECTED')", "a.decided_by IS NOT NULL"]
    params: list[Any] = []
    if since_days is not None:
        where.append("a.decided_at > now() - make_interval(days => %s)")
        params.append(since_days)

    async with db.connection() as conn:
        cur = await conn.execute(
            f"""
            SELECT p.action, p.tier, p.policy_reason,
                   a.amount_minor, a.currency, a.state, a.decided_by, a.decided_at,
                   s.reference
              FROM approvals a
              JOIN proposed_actions p ON p.id = a.proposed_action_id
              LEFT JOIN shipments s ON s.id = a.shipment_id
             WHERE {' AND '.join(where)}
             ORDER BY a.decided_at DESC
            """,
            params,
        )
        rows = await cur.fetchall()

    return [
        Decision(
            action=r["action"],
            tier=r["tier"],
            amount_minor=r["amount_minor"],
            currency=r["currency"] or "NGN",
            approved=r["state"] == "APPROVED",
            decided_by=r["decided_by"],
            decided_at=r["decided_at"],
            reference=r["reference"],
            policy_reason=r["policy_reason"],
        )
        for r in rows
    ]


def by_action(decisions: list[Decision]) -> dict[str, ActionAgreement]:
    """Grouped, because agreement is not one number.

    An agent may be reliable at re-sourcing a carrier and poor at expediting,
    and a combined rate would hide both. Caps are per-action in the policy for
    the same reason.
    """
    grouped: dict[str, list[Decision]] = {}
    for d in decisions:
        grouped.setdefault(d.action, []).append(d)
    return {
        action: ActionAgreement(action=action, decisions=items)
        for action, items in sorted(grouped.items())
    }


async def pending_backlog(db: Database) -> int:
    """Approvals nobody has decided yet, and still could.

    Reported next to the agreement rate on purpose: a large backlog means the
    sample is not just small but *biased* — the easy calls get decided and the
    hard ones sit, so agreement measured on what was decided looks better than
    the agent really is.
    """
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM approvals"
            " WHERE state = 'PENDING' AND expires_at > now()"
        )
        return (await cur.fetchone())["n"]


async def abandoned(db: Database) -> int:
    """Approvals that ran out of time before anyone looked.

    Not evidence about the agent, and deliberately excluded from agreement —
    but the most important number on the page when it is non-zero. Every one is
    a shipment that stopped and waited for a person who never came, and it is
    invisible everywhere else: the approval quietly moves to EXPIRED and the
    queue looks clean.

    It also caps how fast autonomy can ever be earned. Evidence accrues only
    when humans actually decide, so a system where approvals time out is one
    where the caps can never be raised on evidence, however good the agent is.
    """
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM approvals"
            " WHERE state = 'EXPIRED'"
            "    OR (state = 'PENDING' AND expires_at <= now())"
        )
        return (await cur.fetchone())["n"]
