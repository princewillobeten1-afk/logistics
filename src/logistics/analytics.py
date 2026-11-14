"""The Analytics Agent.

The division of labour that makes this trustworthy: **SQL computes the facts,
the model explains them.** Your own example —

    "Carrier B generated 31% of late deliveries despite handling only 19%
     of shipments."

— is a query. Asking a model to produce that number would be asking it to
invent a statistic. It writes what the number means and what to do about it,
and the numbers are stored alongside so any claim can be checked.

Runs on Ultra: batch, overnight, latency-insensitive. The one job where depth
beats speed outright.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field

from logistics.db import Database
from logistics.llm.base import InvalidOutput, LLMClient, LLMRequest
from logistics.llm.registry import Job
from logistics.obs import get_logger

log = get_logger(__name__)

PROMPT_VERSION = "analytics.report/v1"

# Below this there is not enough history for a claim to mean anything.
MIN_SHIPMENTS = 5


@dataclass(frozen=True, slots=True)
class Facts:
    period_start: datetime
    period_end: datetime
    shipments: int
    by_state: dict[str, int]
    carriers: list[dict[str, Any]]
    exceptions: list[dict[str, Any]]
    lanes: list[dict[str, Any]]
    model_usage: list[dict[str, Any]]

    @property
    def thin(self) -> bool:
        return self.shipments < MIN_SHIPMENTS

    def as_prompt(self) -> str:
        lines = [
            f"Period: {self.period_start:%d %b} to {self.period_end:%d %b}",
            f"Shipments: {self.shipments}",
            f"By state: {', '.join(f'{k} {v}' for k, v in self.by_state.items())}",
        ]

        if self.carriers:
            lines.append("\nCarriers:")
            for c in self.carriers:
                lines.append(
                    f"  {c['code']}: {c['shipments']} shipments "
                    f"({c['share_pct']}% of volume), "
                    f"{c['late']} late ({c['late_share_pct']}% of all late), "
                    f"on-time record {c['on_time_rate']}"
                )

        if self.exceptions:
            lines.append("\nExceptions raised:")
            for e in self.exceptions:
                lines.append(f"  {e['kind']}: {e['n']} ({e['severity']})")

        if self.lanes:
            lines.append("\nLanes:")
            for lane in self.lanes:
                lines.append(
                    f"  {lane['lane']}: {lane['shipments']} shipments, "
                    f"{lane['exceptions']} with problems"
                )

        if self.model_usage:
            lines.append("\nModel usage:")
            for m in self.model_usage:
                lines.append(
                    f"  {m['job']}: {m['calls']} calls, {m['avg_latency']}ms average"
                )

        return "\n".join(lines)


class Insight(BaseModel):
    topic: str = Field(description="OPERATIONS | CARRIER | COST | EXCEPTIONS | MODEL")
    headline: str = Field(min_length=1, max_length=200)
    narrative: str = Field(min_length=1)
    recommendation: str | None = None
    severity: str = Field(description="INFO | NOTABLE | ACTION_NEEDED")


class Report(BaseModel):
    insights: list[Insight] = Field(default_factory=list, max_length=6)


SYSTEM = """You write the daily operations briefing for a Nigerian logistics \
operator.

You are given figures computed from the database. They are facts. Your job is \
to say what they mean and what to do — not to compute anything.

Rules:

- **Never state a number that is not in the figures.** If you want to make a \
point the data does not support, do not make it.
- **Lead with what changed or what is wrong.** An operator reads this to find \
out what needs attention, not to be reassured.
- **Compare shares, not just totals.** "Carrier B handled 19% of shipments but \
caused 31% of late deliveries" is useful; "Carrier B had 5 late deliveries" is \
not.
- **Say nothing rather than say something thin.** A quiet period with no real \
finding should produce one INFO insight, not five padded ones.
- **Recommend something specific and doable.** "Review carrier performance" is \
not a recommendation. "Stop routing Lagos-Abuja to Carrier B until its on-time \
rate recovers" is.

severity: ACTION_NEEDED for something costing money or customers now, NOTABLE \
for a trend worth watching, INFO for context.

