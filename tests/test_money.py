from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from logistics.domain.money import (
    CurrencyConverter,
    CurrencyMismatch,
    MissingRate,
    Money,
    StaleRate,
)

NAIRA = 100  # kobo


async def _rate(db, base: str, quote: str, rate: str, age_hours: float = 0) -> None:
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO fx_rates (base, quote, rate, as_of, source)"
            " VALUES (%s, %s, %s, %s, 'test')"
            " ON CONFLICT (base, quote, as_of) DO NOTHING",
            (base, quote, Decimal(rate), datetime.now(UTC) - timedelta(hours=age_hours)),
        )


# -------------------------------------------------------------- value object


def test_amount_must_be_integer_minor_units():
    with pytest.raises(TypeError):
        Money(475_000.50, "NGN")  # type: ignore[arg-type]


def test_bool_is_not_an_amount():
    with pytest.raises(TypeError):
        Money(True, "NGN")  # type: ignore[arg-type]


def test_currency_is_normalised():
    assert Money(100, "ngn").currency == "NGN"


def test_currency_must_be_three_letters():
    with pytest.raises(ValueError, match="3-letter"):
        Money(100, "NAIRA")


def test_addition_within_a_currency():
    assert Money(100, "NGN") + Money(50, "NGN") == Money(150, "NGN")


def test_addition_across_currencies_raises():
    """The bug this type exists to prevent."""
    with pytest.raises(CurrencyMismatch):
        Money(100, "NGN") + Money(50, "USD")


def test_comparison_across_currencies_raises():
    """Silently comparing an NGN cap to a USD amount is the dangerous one."""
    with pytest.raises(CurrencyMismatch):
        _ = Money(100, "NGN") < Money(50, "USD")


def test_scale_rounds_to_whole_minor_units():
    assert Money(1000, "NGN").scale("1.185") == Money(1185, "NGN")
    assert Money(101, "NGN").scale("0.5") == Money(51, "NGN")  # half up


def test_multiply_rejects_a_float():
    with pytest.raises(TypeError):
        Money(100, "NGN") * 1.5  # type: ignore[operator]


def test_from_major_respects_exponent():
    assert Money.from_major("500000", "NGN", 2) == Money(50_000_000, "NGN")
    # JPY has no minor unit; treating it as 2 would inflate by 100x.
    assert Money.from_major("5000", "JPY", 0) == Money(5000, "JPY")


def test_from_params_requires_a_currency():
    with pytest.raises(ValueError, match="without a currency"):
        Money.from_params({"amount_minor": 100})


def test_from_params_returns_none_when_unpriced():
    assert Money.from_params({"carrier": "C"}) is None


# ---------------------------------------------------------------- converter


async def test_same_currency_is_a_no_op(db):
    converter = CurrencyConverter(db)
    money = Money(475_000 * NAIRA, "NGN")
    assert await converter.convert(money, "NGN") is money


async def test_converts_through_major_units(db):
    await _rate(db, "USD", "NGN", "1580")
    converter = CurrencyConverter(db)

    # $100.00 → ₦158,000.00
    result = await converter.convert(Money(10_000, "USD"), "NGN")
    assert result == Money(15_800_000, "NGN")


async def test_handles_differing_exponents(db):
    """JPY has no minor unit. Converting must not treat it as two."""
    await _rate(db, "JPY", "NGN", "10.5")
    converter = CurrencyConverter(db)

    # ¥1,000 → ₦10,500.00 → 1,050,000 kobo
    assert await converter.convert(Money(1000, "JPY"), "NGN") == Money(1_050_000, "NGN")


async def test_inverse_rate_is_used_when_stored_the_other_way(db):
    await _rate(db, "USD", "NGN", "1600")
    converter = CurrencyConverter(db)

    result = await converter.convert(Money(16_000_00, "NGN"), "USD")
    assert result == Money(1000, "USD")  # ₦1,600.00 → $10.00


async def test_missing_rate_raises_rather_than_assuming_parity(db):
    converter = CurrencyConverter(db)
    with pytest.raises(MissingRate):
        await converter.convert(Money(100, "ZAR"), "CNY")


async def test_stale_rate_raises(db):
    await _rate(db, "GBP", "NGN", "1995", age_hours=100)
    converter = CurrencyConverter(db, default_max_age_hours=24)
    with pytest.raises(StaleRate):
        await converter.convert(Money(100, "GBP"), "NGN")


async def test_fresh_rate_within_the_window_is_accepted(db):
    await _rate(db, "GBP", "NGN", "1995", age_hours=2)
    converter = CurrencyConverter(db, default_max_age_hours=24)
    assert (await converter.convert(Money(100, "GBP"), "NGN")).currency == "NGN"


async def test_unknown_currency_is_rejected(db):
    converter = CurrencyConverter(db)
    with pytest.raises(MissingRate, match="unknown currency"):
        await converter.exponent("XXX")


async def test_latest_rate_wins(db):
    await _rate(db, "EUR", "NGN", "1000", age_hours=5)
    await _rate(db, "EUR", "NGN", "1710", age_hours=1)
    converter = CurrencyConverter(db)
    assert await converter.rate("EUR", "NGN") == Decimal("1710.0000000000")
