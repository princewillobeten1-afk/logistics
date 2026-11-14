"""What cap does the evidence actually support?

Every policy cap in this system is currently zero, so every booking reaches a
human. That is the right place to start and the wrong place to stay — but the
way it usually gets raised is somebody deciding the agents "seem fine", which
is not evidence, and which nobody can defend afterwards when a truck gets
booked twice for ₦2M.

This turns it into arithmetic. Given the decisions humans have actually made
on agent proposals, it reports the cap those decisions justify — and, far more
often, that they justify nothing yet and how many more are needed.

The bar is deliberately hard to clear. Five gates, all of which must pass:

    1. enough decisions at all                (MIN_SAMPLES)
    2. the *lower bound* on agreement clears the target, not the raw rate
    3. no recent rejection                    (a fresh mistake resets the clock)
    4. the agent gives the same answer twice  (MIN_STABILITY, from replay)
    5. the recommendation is the median approved amount, never the largest

Gate 4 exists because the first eval run found the exception agent giving
different answers to byte-identical input on roughly a quarter of cases, at
every temperature tried. Agreement says the agent is usually right; stability
says whether "usually right" is a property of the agent or of the dice.

Gate 4 is the one people argue with. The reasoning: the agent has demonstrated
competence across a range of amounts, and half its approved decisions were at
or below the median. Setting the cap at the largest amount ever approved would
authorise, unsupervised, the single most expensive decision it has ever made —
on the strength of one person having agreed with it once.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from logistics.eval.agreement import ActionAgreement, Decision
from logistics.eval.stats import DEFAULT_CONFIDENCE, samples_needed

# Below this, no amount of agreement means anything.
#
# The purely statistical minimum is lower: a flawless run clears a 90% lower
# bound at 22 decisions. 30 is a deliberate margin on top of that, because 22
# assumes the sample is representative, and early approvals are not — the first
# things an operator decides are the ones that reached the queue first, not a
# fair draw from the situations the agent will eventually face alone.
MIN_SAMPLES = 30

# The agreement an agent must demonstrate before spending unsupervised. Not
# 100%: that is unachievable and would freeze autonomy at zero forever. 90%
# means one call in ten is one a human would have made differently — tolerable
# only because the cap is set low enough that being wrong is survivable.
TARGET_AGREEMENT = 0.90

# A rejection inside this window blocks any raise. Recency matters more than
# rate: an agent that was reliable for two months and then proposed something
# a human refused last Tuesday has changed, and the aggregate hides that.
COOLING_OFF = timedelta(days=14)

# The share of replayed cases on which the agent must give the same answer
# twice. Not 1.0 — some genuine ties exist, where two resolutions are equally
# defensible and either is fine. But at the measured rate (about 0.75) a cap
# would be authorising a coin flip, so this is currently the binding gate.
MIN_STABILITY = 0.9


@dataclass(frozen=True, slots=True)
class Recommendation:
    action: str
    current_cap_minor: int | None
    recommended_cap_minor: int
    currency: str
    samples: int
    agreement_rate: float
    agreement_lower: float
    reasons: tuple[str, ...]
    largest_seen_minor: int = 0
    """The biggest amount a human approved. Reported alongside the
    recommendation so the gap between them is visible — that gap is the margin
    the median is buying, and hiding it makes the cap look arbitrary."""

    @property
    def would_raise(self) -> bool:
        return self.recommended_cap_minor > (self.current_cap_minor or 0)

    def render(self) -> str:
        head = f"{self.action}: "
        if self.recommended_cap_minor == 0:
            head += "keep the cap at zero"
        else:
            head += (
                f"cap of {self.recommended_cap_minor / 100:,.0f} "
                f"{self.currency} is supported"
            )
        body = "\n".join(f"    - {r}" for r in self.reasons)
        return f"{head}\n{body}"


def recommend(
    measured: ActionAgreement,
    *,
    current_cap_minor: int | None = None,
    target: float = TARGET_AGREEMENT,
    min_samples: int = MIN_SAMPLES,
    stability: float | None = None,
    now: datetime | None = None,
) -> Recommendation:
    """The cap this action's history supports. Usually zero, and says why.

    `stability` is the share of replayed cases the agent answered identically
    across repeats, from `Scorecard.stability()`. Passing None means it has not
    been measured — which is itself a reason to refuse, since an unmeasured
    agent is not a stable one, it is an unknown one.
    """
    now = now or datetime.now(UTC)
    proportion = measured.proportion
    reasons: list[str] = []
    currency = _currency(measured.decisions)

    def refuse(*why: str) -> Recommendation:
        return Recommendation(
            action=measured.action,
            current_cap_minor=current_cap_minor,
            recommended_cap_minor=0,
            currency=currency,
            samples=proportion.total,
            agreement_rate=proportion.rate,
            agreement_lower=proportion.lower,
            reasons=(*reasons, *why),
            largest_seen_minor=measured.largest_approved_minor,
        )

    if proportion.total < min_samples:
        needed = min_samples - proportion.total
        statistical = samples_needed(target)
        return refuse(
            f"only {proportion.total} decided approval(s); {min_samples} is the "
            f"floor, so {needed} more are needed before any rate means anything",
            f"the statistics alone would clear {target:.0%} at {statistical} "
            f"flawless decisions, but {min_samples} is the binding constraint — "
            "the extra margin is because early approvals are whatever reached "
            "the queue first, not a fair sample of what the agent will face",
        )

    reasons.append(f"agreement {proportion}")

    if proportion.lower < target:
        return refuse(
            f"the lower bound {proportion.lower:.0%} is under the {target:.0%} "
            "target — the observed rate may look adequate, but this is how good "
            "the agent could plausibly be, and that is what a cap has to rest on"
        )

    recent_rejection = _most_recent_rejection(measured.decisions)
    if recent_rejection is not None and recent_rejection.decided_at is not None:
        age = now - recent_rejection.decided_at
        if age < COOLING_OFF:
            return refuse(
                f"a human rejected a proposal {age.days} day(s) ago "
                f"({recent_rejection.reference or 'no reference'}); the cooling-off "
                f"period is {COOLING_OFF.days} days, because a recent mistake says "
                "more about current behaviour than an aggregate over months"
            )

    if stability is None:
        return refuse(
            "stability has not been measured — run `cli eval --repeats 3`. An "
            "unmeasured agent is not a stable one, it is an unknown one"
        )
    if stability < MIN_STABILITY:
        return refuse(
            f"the agent gave the same answer to identical input only "
            f"{stability:.0%} of the time, against a {MIN_STABILITY:.0%} floor — "
            "agreement says it is usually right, this says whether that is a "
            "property of the agent or of the dice"
        )
    reasons.append(f"stability {stability:.0%} across replayed cases")

    cap = measured.median_approved_minor
    if cap <= 0:
        return refuse(
            "no approved proposal carried an amount, so there is nothing to "
            "base a monetary cap on"
        )

    reasons.append(
        f"median approved amount is {cap / 100:,.0f} {currency}; the largest "
        f"was {measured.largest_approved_minor / 100:,.0f} — the median is the "
        "recommendation because half of the demonstrated competence sits at or "
        "below it"
    )
    reasons.append(
        "raising the cap means these decisions stop reaching a human, so the "
        "agreement rate stops being measured on them — re-check after the next "
        f"{min_samples} decisions at the new cap"
    )

    return Recommendation(
        action=measured.action,
        current_cap_minor=current_cap_minor,
        recommended_cap_minor=cap,
        currency=currency,
        samples=proportion.total,
        agreement_rate=proportion.rate,
        agreement_lower=proportion.lower,
        reasons=tuple(reasons),
        largest_seen_minor=measured.largest_approved_minor,
    )


def _most_recent_rejection(decisions: list[Decision]) -> Decision | None:
    rejected = [
        d for d in decisions if not d.agreed and d.decided_at is not None
    ]
    return max(rejected, key=lambda d: d.decided_at, default=None)  # type: ignore[arg-type,return-value]


def _currency(decisions: list[Decision]) -> str:
    """The currency the agent has actually been judged in.

    Mixed currencies are not converted here on purpose: a cap is a policy value
    in one currency, and averaging across them would produce a number that is
    not a limit on anything. The policy engine converts at decision time
    against a live rate, which is the only place that conversion is sound.
    """
    seen = {d.currency for d in decisions if d.amount_minor is not None}
    if len(seen) > 1:
        return "/".join(sorted(seen))
    return next(iter(seen), "NGN")


def confidence_note(confidence: float = DEFAULT_CONFIDENCE) -> str:
    return (
        f"Bounds are one-sided Wilson intervals at {confidence:.0%}. The "
        "question is never whether the agent might be better than it looks — "
        "only how much worse it could plausibly be."
    )