Return JSON only. No prose outside it, no code fences."""


async def gather_facts(db: Database, *, days: int = 7) -> Facts:
    """Everything the briefing is written over. Pure SQL."""
    end = datetime.now(UTC)
    start = end - timedelta(days=days)

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM shipments WHERE created_at BETWEEN %s AND %s",
            (start, end),
        )
        shipments = (await cur.fetchone())["n"]

        cur = await conn.execute(
            "SELECT state, count(*) AS n FROM shipments"
            " WHERE created_at BETWEEN %s AND %s GROUP BY state ORDER BY count(*) DESC",
            (start, end),
        )
        by_state = {r["state"]: r["n"] for r in await cur.fetchall()}

        # Share of volume against share of lateness — the comparison that makes
        # a carrier finding actionable rather than merely descriptive.
        cur = await conn.execute(
            """
            WITH booked AS (
                SELECT s.id, s.booking->>'carrier_code' AS code,
                       EXISTS (SELECT 1 FROM exceptions e
                                WHERE e.shipment_id = s.id
                                  AND e.kind IN ('SLA_BREACH_RISK','ETA_DRIFT')) AS late
                  FROM shipments s
                 WHERE s.booking ? 'carrier_code'
                   AND s.created_at BETWEEN %s AND %s
            ), totals AS (
                SELECT count(*) AS all_shipments,
                       GREATEST(count(*) FILTER (WHERE late), 1) AS all_late
                  FROM booked
            )
            SELECT b.code,
                   count(*) AS shipments,
                   round(100.0 * count(*) / NULLIF(t.all_shipments, 0)) AS share_pct,
                   count(*) FILTER (WHERE b.late) AS late,
                   round(100.0 * count(*) FILTER (WHERE b.late) / t.all_late) AS late_share_pct,
                   round(coalesce(max(p.on_time_rate), 0), 2) AS on_time_rate
              FROM booked b
              CROSS JOIN totals t
              LEFT JOIN carriers c ON c.code = b.code
              LEFT JOIN carrier_performance p ON p.carrier_id = c.id AND p.mode IS NULL
             GROUP BY b.code, t.all_shipments, t.all_late
             ORDER BY count(*) FILTER (WHERE b.late) DESC
             LIMIT 8
            """,
            (start, end),
        )
        carriers = [dict(r) for r in await cur.fetchall()]

        cur = await conn.execute(
            "SELECT kind, severity, count(*) AS n FROM exceptions"
            " WHERE created_at BETWEEN %s AND %s"
            " GROUP BY kind, severity ORDER BY count(*) DESC LIMIT 10",
            (start, end),
        )
        exceptions = [dict(r) for r in await cur.fetchall()]

        cur = await conn.execute(
            """
            SELECT concat(s.origin->>'city', ' - ', s.destination->>'city') AS lane,
                   count(*) AS shipments,
                   count(*) FILTER (
                       WHERE EXISTS (SELECT 1 FROM exceptions e WHERE e.shipment_id = s.id)
                   ) AS exceptions
              FROM shipments s
             WHERE s.origin ? 'city' AND s.destination ? 'city'
               AND s.created_at BETWEEN %s AND %s
             GROUP BY 1 ORDER BY count(*) DESC LIMIT 8
            """,
            (start, end),
        )
        lanes = [dict(r) for r in await cur.fetchall()]

        cur = await conn.execute(
            "SELECT job, count(*) AS calls, round(avg(latency_ms)) AS avg_latency"
            "  FROM agent_runs WHERE created_at BETWEEN %s AND %s"
            " GROUP BY job ORDER BY count(*) DESC",
            (start, end),
        )
        model_usage = [dict(r) for r in await cur.fetchall()]

    return Facts(
        period_start=start,
        period_end=end,
        shipments=shipments,
        by_state=by_state,
        carriers=carriers,
        exceptions=exceptions,
        lanes=lanes,
        model_usage=model_usage,
    )


async def write_report(
    llm: LLMClient, facts: Facts, *, work_item_id=None
) -> Report | None:
    """Turn the figures into a briefing. None when the model could not."""
    try:
        result = await llm.structured(
            LLMRequest(
                job=Job.ANALYTICS,
                system=SYSTEM,
                messages=[
                    {
                        "role": "user",
                        "content": (
                            f"Figures for the period:\n\n{facts.as_prompt()}\n\n"
                            "Write the briefing."
                        ),
                    }
                ],
                agent="analytics",
                work_item_id=work_item_id,
                prompt_version=PROMPT_VERSION,
            ),
            Report,
        )
    except InvalidOutput as exc:
        log.warning("analytics.unreadable", attempts=exc.attempts)
        return None

    return result.value
