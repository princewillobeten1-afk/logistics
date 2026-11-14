"""Telegram transport, against a fake so no network is touched."""

from __future__ import annotations

import time
from uuid import uuid4

import pytest

from logistics.carriers.adapter import CarrierRef, LoadRequest
from logistics.carriers.telegram import TelegramAdapter, TelegramError

CARRIER = CarrierRef(
    id=uuid4(), code="T-TG", name="Telegram Haulage",
    integration="TELEGRAM", telegram_chat_id=12345,
)

UNREACHABLE = CarrierRef(
    id=uuid4(), code="T-NEW", name="Not Onboarded", integration="TELEGRAM"
)

LOAD = LoadRequest(
    shipment_reference="LG-1", origin="Lagos", destination="Abuja",
    mode="ROAD", weight_kg=1800, quantity=100,
)


class FakeTransport:
    def __init__(self, *, updates=None, errors=None) -> None:
        self.sent: list[dict] = []
        self.calls: list[str] = []
        self._updates = updates or []
        self._errors = list(errors or [])

    async def call(self, method: str, payload: dict) -> dict:
        self.calls.append(method)
        if self._errors:
            error = self._errors.pop(0)
            if error is not None:
                raise error
        if method == "sendMessage":
            self.sent.append(payload)
            return {"message_id": len(self.sent)}
        if method == "getUpdates":
            batch, self._updates = self._updates, []
            return batch
        return {}


def _update(update_id: int, chat_id: int, text: str, username="carrier") -> dict:
    return {
        "update_id": update_id,
        "message": {
            "text": text,
            "chat": {"id": chat_id},
            "from": {"username": username, "first_name": "Ade", "last_name": "Bello"},
        },
    }


# ------------------------------------------------------------------ sending


async def test_quote_request_goes_out_as_readable_prose():
    transport = FakeTransport()
    result = await TelegramAdapter(transport).request_quote(CARRIER, LOAD)

    assert result is None, "a person cannot answer synchronously"
    body = transport.sent[0]["text"]
    assert "LG-1" in body
    assert "Lagos → Abuja" in body
    assert "1,800 kg" in body


async def test_unonboarded_carrier_raises_an_actionable_error():
    """A bot cannot open a conversation. This surfaces as onboarding work, not
    as a mysterious send failure."""
    with pytest.raises(TelegramError, match="has not started the bot"):
        await TelegramAdapter(FakeTransport()).request_quote(UNREACHABLE, LOAD)


async def test_cannot_initiate_is_not_retried():
    error = TelegramError(
        "Forbidden: bot can't initiate conversation with a user", code=403
    )
    transport = FakeTransport(errors=[error])
    adapter = TelegramAdapter(transport)

    with pytest.raises(TelegramError) as excinfo:
        await adapter.send(999, "hello")

    assert excinfo.value.cannot_initiate is True
    assert transport.calls.count("sendMessage") == 1, "retrying cannot help"


async def test_rate_limit_is_retried_after_the_stated_delay():
    transport = FakeTransport(
        errors=[TelegramError("Too Many Requests: retry after 1", code=429), None]
    )
    started = time.monotonic()
    assert await TelegramAdapter(transport).send(12345, "hi") is True

    assert time.monotonic() - started >= 0.9, "must honour retry_after"
    assert transport.calls.count("sendMessage") == 2


async def test_per_chat_pacing_is_applied():
    """~1 msg/sec to a single chat. Bursting gets the bot throttled."""
    adapter = TelegramAdapter(FakeTransport())
    started = time.monotonic()
    for _ in range(3):
        await adapter.send(555, "x")
    assert time.monotonic() - started > 1.0


async def test_a_persistent_error_eventually_gives_up():
    transport = FakeTransport(
        errors=[TelegramError("Bad Request: chat not found", code=400)]
    )
    with pytest.raises(TelegramError, match="chat not found"):
        await TelegramAdapter(transport).send(1, "x")


# ---------------------------------------------------------------- receiving


async def test_poll_returns_messages_with_chat_ids():
    transport = FakeTransport(updates=[_update(1, 777, "430k no wahala")])
    messages = await TelegramAdapter(transport).poll()

    assert len(messages) == 1
    assert messages[0].chat_id == 777
    assert messages[0].text == "430k no wahala"
    assert messages[0].username == "carrier"
    assert messages[0].full_name == "Ade Bello"


async def test_start_command_is_recognised_for_onboarding():
    transport = FakeTransport(updates=[_update(1, 888, "/start")])
    messages = await TelegramAdapter(transport).poll()
    assert messages[0].is_start is True


async def test_offset_advances_past_ignored_updates():
    """Without this an unparseable update is replayed forever."""
    transport = FakeTransport(
        updates=[
            {"update_id": 5, "edited_message": {}},  # ignored shape
            _update(6, 777, "hello"),
        ]
    )
    adapter = TelegramAdapter(transport)
    messages = await adapter.poll()

    assert len(messages) == 1
    assert adapter._offset == 7


async def test_updates_without_text_are_skipped():
    transport = FakeTransport(
        updates=[{"update_id": 1, "message": {"chat": {"id": 5}, "photo": []}}]
    )
    assert await TelegramAdapter(transport).poll() == []


async def test_long_poll_timeout_is_requested():
    transport = FakeTransport(updates=[])
    await TelegramAdapter(transport).poll(timeout=30)
    assert transport.calls == ["getUpdates"]


# ------------------------------------------------------------------ tender


async def test_a_telegram_tender_is_not_an_acceptance():
    """Nothing is booked until a person confirms. Recording it as booked would
    be the platform lying to itself about a commitment that does not exist."""
    from logistics.carriers.adapter import Quote, QuoteState
    from logistics.domain.money import Money

    transport = FakeTransport()
    quote = Quote(
        carrier_id=CARRIER.id, state=QuoteState.SELECTED,
        price=Money(43_000_000, "NGN"),
    )
    result = await TelegramAdapter(transport).tender(CARRIER, LOAD, quote, "key-123")

    assert result.accepted is False
    assert "awaiting carrier confirmation" in result.message
    assert "CONFIRM" in transport.sent[0]["text"]
