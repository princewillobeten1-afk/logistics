"""Money.

Two rules, both enforced by the type rather than by discipline:

  * An amount is always integer minor units paired with its currency. There is
    no such thing as a bare `amount_minor` in this system.
  * Arithmetic and comparison across currencies raise. Adding NGN to USD is a
    bug, and it should be a loud one rather than a silently wrong total.

Minor units are per-currency. NGN and USD have two, JPY has none, KWD has
three. Assuming two silently mis-scales by 100x, so the exponent is read from
the `currencies` table rather than hardcoded.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from logistics.db import Database


class CurrencyMismatch(Exception):
    """An operation combined two different currencies."""

    def __init__(self, left: str, right: str, op: str) -> None:
        super().__init__(f"cannot {op} {left} and {right} without an explicit conversion")
        self.left = left
        self.right = right


class MissingRate(Exception):
    """No usable FX rate. Callers must fail closed, never assume parity."""


class StaleRate(Exception):
    """A rate exists but is older than the caller allows."""


@dataclass(frozen=True, slots=True, order=False)
class Money:
    amount_minor: int
    currency: str

    def __post_init__(self) -> None:
        if isinstance(self.amount_minor, bool) or not isinstance(self.amount_minor, int):
            raise TypeError(
                f"amount_minor must be an int of minor units, got "
                f"{type(self.amount_minor).__name__}"
            )
        if not isinstance(self.currency, str) or len(self.currency) != 3:
            raise ValueError(f"currency must be a 3-letter code, got {self.currency!r}")
        object.__setattr__(self, "currency", self.currency.upper())

    # ------------------------------------------------------------ arithmetic
    def _same(self, other: Money, op: str) -> None:
        if self.currency != other.currency:
            raise CurrencyMismatch(self.currency, other.currency, op)

    def __add__(self, other: Money) -> Money:
        self._same(other, "add")
        return Money(self.amount_minor + other.amount_minor, self.currency)

    def __sub__(self, other: Money) -> Money:
        self._same(other, "subtract")
        return Money(self.amount_minor - other.amount_minor, self.currency)

    def __mul__(self, factor: int) -> Money:
        if isinstance(factor, bool) or not isinstance(factor, int):
            raise TypeError("money may only be multiplied by an int; use scale() otherwise")
        return Money(self.amount_minor * factor, self.currency)

    def scale(self, factor: Decimal | str) -> Money:
        """Multiply by a fraction, rounding to whole minor units."""
        scaled = (Decimal(self.amount_minor) * Decimal(factor)).quantize(
            Decimal(1), rounding=ROUND_HALF_UP
        )
        return Money(int(scaled), self.currency)

    # ----------------------------------------------------------- comparison
    def __lt__(self, other: Money) -> bool:
        self._same(other, "compare")
        return self.amount_minor < other.amount_minor

    def __le__(self, other: Money) -> bool:
        self._same(other, "compare")
        return self.amount_minor <= other.amount_minor

    def __gt__(self, other: Money) -> bool:
        self._same(other, "compare")
        return self.amount_minor > other.amount_minor

    def __ge__(self, other: Money) -> bool:
        self._same(other, "compare")
        return self.amount_minor >= other.amount_minor

    # ------------------------------------------------------------ rendering
    def to_major(self, exponent: int) -> Decimal:
        return Decimal(self.amount_minor) / (Decimal(10) ** exponent)

    def format(self, exponent: int = 2) -> str:
        return f"{self.to_major(exponent):,.{exponent}f} {self.currency}"

    @classmethod
    def from_major(cls, amount: Decimal | str | int, currency: str, exponent: int = 2) -> Money:
        minor = (Decimal(amount) * (Decimal(10) ** exponent)).quantize(
            Decimal(1), rounding=ROUND_HALF_UP
        )
        return cls(int(minor), currency)

    @classmethod
    def from_params(cls, params: dict[str, Any]) -> Money | None:
        """Read `amount_minor` + `currency` out of an action's params.

        Returns None when there is no amount at all — which callers must treat
        as "spend could not be verified", not as zero.
        """
        amount = params.get("amount_minor")
        if amount is None:
            return None
        currency = params.get("currency")
        if not currency:
            raise ValueError("amount_minor was given without a currency")
        return cls(amount, currency)

    def __str__(self) -> str:
        return f"{self.amount_minor} minor {self.currency}"


class CurrencyConverter:
    """Reads `fx_rates`. Fails closed: no rate or a stale rate raises rather
    than falling back to parity or to an older number."""

    def __init__(self, db: Database, *, default_max_age_hours: float = 24.0) -> None:
        self._db = db
        self._default_max_age = default_max_age_hours
        self._exponents: dict[str, int] = {}

    async def exponent(self, currency: str) -> int:
        code = currency.upper()
        if code not in self._exponents:
            async with self._db.connection() as conn:
                cur = await conn.execute(
                    "SELECT minor_unit_exponent FROM currencies WHERE code = %s", (code,)
                )
                row = await cur.fetchone()
            if row is None:
                raise MissingRate(f"unknown currency {code}")
            self._exponents[code] = row["minor_unit_exponent"]
        return self._exponents[code]

    async def rate(
        self, base: str, quote: str, *, max_age_hours: float | None = None
    ) -> Decimal:
        """Units of `quote` per one unit of `base`."""
        base, quote = base.upper(), quote.upper()
        if base == quote:
            return Decimal(1)

        max_age = self._default_max_age if max_age_hours is None else max_age_hours
        cutoff = datetime.now(UTC) - timedelta(hours=max_age)

        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                SELECT rate, as_of, base, quote
                  FROM fx_rates
                 WHERE (base = %s AND quote = %s) OR (base = %s AND quote = %s)
                 ORDER BY as_of DESC
                 LIMIT 1
                """,
                (base, quote, quote, base),
            )
            row = await cur.fetchone()

        if row is None:
            raise MissingRate(f"no FX rate for {base}/{quote}")
        if row["as_of"] < cutoff:
            raise StaleRate(
                f"{base}/{quote} rate is from {row['as_of'].isoformat()}, "
                f"older than the {max_age}h limit"
            )

        value = Decimal(row["rate"])
        # Stored inverted; invert back rather than refusing.
        if row["base"] == quote:
            return Decimal(1) / value
        return value

    async def convert(
        self, money: Money, to: str, *, max_age_hours: float | None = None
    ) -> Money:
        to = to.upper()
        if money.currency == to:
            return money

        rate = await self.rate(money.currency, to, max_age_hours=max_age_hours)
        from_exp = await self.exponent(money.currency)
        to_exp = await self.exponent(to)

        # Through major units, because the two currencies may not share an
        # exponent — JPY has none, NGN has two.
        major = Decimal(money.amount_minor) / (Decimal(10) ** from_exp)
        converted = (major * rate * (Decimal(10) ** to_exp)).quantize(
            Decimal(1), rounding=ROUND_HALF_UP
        )
        return Money(int(converted), to)
