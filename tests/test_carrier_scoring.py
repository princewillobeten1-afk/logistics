"""The published scoring model, with real cost."""

from __future__ import annotations

from uuid import uuid4

from logistics.carriers.adapter import Quote, QuoteState
from logistics.carriers.scoring import (
    WEIGHTS,
    CarrierSignals,
    Excluded,
    cost_scores,
    experience_score,
    explain,
    required_on_time,
    score_quotes,
    slack_ratio,
)
from logistics.domain.money import CurrencyConverter, Money

NAIRA = 100

CHEAP = uuid4()
SOLID = uuid4()
PREMIUM = uuid4()

SIGNALS = {
    CHEAP: CarrierSignals(CHEAP, "T-CHEAP", 0.78, 0.09, 0.98, 0.62, 240),
    SOLID: CarrierSignals(SOLID, "T-SOLID", 0.91, 0.02, 0.85, 0.88, 180),
    PREMIUM: CarrierSignals(PREMIUM, "T-PREMIUM", 0.97, 0.01, 0.70, 0.94, 300),
}


def _quote(carrier_id, naira: int, currency: str = "NGN") -> Quote:
    return Quote(
        carrier_id=carrier_id,
        state=QuoteState.RECEIVED,
        price=Money(naira * NAIRA, currency),
        confidence=1.0,
    )


# ------------------------------------------------------------------ weights


def test_weights_match_the_published_model():
    assert WEIGHTS == {
        "cost": 0.30,
        "on_time": 0.25,
        "availability": 0.15,
        "damage": 0.10,
        "route_experience": 0.10,
        "service": 0.10,
    }
    assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9


def test_cost_scores_normalise_cheapest_to_one():
    assert cost_scores([100, 200, 300]) == [1.0, 0.5, 0.0]


def test_a_single_quote_carries_no_price_information():
    """With nothing to compare against, price cannot discriminate."""
    assert cost_scores([450]) == [1.0]


def test_identical_prices_all_score_full():
    assert cost_scores([500, 500]) == [1.0, 1.0]


def test_experience_saturates():
    assert experience_score(None) == 0.0
    assert experience_score(100) == 0.5
    assert experience_score(200) == 1.0
    assert experience_score(5000) == 1.0


# ------------------------------------------------------------------ scoring


async def test_published_weights_favour_price_when_there_is_slack(db, fx):
    """Applied literally, the published model prefers the cheap carrier — cost
    is its single largest weight at 30%. On a load with room in the schedule
    that is the correct answer, and it is what the model actually does."""
    scored = await score_quotes(
        [_quote(CHEAP, 410_000), _quote(SOLID, 450_000), _quote(PREMIUM, 475_000)],
        SIGNALS,
        converter=CurrencyConverter(db),
        slack=1.0,  # could take twice as long and still arrive on time
    )
    assert scored[0].signals.code == "T-CHEAP"


async def test_tight_deadline_excludes_the_unreliable_carrier(db, fx):
    """The §7 case. A static weight cannot express "this load has a hard
    deadline", so on-time becomes a threshold rather than a preference: a 78%
    carrier with no slack carries a 22% chance of breaching."""
    excluded: list[Excluded] = []
    scored = await score_quotes(
        [_quote(CHEAP, 410_000), _quote(SOLID, 450_000), _quote(PREMIUM, 475_000)],
        SIGNALS,
        converter=CurrencyConverter(db),
        slack=0.02,  # essentially no room
        excluded=excluded,
    )

    assert scored[0].signals.code == "T-PREMIUM"
    assert [e.carrier_code for e in excluded] == ["T-CHEAP", "T-SOLID"]
    assert "78% on-time is below the 95% required" in excluded[0].reason


async def test_on_time_floor_scales_with_slack():
    assert required_on_time(None) == 0.0
    assert required_on_time(1.0) == 0.0
    assert required_on_time(0.30) == 0.85
    assert required_on_time(0.15) == 0.90
    assert required_on_time(0.00) == 0.95


def test_slack_ratio_is_spare_time_over_transit():
    assert slack_ratio(10, 15) == 0.5
    assert slack_ratio(10, 10) == 0.0
    assert slack_ratio(10, 5) == -0.5
    assert slack_ratio(None, 10) is None
    assert slack_ratio(10, None) is None


async def test_cheapest_wins_when_quality_is_equal(db, fx):
    same = CarrierSignals(CHEAP, "A", 0.9, 0.02, 0.9, 0.9, 200)
    other = CarrierSignals(SOLID, "B", 0.9, 0.02, 0.9, 0.9, 200)
    scored = await score_quotes(
        [_quote(CHEAP, 400_000), _quote(SOLID, 500_000)],
        {CHEAP: same, SOLID: other},
        converter=CurrencyConverter(db),
    )
    assert scored[0].signals.code == "A"


