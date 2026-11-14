"""Telegram carrier transport.

Chosen over WhatsApp because it needs no business verification, no Meta review
and no template approval — a bot token from @BotFather works immediately. The
one real constraint is that **a bot cannot open a conversation**: sending to
someone who has never messaged it returns

    Forbidden: bot can't initiate conversation with a user

So onboarding is: the carrier opens the bot link and presses Start, and the
first inbound update gives us their `chat_id`. Lighter than a Meta template
review, but still a step — a carrier without a chat_id cannot be broadcast to,
and `CarrierRef.reachable` says so rather than failing at send time.

Rate limits are enforced client-side (≈1 msg/sec per chat, ≈30/sec globally,
20/min per group) and 429s are honoured via `retry_after`.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Protocol

from logistics.carriers.adapter import CarrierRef, LoadRequest, Quote, TenderResult
from logistics.obs import get_logger
from logistics.ratelimit import PerKeyLimiter

log = get_logger(__name__)

API_ROOT = "https://api.telegram.org"

# Telegram's documented ceilings, with headroom.
PER_CHAT_PER_MINUTE = 50.0
GLOBAL_PER_MINUTE = 1500.0

# Long polling: one held connection rather than a poll loop. Incoming updates
# do not count against the send budget.
LONG_POLL_SECONDS = 30


class TelegramError(Exception):
    def __init__(self, description: str, *, code: int | None = None) -> None:
        super().__init__(description)
        self.description = description
        self.code = code

    @property
    def cannot_initiate(self) -> bool:
        """The carrier has not started the bot. Actionable, not a fault."""
        return "can't initiate conversation" in self.description.lower()


class Transport(Protocol):
    """The HTTP boundary, so tests drive the adapter without a network."""

    async def call(self, method: str, payload: dict[str, Any]) -> dict[str, Any]: ...


class HttpTransport:
    """Real Bot API transport. Uses the `openai` SDK's bundled httpx so the
    project gains no new dependency for this."""

    def __init__(self, token: str, *, timeout: float = 60.0) -> None:
        if not token:
            raise TelegramError("TELEGRAM_BOT_TOKEN is not set")
        self._base = f"{API_ROOT}/bot{token}"
        self._timeout = timeout
        self._client: Any = None

    async def _get_client(self) -> Any:
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    async def call(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        client = await self._get_client()
        response = await client.post(f"{self._base}/{method}", json=payload)
        body = response.json()

        if not body.get("ok"):
            raise TelegramError(
                body.get("description", "unknown Telegram error"),
                code=body.get("error_code"),
            )
        return body.get("result", {})

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None


@dataclass(frozen=True, slots=True)
class InboundMessage:
    update_id: int
    chat_id: int
    text: str
    username: str | None = None
    full_name: str | None = None

    @property
    def is_start(self) -> bool:
        """The onboarding handshake that gives us a usable chat_id."""
        return self.text.strip().lower().startswith("/start")


class TelegramAdapter:
    name = "TELEGRAM"

    def __init__(self, transport: Transport) -> None:
        self._transport = transport
        self._limiter = PerKeyLimiter(
            per_key_rate_per_minute=PER_CHAT_PER_MINUTE,
            global_rate_per_minute=GLOBAL_PER_MINUTE,
            per_key_burst=1,
            global_burst=10,
        )
        self._offset: int | None = None

    # ------------------------------------------------------------- sending

    async def send(self, chat_id: int, text: str, *, attempts: int = 3) -> bool:
        """Send, honouring both rate limits and any 429 the server returns."""
        for attempt in range(1, attempts + 1):
            await self._limiter.acquire(str(chat_id))
            try:
                await self._transport.call(
                    "sendMessage",
                    {
                        "chat_id": chat_id,
                        "text": text,
                        "disable_web_page_preview": True,
                    },
                )
                return True
            except TelegramError as exc:
                if exc.cannot_initiate:
                    # Not retryable and not our bug: this carrier never started
                    # the bot. Surface it so onboarding can be chased.
                    log.warning("telegram.not_onboarded", chat_id=chat_id)
                    raise
                if exc.code == 429 and attempt < attempts:
                    delay = _retry_after(exc) or 2.0 * attempt
                    log.warning("telegram.rate_limited", retry_after=delay)
                    await asyncio.sleep(delay)
                    continue
                raise
        return False

    # ----------------------------------------------------------- receiving

    async def poll(self, *, timeout: int = LONG_POLL_SECONDS) -> list[InboundMessage]:
        """One long-poll cycle. Holds the connection open until something
        arrives, rather than hammering the API on an empty queue."""
        payload: dict[str, Any] = {"timeout": timeout, "allowed_updates": ["message"]}
        if self._offset is not None:
            payload["offset"] = self._offset

        updates = await self._transport.call("getUpdates", payload)
        messages: list[InboundMessage] = []

        for update in updates or []:
            # Advance past everything seen, including updates we ignore —
            # otherwise an unparseable update is replayed forever.
            self._offset = update["update_id"] + 1

            message = update.get("message") or {}
            chat = message.get("chat") or {}
            text = message.get("text")
            if not text or chat.get("id") is None:
                continue

            sender = message.get("from") or {}
            full_name = " ".join(
                p for p in (sender.get("first_name"), sender.get("last_name")) if p
            )
            messages.append(
                InboundMessage(
                    update_id=update["update_id"],
                    chat_id=int(chat["id"]),
                    text=text,
                    username=sender.get("username"),
                    full_name=full_name or None,
                )
            )
        return messages

    # -------------------------------------------------------- adapter API

    async def request_quote(
        self, carrier: CarrierRef, load: LoadRequest
    ) -> Quote | None:
        """Always returns None: a person cannot answer synchronously. The
        reply arrives minutes later through `poll`, or never."""
        if carrier.telegram_chat_id is None:
            raise TelegramError(
                f"{carrier.code} has not started the bot, so it cannot be messaged"
            )

        body = (
            f"Quote request — {load.shipment_reference}\n\n"
            f"{load.as_prose()}\n\n"
            "Reply with your price and earliest pickup. "
            "Plain text is fine — for example: “450k, driver available tomorrow morning”."
        )
        await self.send(carrier.telegram_chat_id, body)
        return None

    async def tender(
        self,
        carrier: CarrierRef,
        load: LoadRequest,
        quote: Quote,
        idempotency_key: str,
    ) -> TenderResult:
        """Telegram has no booking API, so a tender is a message and the
        acceptance is a human reply.

        Returned as `accepted=False` with a note: nothing is booked until the
        carrier confirms. Recording it as accepted here would be the platform
        lying to itself about a commitment that does not exist yet.
        """
        if carrier.telegram_chat_id is None:
            return TenderResult(accepted=False, message="carrier has not started the bot")

        price = quote.price
        body = (
            f"Booking confirmation — {load.shipment_reference}\n\n"
            f"{load.as_prose()}\n\n"
            f"Agreed price: {price.format() if price else 'as quoted'}\n"
            f"Reference: {idempotency_key[:16]}\n\n"
            "Please confirm by replying CONFIRM, and send your vehicle and driver details."
        )
        sent = await self.send(carrier.telegram_chat_id, body)
        return TenderResult(
            accepted=False,
            booking_ref=None,
            message=(
                "tender sent; awaiting carrier confirmation"
                if sent
                else "tender could not be sent"
            ),
            raw={"transport": "telegram", "idempotency_key": idempotency_key},
        )


def _retry_after(error: TelegramError) -> float | None:
    """Telegram puts the wait in the description when parameters are absent."""
    import re

    match = re.search(r"retry after (\d+)", error.description, re.IGNORECASE)
    return float(match.group(1)) if match else None
