"""Eval cases: a situation, and what a competent operator would do about it.

Two sources, and the distinction matters.

**Fixtures** (`fixtures/eval/*.jsonl`) are hand-written, with an expected
outcome someone committed to in advance. They are the regression suite: change
a prompt or a model and these tell you what broke. Their weakness is that they
only cover situations somebody thought to imagine.

**Captured** cases are pulled from production — a real `CaseFile` that a real
exception produced. They cover the true distribution, but have no label until
someone rules on them, which is what `agreement.py` measures instead.

An expectation here is a *floor*, not a script. `expected_kind` says which
resolution a competent operator would reach; `forbidden_kinds` says which ones
would be actively wrong. Most cases have several defensible answers, and an
eval that demands one exact string measures conformity to its own author
rather than judgement.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from logistics.domain.states import ShipmentState
from logistics.exception_agent.gather import CarrierOption, CaseFile, OpenException
from logistics.exception_agent.reason import ResolutionKind

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures" / "eval"


@dataclass(frozen=True, slots=True)
class Expectation:
    """What the answer has to satisfy. Everything is optional: a case may only
    care that the agent did not do something catastrophic."""

    kind: str | None = None
    """The resolution a competent operator would reach."""

    acceptable_kinds: tuple[str, ...] = ()
    """Others that are also defensible. `kind` is included automatically."""

    forbidden_kinds: tuple[str, ...] = ()
    """Answers that would be actively wrong here."""

    deadline_at_risk: bool | None = None
    min_severity: str | None = None
    escalate: bool | None = None
    """Whether a competent operator would hand this to a human."""

    @property
    def allowed(self) -> set[str]:
        allowed = set(self.acceptable_kinds)
        if self.kind:
            allowed.add(self.kind)
        return allowed


@dataclass(frozen=True, slots=True)
class EvalCase:
    id: str
    note: str
    case: CaseFile
    expect: Expectation
    tags: tuple[str, ...] = ()


_SEVERITY_ORDER = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}


def severity_at_least(observed: str, minimum: str) -> bool:
    return _SEVERITY_ORDER.get(observed.upper(), -1) >= _SEVERITY_ORDER.get(
        minimum.upper(), 99
    )


def _case_from(raw: dict[str, Any]) -> CaseFile:
    return CaseFile(
        reference=raw.get("reference", "EVAL-1"),
        state=ShipmentState(raw.get("state", "EXCEPTION")),
        exceptions=[
            OpenException(
                kind=e["kind"],
                severity=e.get("severity", "MEDIUM"),
                summary=e.get("summary", ""),
                detail=e.get("detail", {}),
                detected_by=e.get("detected_by", "detector"),
                age_hours=float(e.get("age_hours", 1.0)),
            )
            for e in raw.get("exceptions", [])
        ],
        origin=raw.get("origin"),
        destination=raw.get("destination"),
        hours_to_deadline=raw.get("hours_to_deadline"),
        planned_transit_hours=raw.get("planned_transit_hours"),
        current_carrier=raw.get("current_carrier"),
        booked_minor=raw.get("booked_minor"),
        currency=raw.get("currency"),
        percent_complete=raw.get("percent_complete"),
        sourcing_rounds=raw.get("sourcing_rounds", 0),
        customer_told=raw.get("customer_told", False),
        alternatives=[
            CarrierOption(
                code=a["code"],
                name=a.get("name", a["code"]),
                on_time_rate=a.get("on_time_rate"),
                quoted_minor=a.get("quoted_minor"),
                currency=a.get("currency"),
                reachable=a.get("reachable", True),
            )
            for a in raw.get("alternatives", [])
        ],
    )


def load(path: Path | None = None) -> list[EvalCase]:
    """Read a .jsonl corpus. One case per line, so a diff shows exactly which
    case changed rather than reindenting the file."""
    path = path or (FIXTURES / "exception_cases.jsonl")
    if not path.exists():
        return []

    cases: list[EvalCase] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path.name} line {line_no}: {exc}") from exc

        expect = raw.get("expect", {})
        cases.append(
            EvalCase(
                id=raw["id"],
                note=raw.get("note", ""),
                case=_case_from(raw),
                expect=Expectation(
                    kind=expect.get("kind"),
                    acceptable_kinds=tuple(expect.get("acceptable_kinds", ())),
                    forbidden_kinds=tuple(expect.get("forbidden_kinds", ())),
                    deadline_at_risk=expect.get("deadline_at_risk"),
                    min_severity=expect.get("min_severity"),
                    escalate=expect.get("escalate"),
                ),
                tags=tuple(raw.get("tags", ())),
            )
        )

    _validate(cases, path)
    return cases


def _validate(cases: list[EvalCase], path: Path) -> None:
    """Catch a corpus that cannot be satisfied before spending model calls on
    it. A case whose expected answer is also forbidden is unpassable, and would
    otherwise look like the agent failing."""
    seen: set[str] = set()
    known = {str(k) for k in ResolutionKind}

    for case in cases:
        if case.id in seen:
            raise ValueError(f"{path.name}: duplicate case id {case.id!r}")
        seen.add(case.id)

        for name in (*case.expect.allowed, *case.expect.forbidden_kinds):
            if name not in known:
                raise ValueError(
                    f"{path.name}: case {case.id!r} names unknown resolution "
                    f"{name!r}; known kinds are {sorted(known)}"
                )

        clash = case.expect.allowed & set(case.expect.forbidden_kinds)
        if clash:
            raise ValueError(
                f"{path.name}: case {case.id!r} both expects and forbids "
                f"{sorted(clash)} — no answer could pass"
            )

        if not case.case.exceptions:
            raise ValueError(
                f"{path.name}: case {case.id!r} has no open exception, so there "
                "is nothing for the agent to reason about"
            )