async def test_declined_and_unparseable_quotes_never_compete(db, fx):
    quotes = [
        _quote(SOLID, 450_000),
        Quote(carrier_id=CHEAP, state=QuoteState.DECLINED),
        Quote(carrier_id=PREMIUM, state=QuoteState.UNPARSEABLE, raw_text="maybe 400?"),
    ]
    scored = await score_quotes(quotes, SIGNALS, converter=CurrencyConverter(db))

    assert len(scored) == 1
    assert scored[0].signals.code == "T-SOLID", (
        "an unreadable price must not win by being misread as a small number"
    )


async def test_no_usable_quotes_scores_nothing(db):
    assert await score_quotes([], SIGNALS, converter=CurrencyConverter(db)) == []


async def test_foreign_currency_is_converted_before_comparison(db, fx):
    """$250 is ~₦395,000 — cheaper than a ₦450,000 quote, which only shows
    after conversion."""
    scored = await score_quotes(
        [_quote(SOLID, 450_000), _quote(CHEAP, 250, "USD")],
        {SOLID: SIGNALS[SOLID], CHEAP: SIGNALS[SOLID]},  # identical quality
        converter=CurrencyConverter(db),
    )
    cheapest = min(scored, key=lambda s: s.normalised_cost.amount_minor)
    assert cheapest.normalised_cost.currency == "NGN"
    assert cheapest.normalised_cost.amount_minor == 250 * 1580 * NAIRA


async def test_unpriceable_quote_is_dropped_not_scored_without_cost(db):
    """No FX rate for ZAR. Scoring it on quality alone would let it win and
    then be booked at an unknown price."""
    scored = await score_quotes(
        [_quote(SOLID, 450_000), _quote(PREMIUM, 9_000, "ZAR")],
        SIGNALS,
        converter=CurrencyConverter(db),
    )
    assert [s.signals.code for s in scored] == ["T-SOLID"]


async def test_every_quote_unpriceable_yields_nothing(db):
    scored = await score_quotes(
        [_quote(SOLID, 9_000, "ZAR")], SIGNALS, converter=CurrencyConverter(db)
    )
    assert scored == []


async def test_missing_signals_do_not_penalise(db, fx):
    """A carrier with no history is normalised over applied weight, not scored
    as though it failed every measure."""
    unknown = uuid4()
    scored = await score_quotes(
        [_quote(unknown, 450_000)],
        {unknown: CarrierSignals(unknown, "NEW")},
        converter=CurrencyConverter(db),
    )
    assert scored[0].score > 0
    assert scored[0].breakdown.applied_weight < 1.0


async def test_breakdown_is_serialisable_for_the_dashboard(db, fx):
    scored = await score_quotes(
        [_quote(SOLID, 450_000)], SIGNALS, converter=CurrencyConverter(db)
    )
    blob = scored[0].breakdown.as_json()
    assert set(blob) == {"total", "normalised", "applied_weight", "parts"}
    assert "on_time" in blob["parts"]
    assert blob["parts"]["on_time"]["weight"] == 0.25


# ---------------------------------------------------------------- rationale


async def test_explanation_says_why_the_cheap_option_was_not_taken(db, fx):
    """The most useful half of an approval card: not why we picked this one,
    but why we did not pick the cheaper one."""
    excluded: list[Excluded] = []
    scored = await score_quotes(
        [_quote(CHEAP, 410_000), _quote(PREMIUM, 475_000)],
        SIGNALS,
        converter=CurrencyConverter(db),
        slack=0.02,
        excluded=excluded,
    )
    text = explain(scored[0], scored[1:], excluded)
    assert "T-PREMIUM" in text
    assert "T-CHEAP was excluded" in text
    assert "on-time" in text


async def test_explanation_is_plain_when_the_winner_is_cheapest(db, fx):
    scored = await score_quotes(
        [_quote(PREMIUM, 400_000), _quote(CHEAP, 500_000)],
        SIGNALS,
        converter=CurrencyConverter(db),
    )
    assert "cheapest" in explain(scored[0], scored[1:])


async def test_explanation_handles_a_lone_quote(db, fx):
    scored = await score_quotes(
        [_quote(SOLID, 450_000)], SIGNALS, converter=CurrencyConverter(db)
    )
    assert "only usable quote" in explain(scored[0], [])
