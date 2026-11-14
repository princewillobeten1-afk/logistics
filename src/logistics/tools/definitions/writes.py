"""Tools that change something.

Tier 1 writes our own records. Tier 2 leaves the building. Tier 3 commits
money. Everything here passes `PolicyEngine` before it runs, and everything at
tier 2 or above goes through the idempotent executor, so a retry after a
timeout reconciles rather than doing it twice.

The two money tools do **not** re-implement booking. `handlers/book.py` is the
only code that tenders to a carrier, and it stays that way: a second
implementation would drift, and the one that drifts is the one that spends
money without the guards. These tools do what the dashboard's Approve button
does — record a decision and enqueue the existing gated path.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from logistics.tools.registry import Tier, ToolContext, tool


# ------------------------------------------------------------- inventory


class ReserveInventory(BaseModel):
    reference: str = Field(description="Shipment reference.")
    sku: str = Field(description="Stock keeping unit.")
    warehouse: str = Field(description="Warehouse code to reserve from.")
    quantity: int = Field(gt=0, description="Units to hold. Must be positive.")


@tool(
    "reserve_inventory",
    tier=Tier.INTERNAL,
    description=(
        "Hold stock for a shipment. All or nothing: if the warehouse cannot "
        "cover the quantity, nothing is reserved and the reason is returned. "
        "Reserving twice for the same shipment does not take the stock twice."
    ),
    args=ReserveInventory,
    action="reserve_inventory",
)
async def reserve_inventory(ctx: ToolContext, args: ReserveInventory) -> dict[str, Any]:
    from logistics.inventory import PostgresInventory
    from logistics.shipments import ShipmentRepo

    shipment = await ShipmentRepo(ctx.db).get_by_reference(args.reference)
    if shipment is None:
        return {"ok": False, "reason": f"no shipment {args.reference}"}

    result = await PostgresInventory(ctx.db).reserve(
        shipment.id,
        args.sku,
        [{"warehouse": args.warehouse, "quantity": args.quantity}],
    )
    return {
        "ok": result.ok,
        "reserved": result.held,
        "reason": result.reason,
        "lines": result.reserved,
    }


class ReleaseInventory(BaseModel):
    reference: str = Field(description="Shipment reference.")
    consume: bool = Field(
        default=False,
        description=(
            "True once the goods have actually shipped, which decrements stock "
            "on hand. False gives the reservation back."
        ),
    )


@tool(
    "release_inventory",
    tier=Tier.INTERNAL,
    description=(
        "Give a shipment's reserved stock back, or mark it consumed once the "
        "goods have left."
    ),
    args=ReleaseInventory,
    action="release_inventory",
)
async def release_inventory(ctx: ToolContext, args: ReleaseInventory) -> dict[str, Any]:
    from logistics.inventory import PostgresInventory
    from logistics.shipments import ShipmentRepo

    shipment = await ShipmentRepo(ctx.db).get_by_reference(args.reference)
    if shipment is None:
        return {"released": 0, "reason": f"no shipment {args.reference}"}

    released = await PostgresInventory(ctx.db).release(
        shipment.id, consume=args.consume
    )
    return {"released": released, "consumed": args.consume}


# -------------------------------------------------------------- approvals


class CreateApprovalRequest(BaseModel):
    reference: str = Field(description="Shipment reference.")
    proposed_action_id: str = Field(
        description="The gated proposal this approval decides. Required: an "
        "approval with nothing behind it authorises nothing."
    )
    summary: str = Field(
        min_length=10,
        description="What the approver is being asked to allow, in one sentence.",
    )
    amount_minor: int | None = Field(
        default=None,
        description="Cost in minor units — kobo, cents. Never a decimal.",
    )
    currency: str = Field(default="NGN", min_length=3, max_length=3)

    @field_validator("amount_minor")
    @classmethod
    def _whole_units(cls, v: int | None) -> int | None:
        # A float here would round somewhere and the rounding would be money.
        if isinstance(v, float):
            raise ValueError("amount_minor is minor units and must be a whole number")
        return v


@tool(
    "create_approval_request",
    tier=Tier.INTERNAL,
    description=(
        "Ask a human to decide something. Use this instead of guessing when "
        "the right answer depends on information the system does not hold."
    ),
    args=CreateApprovalRequest,
    action="create_approval_request",
)
async def create_approval_request(
    ctx: ToolContext, args: CreateApprovalRequest
) -> dict[str, Any]:
    from logistics.approvals import ApprovalRepo
    from logistics.shipments import ShipmentRepo

    shipment = await ShipmentRepo(ctx.db).get_by_reference(args.reference)
    if shipment is None:
        return {"ok": False, "reason": f"no shipment {args.reference}"}

    approval = await ApprovalRepo(ctx.db).request(
        proposed_action_id=UUID(args.proposed_action_id),
        shipment_id=shipment.id,
        summary=args.summary,
        amount_minor=args.amount_minor,
        currency=args.currency,
    )
    return {
        "ok": True,
        "approval_id": str(approval.id),
        "expires_at": approval.expires_at.isoformat(),
        # The token is a bearer credential that authorises spending. It goes to
        # the approver through the approvals page, never into a tool response a
        # model will read and might repeat.
    }


# --------------------------------------------------------------- messages


class SendMessage(BaseModel):
    channel: str = Field(description="TELEGRAM, WHATSAPP, GMAIL or WIDGET.")
    to: str = Field(description="Channel-specific address: chat id, phone, email.")
    text: str = Field(min_length=1, max_length=4000)
    reference: str | None = Field(
        default=None, description="Shipment this concerns, if any."
    )

    @field_validator("channel")
    @classmethod
    def _known(cls, v: str) -> str:
        from logistics.channels.base import ChannelKind

        try:
            return str(ChannelKind(v.upper()))
        except ValueError:
            raise ValueError(
                f"unknown channel {v!r}; one of "
                f"{', '.join(str(k) for k in ChannelKind)}"
            ) from None


@tool(
    "send_message",
    tier=Tier.EXTERNAL,
    description=(
        "Send a message to a customer or carrier on a configured channel. "
        "This cannot be unsent, so say something you would be willing to have "
        "quoted back."
    ),
    args=SendMessage,
    action="send_message",
    key_fields=("channel", "to", "text"),
)
# Under the seeded phase-1 policy this always returns REQUIRE_APPROVAL: there
# is no `send_message` rule, and tier 2 is not in `auto_execute_tiers`.
#
# That is stricter than the rest of the system, and the difference is worth
# knowing before this tool is wired into anything. Messages an agent *decides*
# to send are already gated — `exception.py` proposes every resolution at its
# tier, and `support_actions.py` proposes change requests. What is not gated is
# `support.reply`: answering a customer's question goes out without consulting
# policy, which is arguably right, since a reply is a conversation rather than
# an action.
#
# So this tool sits at the strict end. Making it auto-approve would have been a
# decision about risk posture disguised as an implementation detail; the rule is
# one line of JSON in a new policy version whenever that posture is settled.
async def send_message(ctx: ToolContext, args: SendMessage) -> dict[str, Any]:
    from logistics.channels.base import ChannelKind, Outbound
    from logistics.channels.registry import provider_for
    from logistics.channels.store import ChannelStore

    channel = ChannelKind(args.channel)

    if channel is ChannelKind.WIDGET:
        # The widget polls its own conversation, so the stored row is delivery.
        return {"delivered": True, "channel": args.channel, "via": "widget"}

    store = ChannelStore(ctx.db)
    connection = await store.get(channel)
    if connection is None or not connection.live:
        # Not an exception: a channel being down is an operational fact the
        # caller should see and decide about, not a crash.
        return {
            "delivered": False,
            "channel": args.channel,
            "reason": "channel is not connected and verified",
        }

    delivered = await provider_for(channel).send(
        await store.credentials(channel),
        connection.config,
        Outbound(external_id=args.to, text=args.text, subject="Shipment update"),
    )
    return {"delivered": bool(delivered), "channel": args.channel}


# ------------------------------------------------------------------ money


class BookCarrier(BaseModel):
    reference: str = Field(description="Shipment reference.")
    carrier_code: str = Field(description="Carrier to book, e.g. T-PREMIUM.")
    amount_minor: int = Field(
        ge=0,
        description=(
            "The quoted price in minor units — kobo, not naira. This is what "
            "the spend caps are checked against, so it must be the carrier's "
            "actual quoted figure; it is verified against the quote before "
            "anything is booked."
        ),
    )
    currency: str = Field(default="NGN", min_length=3, max_length=3)
    round: int | None = Field(
        default=None, description="Quoting round. Defaults to the current one."
    )


@tool(
    "book_carrier",
    tier=Tier.SPEND,
    description=(
        "Commit a shipment to a carrier at their quoted price. This spends "
        "money and needs an approved quote to spend it against."
    ),
    args=BookCarrier,
    action="book_shipment",
    key_fields=("reference", "carrier_code", "round"),
)
async def book_carrier(ctx: ToolContext, args: BookCarrier) -> dict[str, Any]:
    """Selects the quote and hands off to `carrier.book`.

    Note what this does *not* do: tender. The policy gate above already ran —
    reaching here means ALLOW — and `handlers/book.py` re-checks the proposal,
    re-reads the amount from the quote row rather than trusting a payload, and
    tenders through the executor with reconciliation on a lost response. Doing
    any of that a second time here would mean two booking paths with different
    guards.

    The caller states the price because the gate runs *before* this function
    and has to have a number to check against the caps. That makes the number
    an assertion, not a fact, so it is checked against the quote row below and
    a mismatch refuses outright — otherwise an agent could clear a ₦500k cap by
    claiming ₦400k and then book whatever the quote actually said.
    """
    from logistics.carriers.repo import CarrierRepo, QuoteRepo
    from logistics.orchestrator.queue import WorkQueue
    from logistics.domain.models import WorkRequest
    from logistics.shipments import ShipmentRepo

    shipment = await ShipmentRepo(ctx.db).get_by_reference(args.reference)
    if shipment is None:
        return {"ok": False, "reason": f"no shipment {args.reference}"}

    quotes = QuoteRepo(ctx.db)
    round_no = args.round or await quotes.current_round(shipment.id)

    # `for_round` rather than `usable`: the raw rows carry the carrier's code,
    # and RECEIVED is filtered here so the refusal can say *why* — an
    # UNPARSEABLE reply is not a cheap quote, and an agent that is told
    # "no quote" when one was merely unreadable will keep asking.
    rows = await quotes.for_round(shipment.id, round_no)
    wanted = args.carrier_code.strip().upper()
    match = next(
        (r for r in rows if (r["carrier_code"] or "").upper() == wanted), None
    )

    if match is None:
        offered = sorted((r["carrier_code"] or "?") for r in rows)
        return {
            "ok": False,
            "reason": (
                f"{args.carrier_code} did not quote round {round_no}; "
                f"quotes came from: {', '.join(offered) or 'nobody'}"
            ),
        }
    if match["state"] != "RECEIVED":
        return {
            "ok": False,
            "reason": (
                f"{args.carrier_code}'s quote for round {round_no} is "
                f"{match['state']}, not a usable price"
            ),
        }

    # The gate was told a price. If the quote says something else, the decision
    # that authorised this was made about the wrong number and does not apply.
    quoted, currency = match["amount_minor"], match["currency"]
    if quoted != args.amount_minor or (currency or "") != args.currency:
        return {
            "ok": False,
            "reason": (
                f"quoted price is {quoted} {currency}, not "
                f"{args.amount_minor} {args.currency}; the approval was for a "
                "different amount, so nothing was booked"
            ),
        }

    carrier = await CarrierRepo(ctx.db).get(match["carrier_id"])
    if carrier is None:
        return {"ok": False, "reason": "carrier no longer exists"}

    await quotes.select(shipment.id, carrier.id, round_no)

    # The proposal the gate just wrote is what `carrier.book` will re-check.
    await WorkQueue(ctx.db).enqueue(
        WorkRequest(
            kind="carrier.book",
            shipment_id=shipment.id,
            payload={
                "proposed_action_id": str(ctx.proposal_id) if ctx.proposal_id else None,
                "round": round_no,
            },
            dedupe_key=f"book:{shipment.id}:{round_no}",
            priority=10,
        )
    )
    return {
        "ok": True,
        "queued": "carrier.book",
        "carrier": carrier.code,
        "round": round_no,
    }


class RerouteShipment(BaseModel):
    reference: str = Field(description="Shipment reference.")
    reason: str = Field(min_length=10, description="Why the route is changing.")
    amount_minor: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Estimated additional cost in minor units. Leave unset only when "
            "genuinely unknown — an unpriced reroute cannot be checked against "
            "the caps and so always goes to a human."
        ),
    )
    currency: str = Field(default="NGN", min_length=3, max_length=3)
    new_destination: str | None = Field(
        default=None, description="Only when the destination itself changes."
    )


@tool(
    "reroute_shipment",
    tier=Tier.SPEND,
    description=(
        "Change a shipment's route mid-journey. Costs money and disrupts a "
        "plan other steps depend on, so it always reaches a human first."
    ),
    args=RerouteShipment,
    action="reroute_vehicle",
    key_fields=("reference", "reason"),
)
async def reroute_shipment(ctx: ToolContext, args: RerouteShipment) -> dict[str, Any]:
    from logistics.domain.models import WorkRequest
    from logistics.orchestrator.queue import WorkQueue
    from logistics.shipments import ShipmentRepo

    shipment = await ShipmentRepo(ctx.db).get_by_reference(args.reference)
    if shipment is None:
        return {"ok": False, "reason": f"no shipment {args.reference}"}

    await WorkQueue(ctx.db).enqueue(
        WorkRequest(
            kind="planning.plan",
            shipment_id=shipment.id,
            payload={
                "reroute": True,
                "reason": args.reason,
                "new_destination": args.new_destination,
                "proposed_action_id": str(ctx.proposal_id) if ctx.proposal_id else None,
            },
            dedupe_key=f"reroute:{shipment.id}:{ctx.work_item_id or 'adhoc'}",
            priority=10,
        )
    )
    return {"ok": True, "queued": "planning.plan", "reference": args.reference}
