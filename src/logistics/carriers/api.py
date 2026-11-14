"""API carrier transport.

The easy half: structured request, structured response, synchronous. Real
integrations differ per carrier, so the HTTP call sits behind a `QuoteBackend`
and only that changes when a live carrier is wired up.

`SimulatedBackend` prices loads deterministically from the lane and a
per-carrier multiplier, so quotes differ between carriers — which is what makes
the scoring model meaningful before any real carrier exists.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Protocol

from logistics.carriers.adapter import (
    CarrierRef,
    LoadRequest,
    Quote,
    QuoteState,
    TenderResult,
)
from logistics.domain.money import Money
from logistics.obs import get_logger

log = get_logger(__name__)

QUOTE_VALIDITY = timedelta(hours=6)


class QuoteBackend(Protocol):
    async def price(
        self, carrier: CarrierRef, load: LoadRequest
    ) -> tuple[Money, float] | None:
        """Price and transit hours, or None when the carrier declines."""
        ...

    async def book(
        self, carrier: CarrierRef, load: LoadRequest, quote: Quote, idempotency_key: str
    ) -> TenderResult: ...


def _jitter(seed: str, spread: float) -> float:
    """Deterministic per-carrier variation. A hash rather than `random` so a
    test and a demo produce the same numbers every time."""
    digest = hashlib.sha256(seed.encode()).digest()
    unit = int.from_bytes(digest[:4], "big") / 0xFFFFFFFF
    return 1.0 + (unit - 0.5) * 2 * spread


class SimulatedBackend:
    """Stands in for real carrier APIs. Prices from distance with a stable
    per-carrier multiplier and a small per-load variation."""

    # Naira per tonne-kilometre, before carrier and load variation.
    BASE_RATE_PER_TKM = 95.0

    def __init__(self, *, decline_codes: set[str] | None = None) -> None:
        self._decline = decline_codes or set()

    async def price(
        self, carrier: CarrierRef, load: LoadRequest
    ) -> tuple[Money, float] | None:
        if carrier.code in self._decline:
            return None

        distance_km = _lane_km(load.origin, load.destination)
        tonnes = max(load.weight_kg, 500) / 1000.0

        naira = self.BASE_RATE_PER_TKM * tonnes * distance_km
        naira *= _jitter(carrier.code, 0.18)
        naira *= _jitter(f"{carrier.code}:{load.shipment_reference}", 0.05)

        # Money is integer minor units, always.
        price = Money(int(round(naira * 100)), "NGN")
        transit = distance_km / 55.0 * _jitter(f"{carrier.code}:transit", 0.12)
        return price, round(transit, 2)

    async def book(
        self, carrier: CarrierRef, load: LoadRequest, quote: Quote, idempotency_key: str
    ) -> TenderResult:
        # A real carrier echoes the idempotency key; this one does the same so
        # reconciliation has something to match against.
        short = hashlib.sha256(idempotency_key.encode()).hexdigest()[:8].upper()
        return TenderResult(
            accepted=True,
            booking_ref=f"{carrier.code}-{short}",
            vehicle=f"SIM-{short[:3]}",
            driver="Assigned at dispatch",
            pickup_at=datetime.now(UTC) + timedelta(hours=4),
            raw={"idempotency_key": idempotency_key, "simulated": True},
        )


# Approximate road distances for the lanes the platform knows about. Kept
# separate from handlers/plan.py's table on purpose: this stands in for what a
# carrier's own system would compute, not for our planning estimate.
_LANES: dict[frozenset[str], float] = {
    frozenset({"Lagos", "Abuja"}): 750,
    frozenset({"Lagos", "Ibadan"}): 130,
    frozenset({"Lagos", "Kano"}): 1050,
    frozenset({"Abuja", "Kano"}): 350,
    frozenset({"Lagos", "Port Harcourt"}): 610,
}


def _lane_km(origin: str, destination: str) -> float:
    return _LANES.get(frozenset({origin, destination}), 500.0)


class ApiCarrierAdapter:
    name = "API"

    def __init__(self, backend: QuoteBackend | None = None) -> None:
        self._backend = backend or SimulatedBackend()

    async def request_quote(
        self, carrier: CarrierRef, load: LoadRequest
    ) -> Quote | None:
        """Answers synchronously — that is the whole difference from Telegram."""
        priced = await self._backend.price(carrier, load)

        if priced is None:
            return Quote(
                carrier_id=carrier.id,
                state=QuoteState.DECLINED,
                note="carrier declined the load",
            )

        price, transit_hours = priced
        return Quote(
            carrier_id=carrier.id,
            state=QuoteState.RECEIVED,
            price=price,
            transit_hours=transit_hours,
            valid_until=datetime.now(UTC) + QUOTE_VALIDITY,
            # Structured data from an API is not a reading of anything, so it
            # is certain by construction. Only parsed text carries doubt.
            confidence=1.0,
            parsed_by=None,
        )

    async def tender(
        self,
        carrier: CarrierRef,
        load: LoadRequest,
        quote: Quote,
        idempotency_key: str,
    ) -> TenderResult:
        return await self._backend.book(carrier, load, quote, idempotency_key)
