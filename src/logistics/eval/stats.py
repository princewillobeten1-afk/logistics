"""The arithmetic behind an autonomy decision.

Small, pure, and separated out because everything else in this package is a
judgement call resting on it. If the bound is wrong, the recommendation is
wrong in the direction that costs money.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# 95% one-sided. Not two-sided: the question is never "might the agent be
# better than it looks", only "how bad could it be".
DEFAULT_CONFIDENCE = 0.95


def _z(confidence: float) -> float:
    """Inverse normal CDF at `confidence`, via Acklam's rational approximation.

    Hand-rolled rather than pulled from scipy: this is the only statistics in
    the codebase, and a numerical stack is a large dependency to add for one
    function. Accurate to ~1e-9 over the range, which is far past what a
    confidence level needs.
    """
    if not 0.0 < confidence < 1.0:
        raise ValueError("confidence must be strictly between 0 and 1")

    a = (-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02,
         1.383577518672690e02, -3.066479806614716e01, 2.506628277459239e00)
    b = (-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02,
         6.680131188771972e01, -1.328068155288572e01)
    c = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00,
         -2.549732539343734e00, 4.374664141464968e00, 2.938163982698783e00)
    d = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00,
         3.754408661907416e00)

    p_low, p_high = 0.02425, 1 - 0.02425
    p = confidence

    if p < p_low:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1
        )
    if p <= p_high:
        q = p - 0.5
        r = q * q
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (
            ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1
        )
    q = math.sqrt(-2 * math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
        (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1
    )


@dataclass(frozen=True, slots=True)
class Proportion:
    """An observed success rate and how much of it is real.

    `lower` is the number that matters. A run of three correct decisions is a
    100% success rate and evidence of almost nothing; the naive interval
    (p ± z·√(p(1-p)/n)) actually reports a width of *zero* there, because
    p(1-p) is 0 — which would read as certainty. Wilson does not do that.
    """

    successes: int
    total: int
    confidence: float = DEFAULT_CONFIDENCE

    @property
    def rate(self) -> float:
        return self.successes / self.total if self.total else 0.0

    @property
    def lower(self) -> float:
        return wilson_lower(self.successes, self.total, self.confidence)

    def __str__(self) -> str:
        if not self.total:
            return "no observations"
        return (
            f"{self.successes}/{self.total} = {self.rate:.0%} "
            f"(at least {self.lower:.0%} with {self.confidence:.0%} confidence)"
        )


def wilson_lower(successes: int, total: int, confidence: float = DEFAULT_CONFIDENCE) -> float:
    """Lower bound of the Wilson score interval.

    The honest answer to "how good is this agent, really, given how little we
    have seen". At 1-for-1 it returns about 21%; at 30-for-30, about 89%. That
    gap is the entire point — it is what stops a lucky streak from authorising
    a spending limit.
    """
    if total <= 0:
        return 0.0
    if successes < 0 or successes > total:
        raise ValueError("successes must be between 0 and total")

    z = _z(confidence)
    n = float(total)
    p = successes / n
    denominator = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (centre - margin) / denominator)


def samples_needed(
    target: float, confidence: float = DEFAULT_CONFIDENCE, assume_perfect: bool = True
) -> int:
    """How many decisions before the bound could clear `target`.

    Answers the question people actually ask — "how long until we can raise the
    cap" — and answers it optimistically: `assume_perfect` means not one more
    mistake. The real number is always larger, which is worth saying out loud
    when reporting it.
    """
    if not 0.0 < target < 1.0:
        raise ValueError("target must be strictly between 0 and 1")

    n = 1
    while n < 100_000:
        successes = n if assume_perfect else round(n * target)
        if wilson_lower(successes, n, confidence) >= target:
            return n
        n += 1
    return n


def median(values: list[int]) -> int:
    """Integer median. Minor currency units throughout, so no float ever
    touches an amount — the policy engine denies on a float for the same
    reason."""
    if not values:
        return 0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) // 2
