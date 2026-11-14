"""Measuring whether the agents deserve more autonomy.

Every policy cap is zero, so every booking reaches a human. Raising one is a
decision about money, and the usual way it gets made is somebody deciding the
agents "seem fine" — which is not evidence, and which nobody can defend
afterwards.

Two halves, answering different questions:

    agreement.py  did the humans agree with the agent?     (production)
    replay.py     did the agent get these cases right?     (offline)

The first is the one that should gate a cap. It is measured on the real
distribution of situations rather than on cases somebody thought to imagine,
and normal operation produces it for free: every approval a person decides is
a labelled example. Its weakness is that it accumulates slowly — at the time of
writing there is exactly one.

The second is a regression suite. It cannot tell you the agent is good, because
its cases were chosen by the same people who wrote the agent. It can tell you a
prompt change broke something, which is the other thing worth knowing.

`autonomy.py` combines them into a recommendation, and mostly refuses.

What the first runs found, so it is not rediscovered from scratch:

  - The exception agent agrees with the corpus about 90-95% of the time, on a
    sample small enough that the lower bound is ~80%. Nowhere near a cap.
  - **It is unstable on roughly a quarter of cases** — different answers to
    byte-identical input. That matters more than the accuracy figure: a
    decision that changes when you ask twice is not a judgement, and being
    right on average is no comfort when a single roll books a truck.
  - Instability is not temperature-driven. Measured at 0.0 and 0.3; same rate.
  - Its errors skew towards **over-spending** — proposing to re-source a
    carrier on a deadline that is already unreachable, or to spend ~450,000 NGN
    recovering one hour. The expensive direction, not the safe one.
  - Two of the corpus's own cases were wrong when first written, and the agent
    was right. Both are annotated in the fixture with what they failed to test.
"""

from logistics.eval.agreement import (
    ActionAgreement,
    Decision,
    by_action,
    gather_decisions,
    pending_backlog,
)
from logistics.eval.autonomy import (
    COOLING_OFF,
    MIN_SAMPLES,
    TARGET_AGREEMENT,
    Recommendation,
    recommend,
)
from logistics.eval.cases import EvalCase, Expectation, load
from logistics.eval.replay import Outcome, Scorecard, run, score
from logistics.eval.stats import Proportion, samples_needed, wilson_lower

__all__ = [
    "COOLING_OFF",
    "MIN_SAMPLES",
    "TARGET_AGREEMENT",
    "ActionAgreement",
    "Decision",
    "EvalCase",
    "Expectation",
    "Outcome",
    "Proportion",
    "Recommendation",
    "Scorecard",
    "by_action",
    "gather_decisions",
    "load",
    "pending_backlog",
    "recommend",
    "run",
    "samples_needed",
    "score",
    "wilson_lower",
]
