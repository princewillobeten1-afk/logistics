"""analytics.report — the Analytics Agent.

Scheduled and self-rescheduling like `detection.sweep`, so one enqueue keeps it
running. Batch work on Ultra: it runs once a day, informs decisions worth real
money, and nobody is waiting on the response.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from psycopg.types.json import Jsonb

from logistics.analytics import MIN_SHIPMENTS, gather_facts, write_report
from logistics.domain.models import StepResult, WorkRequest
from logistics.handlers.base import StepContext, handler

DAILY = timedelta(hours=24)
WINDOW_DAYS = 7


@handler("analytics.report")
async def report(ctx: StepContext) -> StepResult:
    facts = await gather_facts(ctx.db, days=WINDOW_DAYS)

    if facts.thin:
        # Below this there is not enough history for a claim to mean anything,
        # and a model asked to find a trend in four shipments will find one.
        ctx.log.info("analytics.too_little_data", shipments=facts.shipments)
        return StepResult(enqueue=(_next_run(),))

    written = await write_report(
        ctx.require_llm(), facts, work_item_id=ctx.item.id
    )

    if written is None:
        ctx.log.warning("analytics.no_report")
        return StepResult(enqueue=(_next_run(),))

    stored = 0
    async with ctx.db.connection() as conn:
        for insight in written.insights:
            # Facts travel with the narrative so any claim can be checked
            # against the numbers it was written over.
            supporting = {
                "shipments": facts.shipments,
                "by_state": facts.by_state,
                "carriers": facts.carriers,
                "exceptions": facts.exceptions,
                "lanes": facts.lanes,
            }
            cur = await conn.execute(
                """
                INSERT INTO insights
                    (period_start, period_end, topic, headline, narrative,
                     recommendation, facts, severity)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (org_id, period_start, period_end, topic) DO UPDATE SET
                    headline = EXCLUDED.headline,
                    narrative = EXCLUDED.narrative,
                    recommendation = EXCLUDED.recommendation,
                    facts = EXCLUDED.facts,
                    severity = EXCLUDED.severity
                RETURNING id
                """,
                (
                    facts.period_start,
                    facts.period_end,
                    insight.topic,
                    insight.headline,
                    insight.narrative,
                    insight.recommendation,
                    Jsonb(supporting),
                    insight.severity,
                ),
            )
            if await cur.fetchone():
                stored += 1

    ctx.log.info(
        "analytics.reported",
        insights=stored,
        shipments=facts.shipments,
        action_needed=sum(
            1 for i in written.insights if i.severity == "ACTION_NEEDED"
        ),
    )

    return StepResult(enqueue=(_next_run(),))


def _next_run() -> WorkRequest:
    """Reschedule. The dedupe key is bucketed by hour so a duplicate enqueue
    collides instead of doubling the rate."""
    when = datetime.now(UTC) + DAILY
    return WorkRequest(
        kind="analytics.report",
        run_after=when,
        dedupe_key=f"analytics:{int(when.timestamp() // 3600)}",
        priority=250,
    )
