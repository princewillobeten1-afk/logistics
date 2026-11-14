"""shipment.assist — answer an operator's question about one shipment.

The model call happens here rather than in the dashboard for the same reason
support replies do: one model client, one routing table, one place where cost
and latency land in `agent_runs`. A second client in TypeScript would be free
to drift, and the drift would be invisible until the bills disagreed.

Nothing this handler does changes anything. It reads, it asks a model to
explain, it writes the answer to `assistant_messages`. There is no StepResult
transition and no enqueue, because an assistant that can move a shipment is a
different and much more dangerous feature.
"""

from __future__ import annotations

from uuid import UUID

from logistics.domain.models import StepResult
from logistics.handlers.base import PermanentFailure, StepContext, handler
from logistics.support.assist import answer_question
from logistics.support.operator import build_operator_view


@handler("shipment.assist")
async def assist(ctx: StepContext) -> StepResult:
    shipment = ctx.require_shipment()
    message_id = ctx.item.payload.get("message_id")
    if not message_id:
        raise PermanentFailure("shipment.assist requires a message_id")

    question, history = await _thread(ctx, UUID(message_id))
    if question is None:
        # The row is gone — the operator navigated away and it was cleaned up,
        # or the shipment was deleted. Nothing to answer.
        ctx.log.info("assist.question_gone", message_id=message_id)
        return StepResult()

    view = await build_operator_view(ctx.db, shipment.reference)
    if view is None:  # pragma: no cover - the shipment was just loaded
        raise PermanentFailure(f"no shipment {shipment.reference}")

    llm = ctx.require_llm()
    answer = await answer_question(llm, view, question, history)

    if answer is None:
        await _fail(
            ctx, UUID(message_id),
            "I could not put together an answer to that. The case notes are on "
            "this page — worth reading them directly.",
        )
        return StepResult()

    async with ctx.db.connection() as conn:
        await conn.execute(
            "UPDATE assistant_messages"
            "   SET body = %s, state = 'DONE', confidence = %s, next_step = %s"
            " WHERE id = %s",
            (
                answer.answer,
                round(answer.confidence, 3),
                answer.suggested_next_step,
                UUID(message_id),
            ),
        )

    ctx.log.info(
        "assist.answered",
        reference=shipment.reference,
        confidence=round(answer.confidence, 2),
        grounded=answer.grounded,
    )
    return StepResult()


async def _thread(
    ctx: StepContext, answer_id: UUID
) -> tuple[str | None, list[tuple[str, str]]]:
    """The question being answered, and what came before it.

    `answer_id` is the empty assistant row the dashboard created; the question
    is the user turn immediately preceding it.
    """
    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            "SELECT shipment_id, user_id, created_at FROM assistant_messages"
            " WHERE id = %s",
            (answer_id,),
        )
        pending = await cur.fetchone()
        if pending is None:
            return None, []

        cur = await conn.execute(
            "SELECT role, body FROM assistant_messages"
            " WHERE shipment_id = %s AND user_id IS NOT DISTINCT FROM %s"
            "   AND created_at < %s AND body IS NOT NULL AND state = 'DONE'"
            " ORDER BY created_at DESC LIMIT 8",
            (pending["shipment_id"], pending["user_id"], pending["created_at"]),
        )
        rows = list(reversed(await cur.fetchall()))

    if not rows or rows[-1]["role"] != "user":
        return None, []

    question = rows[-1]["body"]
    history = [(r["role"], r["body"]) for r in rows[:-1]]
    return question, history


async def _fail(ctx: StepContext, answer_id: UUID, message: str) -> None:
    async with ctx.db.connection() as conn:
        await conn.execute(
            "UPDATE assistant_messages SET body = %s, state = 'FAILED' WHERE id = %s",
            (message, answer_id),
        )
