"""The Exception Management Agent.

Routed from EXCEPTION since the state machine was written and unregistered
until now, so every shipment that hit trouble stranded with a DEAD work item.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from pydantic import ValidationError

from logistics.domain.states import ShipmentState
from logistics.exception_agent.gather import CarrierOption, CaseFile, OpenException, build_case
from logistics.exception_agent.reason import (
    Investigation,
    Resolution,
    ResolutionKind,
    investigate,
)
from logistics.exception_agent.resolve import plan_resolution, should_resolve_exception
from logistics.exceptions import ExceptionRepo
from logistics.tracking.detection import Detection, DetectionKind, Severity
from tests.conftest import ScriptedLLM

S = ShipmentState
SHIPMENT = uuid4()


def _case(**kw) -> CaseFile:
    base = dict(
        reference="TEST-1",
        state=S.EXCEPTION,
        exceptions=[
            OpenException(
                kind="SLA_BREACH_RISK",
                severity="CRITICAL",
                summary="Projected to miss the deadline by 3 hours",
                detail={"over_by_minutes": 180},
                detected_by="detector",
                age_hours=0.5,
            )
        ],
    )
    return CaseFile(**{**base, **kw})


def _investigation(**kw) -> str:
    base = {
        "cause": "Held up in Lagos traffic on a route with no slack",
        "impact": "Delivery will miss the promised window by about three hours",
        "severity": "HIGH",
        "deadline_at_risk": True,
        "resolutions": [
            {"kind": "ACCEPT_DELAY", "rationale": "Nothing faster is available"}
        ],
        "confidence": 0.85,
    }
    return json.dumps({**base, **kw})


# ------------------------------------------------------------- the schema


def test_resourcing_must_name_a_carrier():
    """Otherwise the resolution is an instruction nobody can carry out."""
    with pytest.raises(ValidationError, match="needs a carrier_code"):
        Resolution(kind=ResolutionKind.RESOURCE_CARRIER, rationale="find someone else")


def test_resourcing_with_a_carrier_is_fine():
    r = Resolution(
        kind=ResolutionKind.RESOURCE_CARRIER, rationale="faster", carrier_code="T-PREMIUM"
    )
    assert r.carrier_code == "T-PREMIUM"


def test_an_investigation_needs_at_least_one_resolution():
    with pytest.raises(ValidationError):
        Investigation(
            cause="x", impact="y", severity="HIGH",
            deadline_at_risk=True, resolutions=[], confidence=0.9,
        )


# --------------------------------------------------------- the case file


def test_slack_is_time_left_minus_transit():
    case = _case(hours_to_deadline=10, planned_transit_hours=12)
    assert case.slack_hours == -2


def test_slack_is_unknown_without_both_numbers():
    assert _case(hours_to_deadline=10).slack_hours is None


def test_the_prompt_says_when_the_deadline_cannot_be_met():
    case = _case(hours_to_deadline=4, planned_transit_hours=11)
    assert "cannot be met" in case.as_prompt()


def test_worst_severity_wins():
    case = _case(
        exceptions=[
            OpenException("DWELL", "MEDIUM", "stopped", {}, "detector", 1.0),
            OpenException("SLA_BREACH_RISK", "CRITICAL", "late", {}, "detector", 1.0),
        ]
    )
    assert case.worst_severity == "CRITICAL"


def test_alternatives_show_whether_they_can_be_reached():
    case = _case(
        alternatives=[
            CarrierOption("T-A", "A", 0.95, 45_000_00, "NGN", reachable=True),
            CarrierOption("T-B", "B", 0.80, None, None, reachable=False),
        ]
    )
    prompt = case.as_prompt()
    assert "95% on-time" in prompt
    assert "cannot be contacted" in prompt


def test_no_alternatives_is_stated_plainly():
    assert "No alternative carriers" in _case().as_prompt()


async def test_the_case_file_is_assembled_from_the_database(db, repo, reference):
    shipment = await repo.create(
        reference=reference,
        state=S.EXCEPTION,
        origin={"city": "Lagos"},
        destination={"city": "Abuja"},
        deadline=datetime.now(UTC) + timedelta(hours=6),
    )
    await ExceptionRepo(db).raise_detection(
        shipment_id=shipment.id,
        detection=Detection(
            kind=DetectionKind.SLA_BREACH_RISK,
            severity=Severity.CRITICAL,
            summary="Will miss by 3 hours",
        ),
    )

    case = await build_case(db, shipment.id)

    assert case is not None
    assert case.reference == reference
    assert len(case.exceptions) == 1
    assert case.exceptions[0].kind == "SLA_BREACH_RISK"
    assert case.origin == "Lagos"
    assert 5 < case.hours_to_deadline < 7


async def test_a_shipment_with_no_open_exceptions_yields_none_to_reason_about(
    db, repo, reference
):
    shipment = await repo.create(reference=reference, state=S.EXCEPTION)
    case = await build_case(db, shipment.id)
    assert case is not None
    assert case.exceptions == []


# ------------------------------------------------------------- reasoning


async def test_a_confident_assessment_is_returned(db):
    llm = ScriptedLLM(_investigation())
    result = await investigate(llm, _case())

    assert result is not None
    assert result.recommended.kind is ResolutionKind.ACCEPT_DELAY
    assert len(llm.requests) == 1, "no escalation needed"


async def test_low_confidence_escalates_to_the_bigger_model(db):
    """The one place a slower, dearer model earns its cost."""
    from logistics.llm.registry import Job

    llm = ScriptedLLM(
        _investigation(confidence=0.3),
        _investigation(confidence=0.9, cause="Vehicle breakdown near Lokoja"),
    )
    result = await investigate(llm, _case())

    assert len(llm.requests) == 2
    assert llm.requests[0].job is Job.EXCEPTION_REASONING
    assert llm.requests[1].job is Job.EXCEPTION_ESCALATION
    assert result.cause == "Vehicle breakdown near Lokoja"


async def test_escalation_can_be_turned_off(db):
    llm = ScriptedLLM(_investigation(confidence=0.2))
    await investigate(llm, _case(), allow_escalation=False)
    assert len(llm.requests) == 1


async def test_an_unreadable_assessment_returns_nothing(db):
    """Better a human than a guess about a shipment in trouble."""
    llm = ScriptedLLM("garbage", "still garbage", "nope")
    assert await investigate(llm, _case()) is None


async def test_a_truncated_assessment_is_refused_even_though_it_parses(db):
    """The dangerous case is not a parse failure — that raises. It is an answer
    that parses and is wrong: `resolutions` is a ranked list, and one cut short
    makes the recommendation whichever option the model wrote first rather than
    the one it ranked highest.

    Found by the eval harness, which reported truncation on roughly a quarter
    of cases at the old token budget while every answer still looked fine.
    """
    from tests.conftest import Reply

    llm = ScriptedLLM(Reply(text=_investigation(), finish_reason="length"))
    assert await investigate(llm, _case()) is None


async def test_a_complete_assessment_is_accepted(db):
    """The other half of the pair — the guard must not reject normal answers."""
    from tests.conftest import Reply

    llm = ScriptedLLM(Reply(text=_investigation(), finish_reason="stop"))
    assert await investigate(llm, _case()) is not None


async def test_a_failed_escalation_keeps_the_first_answer(db):
    llm = ScriptedLLM(
        _investigation(confidence=0.3), "garbage", "garbage", "garbage"
    )
    result = await investigate(llm, _case())
    assert result is not None, "losing both assessments would be worse than one weak one"


# ------------------------------------------------------------ resolving


def _inv(kind: ResolutionKind, **kw) -> Investigation:
    return Investigation(
        cause="c", impact="i", severity="HIGH", deadline_at_risk=True,
        resolutions=[Resolution(kind=kind, rationale="because", **kw)],
        confidence=0.9,
        customer_message=None,
    )


def test_resourcing_proposes_a_booking_and_re_plans():
    plan = plan_resolution(
        _inv(ResolutionKind.RESOURCE_CARRIER, carrier_code="T-PREMIUM",
             estimated_cost_minor=50_000_00),
        shipment_id=SHIPMENT,
        current_carrier="T-CHEAP",
    )
    assert plan.action == "book_shipment"
    assert plan.tier == 3, "it spends money"
    assert plan.transition is ShipmentState.PLANNED
    assert plan.params["replacing"] == "T-CHEAP"


def test_expediting_proposes_a_reroute():
    plan = plan_resolution(
        _inv(ResolutionKind.EXPEDITE, estimated_cost_minor=18_000_00),
        shipment_id=SHIPMENT, current_carrier="T-SOLID",
    )
    assert plan.action == "reroute_vehicle"
    assert plan.tier == 3


def test_accepting_a_delay_buys_nothing():
    plan = plan_resolution(
        _inv(ResolutionKind.ACCEPT_DELAY), shipment_id=SHIPMENT, current_carrier="T-A"
    )
    assert plan.tier == 2, "a message is irreversible socially but costs nothing"
    assert plan.transition is None


def test_escalating_proposes_no_action_at_all():
    plan = plan_resolution(
        _inv(ResolutionKind.ESCALATE), shipment_id=SHIPMENT, current_carrier=None
    )
    assert plan.action is None
    assert plan.escalate is True


def test_no_action_does_nothing():
    plan = plan_resolution(
        _inv(ResolutionKind.NO_ACTION), shipment_id=SHIPMENT, current_carrier=None
    )
    assert plan.action is None
    assert plan.escalate is False


def test_the_agent_never_produces_an_ungated_action():
    """Every resolution that costs anything must go through the policy gate."""
    for kind in ResolutionKind:
        extra = (
            {"carrier_code": "T-A"} if kind is ResolutionKind.RESOURCE_CARRIER else {}
        )
        plan = plan_resolution(
            _inv(kind, **extra), shipment_id=SHIPMENT, current_carrier="T-B"
        )
        if plan.action is not None:
            assert plan.tier in (2, 3), f"{kind} produced an ungated action"


def test_an_exception_is_only_closed_when_it_has_actually_cleared():
    """Never closed by having been discussed."""
    assert should_resolve_exception(_inv(ResolutionKind.NO_ACTION)) is True
    assert should_resolve_exception(_inv(ResolutionKind.ACCEPT_DELAY)) is False

    unsure = _inv(ResolutionKind.NO_ACTION).model_copy(update={"confidence": 0.4})
    assert should_resolve_exception(unsure) is False
