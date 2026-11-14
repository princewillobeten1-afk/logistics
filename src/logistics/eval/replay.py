"""Run an agent against a case and score what it did.

Replay is safe by construction rather than by discipline. `investigate()` takes
a `CaseFile` and an `LLMClient` and returns an `Investigation`; `plan_resolution()`
is a pure function of that. Neither touches the database, sends a message, or
books anything — the side effects live in `handlers/exception.py`, which this
never calls. So there is no "dry run" flag to forget to set, and no way for an
eval to accidentally spend money.

The one real cost is model calls: a run is `cases x repeats` of them, against a
hosted tier that rate-limits. Hence `repeats` defaulting to 1 and the stability
check being opt-in.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import dataclass, field
from uuid import UUID

from logistics.eval.cases import EvalCase, severity_at_least
from logistics.eval.stats import Proportion
from logistics.exception_agent.reason import Investigation, investigate
from logistics.exception_agent.resolve import plan_resolution
from logistics.llm.base import LLMClient
from logistics.obs import get_logger

log = get_logger(__name__)

# `plan_resolution` needs a shipment id, which it only copies into the plan.
# Fixed rather than random so two runs of the same case produce identical plans
# and a diff shows only real change.
_STABLE_ID = UUID("00000000-0000-0000-0000-00000000e7a1")


@dataclass(frozen=True, slots=True)
class Outcome:
    """One agent run against one case."""

    case_id: str
    kind: str | None
    """The resolution it recommended. None when it produced nothing usable."""

    confidence: float | None
    severity: str | None
    deadline_at_risk: bool | None
    escalated: bool
    tier: int | None
    failures: tuple[str, ...] = ()

    @property
    def passed(self) -> bool:
        return not self.failures

    @property
    def unusable(self) -> bool:
        """The model produced nothing parseable after its retries. Counted
        separately from a wrong answer — it is an availability problem, and
        mixing the two makes a flaky provider look like a stupid agent."""
        return self.kind is None and "no usable investigation" in self.failures


def score(case: EvalCase, investigation: Investigation | None) -> Outcome:
    """Compare one answer against what the case demands."""
    if investigation is None:
        return Outcome(
            case_id=case.id, kind=None, confidence=None, severity=None,
            deadline_at_risk=None, escalated=False, tier=None,
            failures=("no usable investigation",),
        )

    recommended = investigation.recommended
    kind = str(recommended.kind)
    plan = plan_resolution(
        investigation,
        shipment_id=_STABLE_ID,
        current_carrier=case.case.current_carrier,
    )

    failures: list[str] = []
    expect = case.expect

    if expect.allowed and kind not in expect.allowed:
        failures.append(
            f"chose {kind}, expected one of {sorted(expect.allowed)}"
        )
    if kind in expect.forbidden_kinds:
        failures.append(f"chose {kind}, which is forbidden here")
    if expect.deadline_at_risk is not None and (
        investigation.deadline_at_risk != expect.deadline_at_risk
    ):
        failures.append(
            f"deadline_at_risk={investigation.deadline_at_risk}, "
            f"expected {expect.deadline_at_risk}"
        )
    if expect.min_severity and not severity_at_least(
        investigation.severity, expect.min_severity
    ):
        failures.append(
            f"severity {investigation.severity} is below {expect.min_severity}"
        )
    if expect.escalate is not None and plan.escalate != expect.escalate:
        failures.append(
            f"escalate={plan.escalate}, expected {expect.escalate}"
        )

    # Independent of any expectation. A resolution that costs money or leaves
    # the building must carry a tier the policy gate can act on; one that does
    # not is an action nobody authorised, and that is a bug in the agent rather
    # than a difference of opinion about this case.
    if plan.action is not None and plan.tier not in (2, 3):
        failures.append(
            f"produced action {plan.action!r} at tier {plan.tier}, which the "
            "policy gate would wave through"
        )

    return Outcome(
        case_id=case.id,
        kind=kind,
        confidence=investigation.confidence,
        severity=investigation.severity,
        deadline_at_risk=investigation.deadline_at_risk,
        escalated=plan.escalate,
        tier=plan.tier,
        failures=tuple(failures),
    )


@dataclass(slots=True)
class Scorecard:
    outcomes: list[Outcome] = field(default_factory=list)

    @property
    def accuracy(self) -> Proportion:
        judged = [o for o in self.outcomes if not o.unusable]
        return Proportion(
            successes=sum(1 for o in judged if o.passed), total=len(judged)
        )

    @property
    def unusable(self) -> int:
        return sum(1 for o in self.outcomes if o.unusable)

    @property
    def failures(self) -> list[Outcome]:
        return [o for o in self.outcomes if o.failures and not o.unusable]

    def calibration(self) -> list[tuple[str, Proportion]]:
        """Does stated confidence predict being right?

        The most decision-relevant number here. Gating autonomy on "act alone
        when confident" only works if confidence carries information — an agent
        that says 0.95 on everything, right or wrong, cannot be gated that way
        however accurate it is on average.
        """
        buckets: dict[str, list[Outcome]] = {}
        for outcome in self.outcomes:
            if outcome.confidence is None:
                continue
            label = _bucket(outcome.confidence)
            buckets.setdefault(label, []).append(outcome)

        return [
            (
                label,
                Proportion(
                    successes=sum(1 for o in items if o.passed), total=len(items)
                ),
            )
            for label, items in sorted(buckets.items())
        ]

    def stability(self) -> dict[str, float]:
        """How often repeats of the same case agreed with each other.

        1.0 means the agent always said the same thing. Anything much below
        that is a reason not to raise a cap regardless of accuracy: a decision
        that changes when you ask twice is not a judgement, and the average
        being right is no comfort when a single roll of the dice books a truck.
        """
        by_case: dict[str, list[str | None]] = {}
        for outcome in self.outcomes:
            by_case.setdefault(outcome.case_id, []).append(outcome.kind)

        return {
            case_id: Counter(kinds).most_common(1)[0][1] / len(kinds)
            for case_id, kinds in by_case.items()
            if len(kinds) > 1
        }


class _AtTemperature(LLMClient):
    """Forces a temperature on every request passing through.

    So "would this be more stable at temperature 0" is a measurable question
    rather than an argument. Wrapping rather than adding a parameter to
    `investigate` keeps the eval from needing production code to change shape
    in order to be evaluated.
    """

    def __init__(self, inner: LLMClient, temperature: float) -> None:
        self._inner = inner
        self._temperature = temperature

    async def complete(self, req):  # noqa: ANN001, ANN201
        from dataclasses import replace as _replace

        return await self._inner.complete(
            _replace(req, temperature=self._temperature)
        )


async def run(
    llm: LLMClient,
    cases: list[EvalCase],
    *,
    repeats: int = 1,
    allow_escalation: bool = False,
    concurrency: int = 2,
    temperature: float | None = None,
) -> Scorecard:
    """Replay every case. Nothing here has a side effect outside this process.

    `allow_escalation` defaults off: the escalation path sends the case to
    Ultra, which would make a run several times slower and dearer while
    measuring a different model from the one that handles the load.
    """
    if temperature is not None:
        llm = _AtTemperature(llm, temperature)

    semaphore = asyncio.Semaphore(concurrency)
    card = Scorecard()

    async def one(case: EvalCase) -> Outcome:
        async with semaphore:
            investigation = await investigate(
                llm, case.case, allow_escalation=allow_escalation
            )
        return score(case, investigation)

    for attempt in range(repeats):
        results = await asyncio.gather(
            *(one(case) for case in cases), return_exceptions=True
        )
        for case, result in zip(cases, results, strict=True):
            if isinstance(result, BaseException):
                # A provider outage is not the agent being wrong. Recorded as
                # unusable so it shows up in the report without polluting the
                # accuracy figure.
                log.warning("eval.case_error", case=case.id, error=str(result))
                card.outcomes.append(
                    Outcome(
                        case_id=case.id, kind=None, confidence=None, severity=None,
                        deadline_at_risk=None, escalated=False, tier=None,
                        failures=("no usable investigation",),
                    )
                )
            else:
                card.outcomes.append(result)
        log.info("eval.pass_complete", attempt=attempt + 1, of=repeats)

    return card


def _bucket(confidence: float) -> str:
    if confidence >= 0.9:
        return "0.9-1.0"
    if confidence >= 0.8:
        return "0.8-0.9"
    if confidence >= 0.65:
        return "0.65-0.8"
    return "below 0.65"
