"""Channel steps: poll for inbound, answer, reply on the same channel.

`support.reply` is rewritten here to close the loop — it now sends the answer
back the way the question arrived, rather than only writing an outbound row.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

from logistics.channels.base import ChannelKind, ChannelStatus, Outbound
from logistics.channels.inbound import ASK_FOR_REFERENCE, InboundRouter, record_outbound
from logistics.channels.registry import provider_for
from logistics.channels.safety import screen
from logistics.channels.store import ChannelStore
from logistics.domain.events import EventDraft
from logistics.domain.models import StepResult, WorkRequest
from logistics.handlers.base import PermanentFailure, StepContext, handler
from logistics.support import Delegation, Intent, build_view, decide, normalise, plan_delegation

# Channels that must be polled. WhatsApp and the widget push to endpoints.
POLLED = (ChannelKind.TELEGRAM, ChannelKind.GMAIL)

POLL_INTERVAL = timedelta(seconds=20)


@handler("channels.poll")
async def poll(ctx: StepContext) -> StepResult:
    """Fetch new customer messages from every live polled channel.

    Reschedules itself, so one enqueue keeps every channel listening.
    """
    store = ChannelStore(ctx.db)
    router = InboundRouter(ctx.db)
    follow_up: list[WorkRequest] = []
    fetched = 0

    for kind in POLLED:
        connection = await store.get(kind)
        if connection is None or not connection.live:
            continue

        provider = provider_for(kind)
        try:
            credentials = await store.credentials(kind)
            messages, cursor = await provider.fetch(
                credentials, connection.config, connection.cursor
            )
        except Exception as exc:  # noqa: BLE001
            # One broken channel must not stop the others.
            ctx.log.warning("channels.fetch_failed", channel=str(kind), error=str(exc))
            await store.record_error(kind, str(exc))
            continue

        for message in messages:
            routed = await router.route(message)
            if routed is None:
                continue  # provider redelivered something already handled
            fetched += 1
            follow_up.append(
                WorkRequest(
                    kind="support.reply",
                    shipment_id=routed.shipment_id,
                    payload={"communication_id": str(routed.communication_id)},
                    dedupe_key=f"support:{routed.communication_id}",
                    priority=5,
                )
            )

        if cursor != connection.cursor:
            await store.record_cursor(kind, cursor)

    if fetched:
        ctx.log.info("channels.polled", messages=fetched)

    next_run = datetime.now(UTC) + POLL_INTERVAL
    follow_up.append(
        WorkRequest(
            kind="channels.poll",
            run_after=next_run,
            dedupe_key=f"poll:{int(next_run.timestamp() // 10)}",
            priority=200,
        )
    )
    return StepResult(enqueue=tuple(follow_up))


@handler("support.reply")
async def reply(ctx: StepContext) -> StepResult:
    """Read a customer message, answer it, and delegate whatever it asked for.

    The model decides what to say and what the customer wants. It does not
    decide whether anything happens — `plan_delegation` maps the intent to
    work, and the policy gate decides whether that work may proceed.
    """
    message_id = ctx.item.payload.get("communication_id")
    if not message_id:
        raise PermanentFailure("support.reply requires a communication_id")

    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT m.id, m.body, m.subject, m.shipment_id, m.contact_id,
                   m.channel, m.external_ref, m.recipient, s.reference,
                   c.draft
              FROM communications m
              LEFT JOIN shipments s ON s.id = m.shipment_id
              LEFT JOIN channel_contacts c ON c.id = m.contact_id
             WHERE m.id = %s AND m.direction = 'INBOUND'
            """,
            (UUID(message_id),),
        )
        inbound = await cur.fetchone()

    if inbound is None:
        raise PermanentFailure(f"no inbound message {message_id}")

    channel = ChannelKind(inbound["channel"])

    # Screen before the reasoning agent sees it. A third layer under fencing
    # and the policy gate — advisory, so a flagged message is still answered
    # but a person gets to see it.
    verdict = await screen(ctx.require_llm(), inbound["body"] or "")
    async with ctx.db.connection() as conn:
        await conn.execute(
            "UPDATE communications SET safety_checked = %s, safety_verdict = %s"
            " WHERE id = %s",
            (verdict.checked, verdict.verdict, inbound["id"]),
        )

    view = (
        await build_view(ctx.db, inbound["reference"]) if inbound["reference"] else None
    )

    decision = await decide(
        ctx.require_llm(),
        message=inbound["body"] or "",
        view=view,
        draft=inbound["draft"],
        history=await _history(ctx, inbound["contact_id"], inbound["id"]),
        shipment_id=inbound["shipment_id"],
        work_item_id=ctx.item.id,
    )

    # A status question with no shipment attached: ask for the reference rather
    # than answering about a shipment we have not identified.
    text = decision.reply
    if view is None and decision.intent is Intent.STATUS:
        text = ASK_FOR_REFERENCE

    delegation = _delegate(ctx, decision, inbound)
    await _persist_draft(ctx, inbound["contact_id"], delegation.draft)

    if verdict.needs_human and inbound["contact_id"]:
        # Flagged content is answered but escalated. Dropping a customer's
        # message because a classifier disliked it is its own failure.
        delegation = Delegation(
            requests=(
                *delegation.requests,
                WorkRequest(
                    kind="support.escalate",
                    shipment_id=inbound["shipment_id"],
                    payload={
                        "contact_id": str(inbound["contact_id"]),
                        "communication_id": str(inbound["id"]),
                        "reason": f"safety screen flagged this as {verdict.verdict}",
                    },
                    dedupe_key=f"safety:{inbound['id']}",
                    priority=5,
                ),
            ),
            draft=delegation.draft,
            reason=f"{delegation.reason}; flagged {verdict.verdict}",
        )

    ctx.log.info(
        "support.decided",
        intent=str(decision.intent),
        confidence=round(decision.confidence, 2),
        delegated=[r.kind for r in delegation.requests],
        reason=delegation.reason,
    )

    delivered = await _send(ctx, channel, inbound, normalise(text))

    await record_outbound(
        ctx.db,
        contact_id=inbound["contact_id"],
        shipment_id=inbound["shipment_id"],
        channel=channel,
        text=text,
        subject=_reply_subject(inbound["subject"]),
        recipient=inbound["recipient"],
        delivered=delivered,
    )

    async with ctx.db.connection() as conn:
        await conn.execute(
            "UPDATE communications SET state = 'READ' WHERE id = %s", (inbound["id"],)
        )

    ctx.log.info(
        "support.replied",
        channel=str(channel),
        reference=inbound["reference"],
        delivered=delivered,
    )

    if inbound["shipment_id"]:
        return StepResult(
            events=(
                EventDraft(
                    type="customer.question_answered",
                    actor="agent:support",
                    payload={
                        "channel": str(channel),
                        "delivered": delivered,
                        "intent": str(decision.intent),
                        "delegated": [r.kind for r in delegation.requests],
                    },
                ),
            ),
            enqueue=delegation.requests,
        )

    # No shipment yet — a new booking has none until it is created — so the
    # delegated work is enqueued without a shipment event to attach it to.
    return StepResult(enqueue=delegation.requests)


