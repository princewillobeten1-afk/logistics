"""What the support agent delegated, carried out.

Each of these is an ordinary step the orchestrator routes, which is the point:
the support agent hands work to the orchestrator and the orchestrator hands it
to whoever does it. None of them bypasses a gate that applies elsewhere.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from logistics.domain.events import EventDraft
from logistics.domain.models import StepResult
from logistics.handlers.base import PermanentFailure, StepContext, handler
from logistics.orchestrator.orchestrator import Orchestrator
from logistics.orchestrator.queue import WorkQueue
from logistics.shipments import ShipmentRepo
from logistics.support.wpcargo import (
    WPCargoSubmission,
    status_for_shipment_state,
    submit_wpcargo_shipment,
)

# A contact may create at most this many shipments an hour. Anyone can message
# a Telegram bot — there is no authentication — so this is what stops one
# conversation turning into fifty inventory reservations.
MAX_SHIPMENTS_PER_HOUR = 5

RATE_LIMITED_REPLY = (
    "You have placed several bookings in the last hour, so I have paused new "
    "ones for a moment. Someone from the team will be in touch shortly."
)


@handler("support.create_shipment")
async def create_shipment(ctx: StepContext) -> StepResult:
    """Create a shipment from a chat conversation, register customer details on
    the WPCargo portal when configured, and hand it to the orchestrator pipeline."""
    payload = ctx.item.payload
    contact_id = payload.get("contact_id")
    order = payload.get("order") or {}

    if not contact_id:
        raise PermanentFailure("support.create_shipment requires a contact_id")
    required = ("destination", "pickup", "quantity", "weight_kg")
    if not all(order.get(f) for f in required):
        # `delegate.py` only sends complete orders; reaching here means the
        # payload was tampered with or hand-enqueued.
        raise PermanentFailure("refusing to create a shipment from an incomplete order")

    contact = UUID(contact_id)

    if await _recent_count(ctx, contact) >= MAX_SHIPMENTS_PER_HOUR:
        ctx.log.warning("support.rate_limited", contact_id=contact_id)
        await _tell_customer(ctx, contact, RATE_LIMITED_REPLY)
        return StepResult()

    fallback_reference = await _unique_reference(ctx)
    wpcargo_submission: WPCargoSubmission | None = None

    if ctx.settings.has_wpcargo:
        try:
            wpcargo_submission = await submit_wpcargo_shipment(
                ctx.settings,
                order,
                fallback_reference=fallback_reference,
            )
        except Exception as exc:  # noqa: BLE001
            ctx.log.warning("support.wpcargo_sync_failed", error=str(exc))

    reference = await _resolve_reference(
        ctx,
        preferred=wpcargo_submission.reference if wpcargo_submission else None,
        fallback=fallback_reference,
    )
    deadline = _parse_deadline(order.get("deadline"))

    origin_data: dict[str, Any] = {
        "address": order["pickup"],
        "city": _city_of(order["pickup"]),
    }
    if order.get("shipper_name"):
        origin_data["contact_name"] = order["shipper_name"]
    if order.get("shipper_phone"):
        origin_data["contact_phone"] = order["shipper_phone"]
    if order.get("shipper_email"):
        origin_data["contact_email"] = order["shipper_email"]
    if wpcargo_submission is not None:
        origin_data["wpcargo_post_id"] = wpcargo_submission.post_id
        origin_data["wpcargo_edit_url"] = wpcargo_submission.edit_url

    destination_data: dict[str, Any] = {
        "address": order["destination"],
        "city": _city_of(order["destination"]),
    }
    if order.get("receiver_name"):
        destination_data["contact_name"] = order["receiver_name"]
    if order.get("receiver_phone"):
        destination_data["contact_phone"] = order["receiver_phone"]
    if order.get("receiver_email"):
        destination_data["contact_email"] = order["receiver_email"]

    cargo_data: dict[str, Any] = {
        "sku": "DEFAULT",
        "quantity": int(order["quantity"]),
        "weight_kg": float(order["weight_kg"]) if order.get("weight_kg") else None,
        "description": order.get("description"),
    }
    if order.get("piece_type"):
        cargo_data["piece_type"] = order["piece_type"]

    repo = ShipmentRepo(ctx.db)
    shipment = await repo.create(
        reference=reference,
        origin=origin_data,
        destination=destination_data,
        cargo=cargo_data,
        deadline=deadline,
    )

    # Provenance: an operator should see at a glance what arrived from an
    # unauthenticated chat rather than through the API.
    async with ctx.db.connection() as conn:
        await conn.execute(
            "UPDATE shipments SET created_via = 'CHAT', origin_contact_id = %s"
            " WHERE id = %s",
            (contact, shipment.id),
        )
        if order.get("shipper_name"):
            await conn.execute(
                "UPDATE channel_contacts"
                "   SET last_shipment_id = %s, draft = NULL,"
                "       display_name = COALESCE(display_name, %s)"
                " WHERE id = %s",
                (shipment.id, order["shipper_name"], contact),
            )
        else:
            await conn.execute(
                "UPDATE channel_contacts SET last_shipment_id = %s, draft = NULL"
                " WHERE id = %s",
                (shipment.id, contact),
            )
        await conn.execute(
            "UPDATE communications SET shipment_id = %s WHERE id = %s",
            (shipment.id, UUID(payload["communication_id"])),
        )
        if wpcargo_submission is not None:
            from psycopg.types.json import Jsonb

            await conn.execute(
                """
                INSERT INTO shipment_events
                    (shipment_id, seq, type, payload, actor)
                VALUES (
                    %s,
                    COALESCE((SELECT max(seq) FROM shipment_events WHERE shipment_id = %s), 0) + 1,
                    'wpcargo.registered',
                    %s,
                    'agent:support'
                )
                """,
                (
                    shipment.id,
                    shipment.id,
                    Jsonb(
                        {
                            "post_id": wpcargo_submission.post_id,
                            "reference": wpcargo_submission.reference,
                            "edit_url": wpcargo_submission.edit_url,
                        }
                    ),
                ),
            )

    # Hand it to the orchestrator, which routes it to order.validate and the
    # rest of the pipeline. This is the delegation the whole design turns on.
    await Orchestrator(
        ctx.db, WorkQueue(ctx.db, ctx.settings), repo, ctx.settings
    ).start(shipment.id)

    ctx.log.info(
        "support.shipment_created",
        reference=reference,
        contact_id=contact_id,
        wpcargo_post_id=wpcargo_submission.post_id if wpcargo_submission else None,
    )

    await _tell_customer(
        ctx,
        contact,
        f"Booked — your reference is {reference}. I am arranging transport now "
        f"and will keep you updated. You can ask me about it any time using "
        f"that reference.",
        shipment_id=shipment.id,
    )

    return StepResult()


@handler("wpcargo.sync")
async def sync_wpcargo(ctx: StepContext) -> StepResult:
    """Publish an existing shipment created via web/API/omnichannel intake onto
    the configured WordPress WPCargo admin portal, idempotently."""
    shipment = ctx.require_shipment()
    if not ctx.settings.has_wpcargo:
        ctx.log.info("wpcargo.sync_skipped_unconfigured", reference=shipment.reference)
        return StepResult()

    origin = dict(shipment.origin or {})
    if origin.get("wpcargo_post_id"):
        ctx.log.info(
            "wpcargo.sync_already_registered",
            reference=shipment.reference,
            post_id=origin.get("wpcargo_post_id"),
        )
        return StepResult()

    destination = dict(shipment.destination or {})
    cargo = dict(shipment.cargo or {})
    plan = dict(shipment.plan or {})
    payload = ctx.item.payload or {}

    preferred_mode = str(
        cargo.get("preferred_mode")
        or (plan.get("modes")[0] if isinstance(plan.get("modes"), list) and plan.get("modes") else "")
        or ""
    ).upper()
    wpcargo_mode = (
        "Air Freight"
        if preferred_mode == "AIR"
        else "Sea Transport"
        if preferred_mode == "SEA"
        else None
    )
    wpcargo_type = (
        "Air Freight"
        if preferred_mode == "AIR"
        else "International Shipping"
        if preferred_mode == "SEA"
        else None
    )

    pickup = str(origin.get("address") or origin.get("city") or "")
    dest = str(destination.get("address") or destination.get("city") or "")
    order: dict[str, Any] = {
        "pickup": pickup,
        "destination": dest,
        "origin_country": origin.get("country"),
        "destination_country": destination.get("country"),
        "mode": wpcargo_mode,
        "shipment_type": wpcargo_type,
        "description": str(cargo.get("description") or "General Cargo"),
        "quantity": cargo.get("quantity") or 1,
        "weight_kg": cargo.get("weight_kg"),
        "piece_type": cargo.get("piece_type") or "Carton",
        "deadline": shipment.deadline.isoformat() if shipment.deadline else None,
        "shipper_name": str(
            origin.get("contact_name") or payload.get("customerName") or ""
        ),
        "shipper_phone": str(origin.get("contact_phone") or ""),
        "shipper_email": str(
            origin.get("contact_email") or payload.get("customerEmail") or ""
        ),
        "receiver_name": str(destination.get("contact_name") or ""),
        "receiver_phone": str(destination.get("contact_phone") or ""),
        "receiver_email": str(destination.get("contact_email") or ""),
        "status": status_for_shipment_state(str(shipment.state)),
        "remarks": (
            f"Synced autonomously from Control Tower ({payload.get('sourceChannel', 'PORTAL')}) "
            f"for shipment {shipment.reference}."
        ),
    }

    submission = await submit_wpcargo_shipment(
        ctx.settings,
        order,
        fallback_reference=shipment.reference,
        prefer_generated=False,
    )

    origin["wpcargo_post_id"] = submission.post_id
    origin["wpcargo_reference"] = submission.reference
    origin["wpcargo_edit_url"] = submission.edit_url

    ctx.log.info(
        "wpcargo.synced",
        reference=shipment.reference,
        wpcargo_post_id=submission.post_id,
        wpcargo_reference=submission.reference,
    )

    return StepResult(
        patch={"origin": origin},
        events=(
            EventDraft(
                type="wpcargo.registered",
                actor="agent:support",
                payload={
                    "post_id": submission.post_id,
                    "reference": submission.reference,
                    "edit_url": submission.edit_url,
                },
            ),
        ),
    )


@handler("support.change_request")
async def change_request(ctx: StepContext) -> StepResult:
    """Route a customer's change request through the policy gate.

    Never applies the change. `address_change` and `cancellation` are already
    approval-required in the active policy, so this lands in the approval queue
    and an operator decides.
    """
    from logistics.approvals import ApprovalRepo
    from logistics.domain.events import EventType
    from logistics.domain.models import WorkRequest
    from logistics.orchestrator.policy import Decision

    shipment = ctx.require_shipment()
    policy = ctx.require_policy()
    payload = ctx.item.payload

    kind = payload.get("kind", "other")
    detail = payload.get("detail", "")

    proposal = await policy.propose(
        shipment_id=shipment.id,
        action=_ACTION_FOR.get(kind, "change_delivery_address"),
        params={
            "address_changed": kind == "address",
            "cancelling": kind == "cancellation",
            "requested_by": "customer",
            "detail": detail,
            "channel": "chat",
        },
        tier=2,
        rationale=f"Customer asked via chat: {detail}",
        work_item_id=ctx.item.id,
    )

    events: list[EventDraft] = [
        EventDraft(
            type="customer.change_requested",
            actor="agent:support",
            payload={
                "kind": kind,
                "detail": detail,
                "decision": str(proposal.result.decision),
            },
        ),
    ]
    follow_up: list[WorkRequest] = []

    if proposal.result.decision is Decision.REQUIRE_APPROVAL:
        label = "Cancellation" if kind == "cancellation" else "Delivery change"
        approval = await ApprovalRepo(ctx.db).request(
            proposed_action_id=proposal.id,
            shipment_id=shipment.id,
            summary=f"{shipment.reference}: {label} requested by customer — {detail}",
        )
        events.append(
            EventDraft(
                type=EventType.APPROVAL_REQUESTED,
                actor="agent:support",
                payload={
                    "approval_id": str(approval.id),
                    "summary": approval.summary,
                    "expires_at": approval.expires_at.isoformat(),
                },
            )
        )
        follow_up.append(
            WorkRequest(
                kind="approval.escalate",
                shipment_id=shipment.id,
                payload={"approval_id": str(approval.id)},
                run_after=approval.escalate_at,
                dedupe_key=f"escalate:{approval.id}",
            )
        )

    ctx.log.info(
        "support.change_requested",
        kind=kind,
        decision=str(proposal.result.decision),
        reference=shipment.reference,
    )

    return StepResult(
        events=tuple(events),
        enqueue=tuple(follow_up),
    )


_ACTION_FOR = {
    "address": "change_delivery_address",
    "delivery_window": "change_delivery_address",
    "cancellation": "cancel_shipment",
}


@handler("support.escalate")
async def escalate(ctx: StepContext) -> StepResult:
    """Flag a conversation for a person."""
    payload = ctx.item.payload
    contact_id = payload.get("contact_id")
    reason = payload.get("reason") or "needs a person"

    if not contact_id:
        raise PermanentFailure("support.escalate requires a contact_id")

    async with ctx.db.connection() as conn:
        await conn.execute(
            """
            UPDATE channel_contacts
               SET escalated_at = now(), escalation_reason = %s
             WHERE id = %s
            """,
            (reason[:500], UUID(contact_id)),
        )

    ctx.log.warning("support.escalated", contact_id=contact_id, reason=reason)

    if ctx.shipment is not None:
        return StepResult(
            events=(
                EventDraft(
                    type="customer.escalated",
                    actor="agent:support",
                    payload={"reason": reason},
                ),
            )
        )
    return StepResult()


# ------------------------------------------------------------- internals


async def _recent_count(ctx: StepContext, contact_id: UUID) -> int:
    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT count(*) AS n FROM shipments
             WHERE origin_contact_id = %s AND created_at > now() - interval '1 hour'
            """,
            (contact_id,),
        )
        return (await cur.fetchone())["n"]


