"""The carrier contract.

Deliberately asynchronous in shape even for synchronous carriers:
`request_quote` returns an acknowledgement, not a price. A REST carrier can
answer immediately, but a person on Telegram cannot, and building the fast path
first would mean rewriting the workflow when the long tail arrives.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, Protocol
from uuid import UUID

from logistics.domain.money import Money


class QuoteState(StrEnum):
    REQUESTED = "REQUESTED"
    RECEIVED = "RECEIVED"
    UNPARSEABLE = "UNPARSEABLE"
    """A reply we could not read with confidence. Goes to a human, never to a
    tender — an unparseable price is not a cheap price."""
    DECLINED = "DECLINED"
    SELECTED = "SELECTED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"


@dataclass(frozen=True, slots=True)
class CarrierRef:
    id: UUID
    code: str
    name: str
    integration: str
    telegram_chat_id: int | None = None
    api_config: dict[str, Any] = field(default_factory=dict)

    @property
    def reachable(self) -> bool:
        """Telegram bots cannot open a conversation, so a carrier that has
        never messaged the bot cannot be broadcast to."""
        if self.integration == "TELEGRAM":
            return self.telegram_chat_id is not None
        return self.integration == "API"


@dataclass(frozen=True, slots=True)
class LoadRequest:
    """What we are asking a carrier to price."""

    shipment_reference: str
    origin: str
    destination: str
    mode: str
    weight_kg: float
    quantity: int | None = None
    pickup_by: datetime | None = None
    deliver_by: datetime | None = None
    load_type: str | None = None
    special_handling: list[str] = field(default_factory=list)

    def as_prose(self) -> str:
        """Human-readable form, for carriers who are people."""
        lines = [
            f"Load {self.shipment_reference}",
            f"{self.origin} → {self.destination} ({self.mode.lower()})",
            f"{self.weight_kg:,.0f} kg"
            + (f", {self.quantity} units" if self.quantity else ""),
        ]
        if self.load_type:
            lines.append(f"Load type: {self.load_type}")
        if self.pickup_by:
            lines.append(f"Pickup by: {self.pickup_by:%a %d %b, %H:%M}")
        if self.deliver_by:
            lines.append(f"Deliver by: {self.deliver_by:%a %d %b, %H:%M}")
        if self.special_handling:
            lines.append(f"Handling: {', '.join(self.special_handling)}")
        return "\n".join(lines)


@dataclass(frozen=True, slots=True)
class Quote:
    carrier_id: UUID
    state: QuoteState
    price: Money | None = None
    transit_hours: float | None = None
    valid_until: datetime | None = None
    confidence: float | None = None
    raw_text: str | None = None
    parsed_by: str | None = None
    note: str | None = None

    @property
    def usable(self) -> bool:
        """Only a confidently-read price competes for the load."""
        return self.state is QuoteState.RECEIVED and self.price is not None


@dataclass(frozen=True, slots=True)
class TenderResult:
    accepted: bool
    booking_ref: str | None = None
    vehicle: str | None = None
    driver: str | None = None
    pickup_at: datetime | None = None
    message: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


class CarrierAdapter(Protocol):
    """Every transport implements this. Nothing above it knows which one it
    is talking to."""

    name: str

    async def request_quote(
        self, carrier: CarrierRef, load: LoadRequest
    ) -> Quote | None:
        """Ask for a price.

        Returns a `Quote` when the carrier answers synchronously — an API
        carrier does. Returns `None` when the request has gone out and an
        answer will arrive later, which is the Telegram case. Raises when the
        request could not be sent at all.

        The three outcomes are genuinely different and the caller treats them
        differently, so they are not collapsed into a boolean.
        """
        ...

    async def tender(
        self, carrier: CarrierRef, load: LoadRequest, quote: Quote, idempotency_key: str
    ) -> TenderResult:
        """Book it. `idempotency_key` must be passed to the carrier where the
        carrier supports one, and used to reconcile where it does not."""
        ...
