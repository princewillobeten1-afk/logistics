"""Carrier scoring — the published model, and the canonical implementation.

    30% cost · 25% on-time · 15% availability
  · 10% damage · 10% route experience · 10% service

Deterministic on purpose. "Carrier B is ₦40,000 cheaper but less reliable, and
this load has a hard deadline" is a weighted sum, not a judgment call — so it
is tunable, auditable, reproducible on every shipment, and cannot invent a
carrier that does not exist. The model's job is writing the rationale for the
approval card, not choosing.

This module is authoritative. `lib/scoring.ts` in the dashboard renders the
score stored on the quote row rather than recomputing it, so the number that
spends money is the number on the screen.

Cost is compared in the policy's base currency. A missing or stale FX rate
**fails closed** — an unpriceable quote does not compete — exactly as
`PolicyEngine` does.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from logistics.carriers.adapter import Quote
from logistics.domain.money import CurrencyConverter, Money, MissingRate, StaleRate
from logistics.obs import get_logger

log = get_logger(__name__)

WEIGHTS: dict[str, float] = {
    "cost": 0.30,
    "on_time": 0.25,
    "availability": 0.15,
    "damage": 0.10,
    "route_experience": 0.10,
    "service": 0.10,
}

# Shipments on a lane for full route-experience marks.
EXPERIENCE_SATURATION = 200


# --------------------------------------------------------------- deadlines
#
# The published weights have no notion of urgency, and applied literally they
# prefer a cheap carrier with a 78% on-time record over a reliable one — cost
# is the single largest weight at 30%. On a load with slack that is the right
# answer and the model needs no help.
#
# But the brief's own worked example reasons: "since this shipment has a strict
# deadline, Carrier C provides the highest probability of meeting the SLA."
# A fixed weight cannot express that, and quietly re-tuning the published
# numbers to force the outcome would make the model unexplainable.
#
# So urgency is handled as a **feasibility constraint, not a preference**. When
# a load has little schedule slack, a carrier's on-time rate stops being
# something to trade against price and becomes a threshold: a 78% carrier on a
# load with no slack carries a 22% chance of breaching, and that is not a
# discount, it is a risk. Excluded carriers are recorded with a reason.

ON_TIME_FLOOR: tuple[tuple[float, float], ...] = (
    # (minimum slack ratio, required on-time rate)
    (0.50, 0.00),   # plenty of room — price competes freely
    (0.25, 0.85),
    (0.10, 0.90),
    (0.00, 0.95),   # no slack at all — only the most reliable may bid
)


def required_on_time(slack_ratio: float | None) -> float:
    """Minimum acceptable on-time rate for the schedule slack available.

    `slack_ratio` is spare time as a fraction of transit time: 0.5 means the
    load could take 50% longer and still arrive on time.
    """
    if slack_ratio is None:
        return 0.0
    for threshold, floor in ON_TIME_FLOOR:
        if slack_ratio >= threshold:
            return floor
    return ON_TIME_FLOOR[-1][1]


def slack_ratio(
    transit_hours: float | None, hours_until_deadline: float | None
) -> float | None:
    """Spare time as a fraction of the journey. None when either is unknown."""
    if not transit_hours or hours_until_deadline is None or transit_hours <= 0:
        return None
    return (hours_until_deadline - transit_hours) / transit_hours


@dataclass(frozen=True, slots=True)
class CarrierSignals:
    carrier_id: UUID
    code: str
    on_time_rate: float | None = None
    damage_rate: float | None = None
    availability_rate: float | None = None
    service_score: float | None = None
    shipments_count: int | None = None


@dataclass(frozen=True, slots=True)
class ScoreBreakdown:
    total: float
    normalised: float
    applied_weight: float
    parts: dict[str, dict[str, float]] = field(default_factory=dict)

    def as_json(self) -> dict[str, Any]:
        return {
            "total": round(self.total, 5),
            "normalised": round(self.normalised, 5),
            "applied_weight": round(self.applied_weight, 4),
            "parts": {
                name: {k: round(v, 5) for k, v in part.items()}
                for name, part in self.parts.items()
            },
        }


@dataclass(frozen=True, slots=True)
class ScoredQuote:
    quote: Quote
    signals: CarrierSignals
    normalised_cost: Money | None
    breakdown: ScoreBreakdown

    @property
    def score(self) -> float:
        return self.breakdown.normalised


@dataclass(frozen=True, slots=True)
class Excluded:
    """A quote kept out of the comparison, and why. Recorded rather than
    silently dropped — an operator asking "why didn't we use the cheap one"
    deserves an answer."""

    carrier_code: str
    reason: str


def experience_score(shipments: int | None) -> float:
    if not shipments or shipments <= 0:
        return 0.0
    return min(1.0, shipments / EXPERIENCE_SATURATION)


def cost_scores(amounts: list[int]) -> list[float]:
    """Cheapest scores 1, dearest 0. A single quote scores 1 — with nothing to
    compare against, price carries no discriminating information."""
    if not amounts:
        return []
    low, high = min(amounts), max(amounts)
    if high == low:
        return [1.0] * len(amounts)
    return [(high - a) / (high - low) for a in amounts]


def _score_one(
    signals: CarrierSignals, cost_score: float | None
) -> ScoreBreakdown:
    parts: dict[str, dict[str, float]] = {}
    total = 0.0
    applied = 0.0

    def add(name: str, value: float | None) -> None:
        nonlocal total, applied
        if value is None:
            return
        weight = WEIGHTS[name]
        contribution = weight * value
        parts[name] = {"weight": weight, "value": value, "contribution": contribution}
        total += contribution
        applied += weight

    add("cost", cost_score)
    add("on_time", signals.on_time_rate)
    add("availability", signals.availability_rate)
    # Damage is a rate where lower is better, so it inverts.
    add("damage", None if signals.damage_rate is None else 1 - signals.damage_rate)
    add("route_experience", experience_score(signals.shipments_count))
    add("service", signals.service_score)

    return ScoreBreakdown(
        total=total,
        # Normalised by the weight actually applied, so a quote missing a
        # signal is not silently penalised against one that has it.
        normalised=total / applied if applied > 0 else 0.0,
        applied_weight=applied,
        parts=parts,
    )


async def score_quotes(
    quotes: list[Quote],
    signals: dict[UUID, CarrierSignals],
    *,
    converter: CurrencyConverter,
    base_currency: str = "NGN",
    fx_max_age_hours: float | None = None,
    slack: float | None = None,
    excluded: list[Excluded] | None = None,
) -> list[ScoredQuote]:
    """Score every usable quote, best first.

    Two things are excluded rather than scored, both for the same reason —
    scoring them would let an option win a comparison it should not be in:

      * A quote that cannot be priced in the base currency would otherwise win
        on quality alone and then be booked at an unknown price.
      * On a tight deadline, a carrier below the on-time floor. See
        `required_on_time`.
    """
    dropped = excluded if excluded is not None else []
    floor = required_on_time(slack)

    usable: list[Quote] = []
    for quote in quotes:
        if not quote.usable:
            continue
        record = signals.get(quote.carrier_id)
        on_time = record.on_time_rate if record else None
        if floor > 0 and on_time is not None and on_time < floor:
            dropped.append(
                Excluded(
                    carrier_code=record.code if record else "?",
                    reason=(
                        f"{on_time:.0%} on-time is below the {floor:.0%} required "
                        f"for a load with {slack:.0%} schedule slack"
                    ),
                )
            )
            continue
        usable.append(quote)

    if not usable:
        return []

    priced: list[tuple[Quote, Money]] = []
    for quote in usable:
        assert quote.price is not None
        try:
            converted = await converter.convert(
                quote.price, base_currency, max_age_hours=fx_max_age_hours
            )
        except (MissingRate, StaleRate) as exc:
            # Fail closed, exactly as the policy gate does.
            log.error(
                "carrier.quote_unpriceable",
                carrier_id=str(quote.carrier_id),
                currency=quote.price.currency,
                error=str(exc),
            )
            record = signals.get(quote.carrier_id)
            dropped.append(
                Excluded(
                    carrier_code=record.code if record else "?",
                    reason=f"quote in {quote.price.currency} could not be priced: {exc}",
                )
            )
            continue
        priced.append((quote, converted))

    if not priced:
        return []

    costs = cost_scores([m.amount_minor for _, m in priced])

    scored = [
        ScoredQuote(
            quote=quote,
            signals=signals.get(quote.carrier_id, CarrierSignals(quote.carrier_id, "?")),
            normalised_cost=money,
            breakdown=_score_one(
                signals.get(quote.carrier_id, CarrierSignals(quote.carrier_id, "?")),
                cost,
            ),
        )
        for (quote, money), cost in zip(priced, costs, strict=True)
    ]

    scored.sort(key=lambda s: s.score, reverse=True)
    return scored


def explain(
    winner: ScoredQuote,
    runners_up: list[ScoredQuote],
    excluded: list[Excluded] | None = None,
) -> str:
    """A sentence for the approval card, built from the arithmetic rather than
    generated. The model can enrich this; it does not need to invent it."""
    tail = ""
    if excluded:
        # The most useful half of the explanation is usually why the cheap
        # option was not taken.
        first = excluded[0]
        tail = f" {first.carrier_code} was excluded: {first.reason}."
        if len(excluded) > 1:
            tail += f" {len(excluded) - 1} other quote(s) also excluded."

    if not runners_up:
        return f"{winner.signals.code} was the only usable quote.{tail}"

    cheapest = min(
        [winner, *runners_up],
        key=lambda s: s.normalised_cost.amount_minor if s.normalised_cost else 0,
    )

    if cheapest.quote.carrier_id == winner.quote.carrier_id:
        return (
            f"{winner.signals.code} scored highest ({winner.score:.0%}) "
            f"and was also the cheapest of {len(runners_up) + 1} quotes.{tail}"
        )

    assert cheapest.normalised_cost is not None
    assert winner.normalised_cost is not None
    delta = winner.normalised_cost - cheapest.normalised_cost
    return (
        f"{winner.signals.code} scored {winner.score:.0%} against "
        f"{cheapest.signals.code}'s {cheapest.score:.0%}. It costs "
        f"{delta.format()} more, but its on-time record "
        f"({_pct(winner.signals.on_time_rate)} vs "
        f"{_pct(cheapest.signals.on_time_rate)}) carries more weight on this load.{tail}"
    )


def _pct(value: float | None) -> str:
    return "unknown" if value is None else f"{value:.0%}"