async def _resolve_reference(
    ctx: StepContext, *, preferred: str | None, fallback: str
) -> str:
    if not preferred:
        return fallback
    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            "SELECT 1 FROM shipments WHERE reference = %s", (preferred,)
        )
        if await cur.fetchone() is None:
            return preferred
    return fallback


async def _unique_reference(ctx: StepContext) -> str:
    """A short, unguessable-ish reference. Retries on the rare collision rather
    than trusting a random string to be unique."""
    for _ in range(6):
        candidate = f"CX-{secrets.token_hex(3).upper()}"
        async with ctx.db.connection() as conn:
            cur = await conn.execute(
                "SELECT 1 FROM shipments WHERE reference = %s", (candidate,)
            )
            if await cur.fetchone() is None:
                return candidate
    raise PermanentFailure("could not allocate a unique shipment reference")


def _parse_deadline(value: Any) -> datetime | None:
    if not value:
        return None
    from datetime import date

    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        try:
            parsed = datetime.combine(date.fromisoformat(str(value)), datetime.min.time())
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    # A deadline already past is a misparse, not a requirement.
    return parsed if parsed > datetime.now(UTC) else None


def _city_of(address: str) -> str | None:
    """Best-effort city from a free-text address, for the lane table.

    Deliberately crude: planning falls back to an unknown lane and flags low
    confidence, which is better than a wrong city confidently applied.
    """
    known = ("Lagos", "Abuja", "Ibadan", "Kano", "Port Harcourt", "Tema", "Accra")
    lowered = (address or "").lower()
    for city in known:
        if city.lower() in lowered:
            return city
    return None


