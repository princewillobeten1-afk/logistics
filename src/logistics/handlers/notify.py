"""customer.notify — proactive outbound.

Until now the support agent only ever answered. This is the other half: the
platform telling a customer something before they ask, which is most of what
the brief's Communication Agent is for.

Delivery reuses the channel providers, so a notification goes out the way that
customer talks to us rather than through a parallel implementation.
"""

from __future__ import annotations

from logistics.channels.base import ChannelKind, Outbound
from logistics.channels.inbound import record_outbound
from logistics.channels.registry import provider_for
from logistics.channels.store import ChannelStore
from logistics.domain.events import EventDraft
from logistics.domain.models import StepResult
from logistics.handlers.base import PermanentFailure, StepContext, handler
from logistics.support import normalise


@handler("customer.notify")
async def notify(ctx: StepContext) -> StepResult:
    shipment = ctx.require_shipment()
    message = ctx.item.payload.get("message")
    reason = ctx.item.payload.get("reason", "update")

    if not message:
        raise PermanentFailure("customer.notify requires a message")

    contact = await _contact_for(ctx, shipment.id)
    if contact is None:
        # No channel to reach them on. Recorded rather than silently dropped —
        # a customer we cannot tell is a fact operations should see.
        ctx.log.info("notify.no_contact", reference=shipment.reference)
        return StepResult(
            events=(
                EventDraft(
                    type="customer.unreachable",
                    actor="agent:communication",
                    payload={"reason": reason, "message": message},
                ),
            )
        )

    channel = ChannelKind(contact["channel"])
    delivered = await _send(ctx, channel, contact["external_id"], normalise(message))

    await record_outbound(
        ctx.db,
        contact_id=contact["id"],
        shipment_id=shipment.id,
        channel=channel,
        text=message,
        recipient=contact["external_id"],
        delivered=delivered,
    )

    ctx.log.info(
        "notify.sent",
        reference=shipment.reference,
        channel=str(channel),
        delivered=delivered,
        reason=reason,
    )

    return StepResult(
        events=(
            EventDraft(
                type="customer.notified",
                actor="agent:communication",
                payload={
                    "channel": str(channel),
                    "delivered": delivered,
                    "reason": reason,
                },
            ),
        )
    )


async def _contact_for(ctx: StepContext, shipment_id):  # noqa: ANN001, ANN202
    """Whoever has been talking to us about this shipment."""
    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT id, channel, external_id FROM channel_contacts
             WHERE last_shipment_id = %s
             ORDER BY last_seen_at DESC LIMIT 1
            """,
            (shipment_id,),
        )
        return await cur.fetchone()


async def _send(ctx: StepContext, channel: ChannelKind, external_id: str, text: str) -> bool:
    if channel is ChannelKind.WIDGET:
        # The widget polls its own conversation, so the outbound row is the
        # delivery.
        return True

    store = ChannelStore(ctx.db)
    connection = await store.get(channel)
    if connection is None or not connection.live:
        ctx.log.warning("notify.channel_down", channel=str(channel))
        return False

    try:
        return await provider_for(channel).send(
            await store.credentials(channel),
            connection.config,
            Outbound(external_id=external_id, text=text, subject="Shipment update"),
        )
    except Exception as exc:  # noqa: BLE001
        ctx.log.warning("notify.failed", channel=str(channel), error=str(exc))
        await store.record_error(channel, str(exc))
        return False