def _delegate(ctx: StepContext, decision, inbound) -> Delegation:  # noqa: ANN001
    """Map the decision to orchestrator work. Pure; see support/delegate.py."""
    if inbound["contact_id"] is None:
        # Without a contact there is nobody to reply to or bill the work
        # against, so the reply is all this turn can produce.
        return Delegation(requests=(), draft=None, reason="no contact on the message")

    return plan_delegation(
        decision,
        contact_id=inbound["contact_id"],
        communication_id=inbound["id"],
        shipment_id=inbound["shipment_id"],
    )


async def _persist_draft(ctx: StepContext, contact_id, draft) -> None:  # noqa: ANN001
    """Carry booking state to the next turn, so the agent stops re-asking."""
    if contact_id is None:
        return
    from psycopg.types.json import Jsonb

    async with ctx.db.connection() as conn:
        await conn.execute(
            "UPDATE channel_contacts SET draft = %s WHERE id = %s",
            (Jsonb(draft) if draft else None, contact_id),
        )


async def _send(ctx: StepContext, channel: ChannelKind, inbound, text: str) -> bool:  # noqa: ANN001
    """Deliver on the originating channel. The widget has nothing to send to —
    it polls its own conversation — so writing the row is the delivery."""
    if channel is ChannelKind.WIDGET:
        return True
    if not inbound["recipient"]:
        return False

    store = ChannelStore(ctx.db)
    connection = await store.get(channel)
    if connection is None or connection.state is not ChannelStatus.VERIFIED:
        ctx.log.warning("support.channel_unavailable", channel=str(channel))
        return False

    try:
        return await provider_for(channel).send(
            await store.credentials(channel),
            connection.config,
            Outbound(
                external_id=inbound["recipient"],
                text=text,
                subject=_reply_subject(inbound["subject"]),
                reply_to_ref=inbound["external_ref"],
            ),
        )
    except Exception as exc:  # noqa: BLE001
        ctx.log.warning("support.send_failed", channel=str(channel), error=str(exc))
        await store.record_error(channel, str(exc))
        return False


def _reply_subject(subject: str | None) -> str | None:
    if not subject:
        return None
    return subject if subject.lower().startswith("re:") else f"Re: {subject}"


async def _history(ctx: StepContext, contact_id, before_id) -> list[dict[str, str]]:  # noqa: ANN001
    """Earlier turns with this contact, oldest first."""
    if contact_id is None:
        return []
    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT direction, body FROM communications
             WHERE contact_id = %s AND id <> %s
             ORDER BY created_at DESC LIMIT 6
            """,
            (contact_id, before_id),
        )
        rows = await cur.fetchall()

    return [
        {
            "role": "user" if r["direction"] == "INBOUND" else "assistant",
            "content": r["body"] or "",
        }
        for r in reversed(rows)
    ]
