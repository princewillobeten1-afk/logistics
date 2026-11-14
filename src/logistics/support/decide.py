"""What the support agent decides to do with a message.

One structured model call per turn: classify the intent, draft the reply, and
extract any booking details. Not classify-then-reply — `CUSTOMER_CHAT` is the
highest-volume model path in the system, and two calls per message would
double the cost of the busiest thing the platform does.

The model decides *what the customer wants* and *what to say*. It does not
decide whether anything happens — `delegate.py` maps an intent to work, and the
policy gate decides whether that work may proceed. A model that misclassifies
produces a wrong reply, never a wrong action.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from logistics.llm.base import InvalidOutput, LLMClient, LLMRequest
from logistics.llm.registry import Job
from logistics.obs import get_logger
from logistics.support.prompts import DECISION_INSTRUCTIONS, SYSTEM
from logistics.support.view import CustomerView

log = get_logger(__name__)

PROMPT_VERSION = "support.decide/v1"

# Below this the agent replies but delegates nothing. An uncertain read should
# produce a question, not a shipment.
MIN_ACTION_CONFIDENCE = 0.6


class Intent(StrEnum):
    STATUS = "STATUS"
    NEW_ORDER = "NEW_ORDER"
    CHANGE_REQUEST = "CHANGE_REQUEST"
    ESCALATE = "ESCALATE"
    CHITCHAT = "CHITCHAT"


class OrderDraft(BaseModel):
    """Booking details gathered so far. Nulls are genuinely unknown."""

    shipper_name: str | None = None
    shipper_phone: str | None = None
    shipper_email: str | None = None
    pickup: str | None = None
    receiver_name: str | None = None
    receiver_phone: str | None = None
    receiver_email: str | None = None
    destination: str | None = None
    description: str | None = None
    quantity: int | None = Field(default=None, ge=1)
    weight_kg: float | None = Field(default=None, gt=0)
    deadline: str | None = Field(
        default=None, description="ISO date the customer needs it by, e.g. 2026-09-05"
    )
    piece_type: str | None = Field(
        default=None, description="Carton | Pallet | Crate | Loose | Others"
    )
    shipment_type: str | None = Field(
        default=None,
        description="Air Freight | International Shipping | Truckload | Van Move",
    )
    mode: str | None = Field(
        default=None, description="Sea Transport | Land Shipping | Air Freight"
    )
    ready: bool = False

    @model_validator(mode="after")
    def _ready_means_complete(self) -> OrderDraft:
        """`ready` is a claim about the data, so it is checked against the data.

        Without this the model could set ready=true on an empty draft and the
        agent would create a shipment with no destination.
        """
        if self.ready:
            missing = [
                name
                for name, value in (
                    ("shipper_name", self.shipper_name),
                    ("shipper_phone", self.shipper_phone),
                    ("pickup", self.pickup),
                    ("receiver_name", self.receiver_name),
                    ("receiver_phone", self.receiver_phone),
                    ("destination", self.destination),
                    ("description", self.description),
                    ("quantity", self.quantity),
                    ("weight_kg", self.weight_kg),
                )
                if not value
            ]
            if missing:
                raise ValueError(
                    f"ready is true but these are still missing: {', '.join(missing)}. "
                    "Set ready false and ask the customer for them."
                )
        return self

    def merge(self, earlier: dict[str, Any] | None) -> OrderDraft:
        """Fold in what was collected on previous turns.

        The model only reports what *this* message contained, so a customer who
        gave the destination two turns ago must not lose it.
        """
        if not earlier:
            return self
        merged = {**earlier, **{k: v for k, v in self.model_dump().items() if v is not None}}
        merged.pop("ready", None)
        draft = OrderDraft(**{**merged, "ready": False})
        return draft.model_copy(update={"ready": draft.complete})

    @property
    def complete(self) -> bool:
        """Everything required by the WPCargo shipment portal and `order.validate`.

        Shipper/receiver contact details and cargo weight are collected in
        conversation so the WPCargo shipment record is complete and the
        deterministic checks in `handlers/validate.py` pass immediately.
        """
        return bool(
            self.shipper_name
            and self.shipper_phone
            and self.pickup
            and self.receiver_name
            and self.receiver_phone
            and self.destination
            and self.description
            and self.quantity
            and self.weight_kg
        )

    @property
    def missing(self) -> list[str]:
        return [
            label
            for label, value in (
                ("sender's name", self.shipper_name),
                ("sender's phone number", self.shipper_phone),
                ("collection address", self.pickup),
                ("receiver's name", self.receiver_name),
                ("receiver's phone number", self.receiver_phone),
                ("delivery address", self.destination),
                ("what you are sending", self.description),
                ("how many items", self.quantity),
                ("roughly how much it weighs", self.weight_kg),
            )
            if not value
        ]

    def parsed_deadline(self) -> datetime | None:
        """A deadline in the past is a misread, not a requirement."""
        if not self.deadline:
            return None
        try:
            parsed = datetime.fromisoformat(self.deadline)
        except ValueError:
            try:
                parsed = datetime.combine(
                    date.fromisoformat(self.deadline), datetime.min.time()
                )
            except ValueError:
                return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed if parsed > datetime.now(UTC) else None


class ChangeRequest(BaseModel):
    kind: str = Field(description="address | delivery_window | cancellation | other")
    detail: str = Field(description="What the customer asked for, in their words")


class SupportDecision(BaseModel):
    reply: str = Field(min_length=1, description="What the customer sees")
    intent: Intent
    order: OrderDraft | None = None
    change: ChangeRequest | None = None
    escalate_reason: str | None = None
    confidence: float = Field(ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _intent_carries_its_payload(self) -> SupportDecision:
        if self.intent is Intent.CHANGE_REQUEST and self.change is None:
            raise ValueError(
                "intent is CHANGE_REQUEST but `change` is missing. Say what the "
                "customer wants changed."
            )
        return self

    @property
    def may_act(self) -> bool:
        """Confident enough to cause work. Below this the reply still goes out."""
        return self.confidence >= MIN_ACTION_CONFIDENCE


async def decide(
    llm: LLMClient,
    *,
    message: str,
    view: CustomerView | None = None,
    draft: dict[str, Any] | None = None,
    history: list[dict[str, str]] | None = None,
    shipment_id: UUID | None = None,
    work_item_id: UUID | None = None,
) -> SupportDecision:
    """Read one customer message. Never raises — an unreadable turn becomes a
    safe reply, because a customer waiting on silence is worse than a plain
    holding answer."""
    context = [DECISION_INSTRUCTIONS]

    if view is not None:
        context.append(f"\nShipment they are asking about:\n{view.as_prompt()}")
    else:
        context.append(
            "\nNo shipment is attached to this conversation. If they ask about "
            "one, ask for the reference."
        )

    if draft:
        # Tell the model exactly what it still needs rather than leaving it to
        # work that out. Observed live: asked to both converse and track state,
        # it re-asked for a destination it had already been given two turns
        # earlier. `missing` is computed here, so it cannot get it wrong.
        collected = OrderDraft(**{k: v for k, v in draft.items() if k != "ready"})
        have = "\n".join(
            f"  - {k}: {v}" for k, v in draft.items() if v is not None and k != "ready"
        )
        still_needed = collected.missing

        context.append(
            f"\nYou have ALREADY collected these booking details:\n{have}\n"
            "Do not ask for any of them again — you have them."
        )
        context.append(
            f"\nYou still need: {', '.join(still_needed)}. Ask only for these."
            if still_needed
            else "\nYou now have everything needed. Confirm the booking back to "
            "the customer rather than asking for more."
        )

    context.append(f"\nToday is {date.today().isoformat()}.")
    context.append(f"\n<customer_message>\n{message.strip()}\n</customer_message>")

    messages: list[dict[str, Any]] = [
        *(history or [])[-6:],
        {"role": "user", "content": "\n".join(context)},
    ]

    try:
        result = await llm.structured(
            LLMRequest(
                job=Job.CUSTOMER_CHAT,
                system=SYSTEM,
                messages=messages,
                agent="support",
                shipment_id=shipment_id,
                work_item_id=work_item_id,
                prompt_version=PROMPT_VERSION,
                max_tokens=900,
            ),
            SupportDecision,
        )
    except InvalidOutput as exc:
        log.warning("support.decision_unreadable", attempts=exc.attempts)
        return _fallback(view)

    decision = result.value

    if result.response.truncated:
        # A cut-off reasoning model can spill its monologue into `content`.
        # Never send that to a customer.
        log.warning("support.decision_truncated")
        return _fallback(view)

    if not decision.reply.strip():
        # `min_length=1` admits whitespace. Silence is worse than a plain
        # holding answer, and the customer is waiting either way.
        log.warning("support.decision_blank", intent=str(decision.intent))
        return _fallback(view)

    if decision.intent is Intent.NEW_ORDER and (decision.order or draft):
        # Merge unconditionally, including when the model reported no order at
        # all this turn. The draft is authoritative for what was collected
        # earlier; the model only reports what *this* message added.
        base = decision.order or OrderDraft()
        decision = decision.model_copy(update={"order": base.merge(draft)})

    return decision


def _fallback(view: CustomerView | None) -> SupportDecision:
    """Something true and useful, and no delegation."""
    if view is not None:
        reply = (
            f"Your shipment {view.reference} is currently {view.status.lower()}. "
            "Let me get someone from the team to follow up with more detail."
        )
    else:
        reply = (
            "Thanks for your message — let me get someone from the team to help "
            "you with this."
        )
    return SupportDecision(
        reply=reply,
        intent=Intent.ESCALATE,
        escalate_reason="the assistant could not read the message",
        confidence=0.0,
    )