async def _tell_customer(
    ctx: StepContext, contact_id: UUID, text: str, *, shipment_id: UUID | None = None
) -> None:
    """Send a follow-up on the contact's own channel."""
    from logistics.channels.base import ChannelKind, Outbound
    from logistics.channels.inbound import record_outbound
    from logistics.channels.registry import provider_for
    from logistics.channels.store import ChannelStore

    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            "SELECT channel, external_id FROM channel_contacts WHERE id = %s",
            (contact_id,),
        )
        contact = await cur.fetchone()

    if contact is None:
        return

    channel = ChannelKind(contact["channel"])
    delivered = False

    if channel is not ChannelKind.WIDGET:
        store = ChannelStore(ctx.db)
        connection = await store.get(channel)
        if connection is not None and connection.live:
            try:
                delivered = await provider_for(channel).send(
                    await store.credentials(channel),
                    connection.config,
                    Outbound(external_id=contact["external_id"], text=text),
                )
            except Exception as exc:  # noqa: BLE001
                ctx.log.warning("support.followup_failed", error=str(exc))
    else:
        delivered = True

    await record_outbound(
        ctx.db,
        contact_id=contact_id,
        shipment_id=shipment_id,
        channel=channel,
        text=text,
        recipient=contact["external_id"],
        delivered=delivered,
    )
