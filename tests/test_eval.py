"""The autonomy evidence harness.

The point of all this is to stop a cap being raised because the agents "seem
fine". So the tests that matter are the ones proving it says no — a harness
that can be talked into a recommendation is worse than none, because it lends
a number to a decision that was made on vibes.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime, timedelta

import pytest

from logistics.eval.agreement import (
    ActionAgreement,
    Decision,
    by_action,
    gather_decisions,
    pending_backlog,
)
from logistics.eval.autonomy import COOLING_OFF, MIN_SAMPLES, TARGET_AGREEMENT, recommend
from logistics.eval.cases import Expectation, load, severity_at_least
from logistics.eval.replay import Outcome, Scorecard, score
from logistics.eval.stats import (
    Proportion,
    _z,
    median,
    samples_needed,
    wilson_lower,
)

NOW = datetime(2026, 9, 2, tzinfo=UTC)


# ------------------------------------------------------------- statistics


def test_the_normal_quantile_matches_known_values():
    """Everything downstream is this function. Values from standard tables."""
    assert _z(0.95) == pytest.approx(1.6449, abs=1e-3)
    assert _z(0.975) == pytest.approx(1.9600, abs=1e-3)
    assert _z(0.99) == pytest.approx(2.3263, abs=1e-3)
    assert _z(0.5) == pytest.approx(0.0, abs=1e-6)


def test_a_perfect_record_of_one_proves_almost_nothing():
    """The whole reason for a Wilson bound. One correct decision is a 100%
    success rate, and the naive interval reports a width of zero there because
    p(1-p) is 0 — which reads as certainty.

    0.27 is the one-sided 95% value (z=1.645). The two-sided figure people
    usually quote is 0.21; they are different questions, and this one asks only
    how bad the agent could be.
    """
    assert wilson_lower(1, 1) == pytest.approx(0.270, abs=0.005)


def test_the_bound_rises_with_evidence_not_with_luck():
    """Same perfect rate throughout; only the sample size differs."""
    bounds = [wilson_lower(n, n) for n in (1, 5, 10, 30, 100)]
    assert bounds == sorted(bounds), "more evidence must never lower the bound"
    assert bounds[0] < 0.3
    assert bounds[3] > 0.85
    assert bounds[4] > 0.95


def test_the_bound_never_exceeds_the_observed_rate():
    for successes, total in ((0, 10), (5, 10), (9, 10), (10, 10), (37, 40)):
        assert wilson_lower(successes, total) <= successes / total + 1e-9


def test_no_observations_is_not_evidence_of_success():
    assert wilson_lower(0, 0) == 0.0
    assert Proportion(0, 0).rate == 0.0
    assert "no observations" in str(Proportion(0, 0))


def test_the_sample_floor_is_stricter_than_the_statistics_require():
    """22 flawless decisions already clear a 90% lower bound. The floor is 30.

    That gap is deliberate and worth pinning, because it looks like an
    off-by-something otherwise: 22 assumes a representative sample, and early
    approvals are not one — they are whatever reached the queue first.
    """
    statistical_minimum = samples_needed(TARGET_AGREEMENT)
    assert statistical_minimum < MIN_SAMPLES, (
        "if the statistics ever needed more than the floor, the floor is a lie"
    )
    assert wilson_lower(MIN_SAMPLES, MIN_SAMPLES) >= TARGET_AGREEMENT


def test_impossible_inputs_are_refused():
    with pytest.raises(ValueError):
        wilson_lower(5, 3)
    with pytest.raises(ValueError):
        _z(1.0)
    with pytest.raises(ValueError):
        samples_needed(1.0)


def test_the_sample_estimate_is_the_optimistic_case():
    """`samples_needed` assumes not one more mistake, so the real number is
    always larger. Worth pinning, because it gets quoted at people."""
    n = samples_needed(TARGET_AGREEMENT)
    assert wilson_lower(n, n) >= TARGET_AGREEMENT
    assert wilson_lower(n - 1, n - 1) < TARGET_AGREEMENT


def test_amounts_stay_integers():
    """Minor units throughout. The policy engine denies on a float, and an
    average that produced one would be refused at the gate."""
    assert median([100, 200, 300, 400]) == 250
    assert isinstance(median([1, 2]), int)
    assert median([]) == 0


# ------------------------------------------------------- the recommendation


def _decision(*, approved=True, amount=10_000_00, days_ago=90, action="book_shipment"):
    return Decision(
        action=action, tier=3, amount_minor=amount, currency="NGN",
        approved=approved, decided_by="ops@example.com",
        decided_at=NOW - timedelta(days=days_ago),
        reference="EVAL-1", policy_reason="cap is zero",
    )


def _agreement(decisions):
    return ActionAgreement(action="book_shipment", decisions=decisions)


def test_one_approval_recommends_nothing():
    """Today's actual state: a single decided approval. It has to say no."""
    result = recommend(_agreement([_decision()]), now=NOW)
    assert result.recommended_cap_minor == 0
    assert not result.would_raise
    assert "only 1 decided approval" in " ".join(result.reasons)


def test_a_short_perfect_run_still_recommends_nothing():
    """Ten for ten looks convincing and is not. This is the case the harness
    exists to refuse."""
    result = recommend(_agreement([_decision() for _ in range(10)]), now=NOW)
    assert result.recommended_cap_minor == 0
    assert result.agreement_rate == 1.0
    assert result.agreement_lower < TARGET_AGREEMENT


def test_enough_agreement_finally_supports_a_cap():
    result = recommend(
        _agreement([_decision() for _ in range(40)]), stability=1.0, now=NOW
    )
    assert result.recommended_cap_minor == 10_000_00
    assert result.would_raise
    assert result.agreement_lower >= TARGET_AGREEMENT


def test_unmeasured_stability_blocks_the_raise():
    """An unmeasured agent is not a stable one, it is an unknown one."""
    result = recommend(_agreement([_decision() for _ in range(40)]), now=NOW)
    assert result.recommended_cap_minor == 0
    assert "has not been measured" in " ".join(result.reasons)


def test_an_agent_that_changes_its_mind_gets_no_cap():
    """The finding that actually blocks a raise today. The exception agent
    answers about a quarter of replayed cases differently on a second run, at
    every temperature tried — so agreement alone would have authorised a coin
    flip."""
    result = recommend(
        _agreement([_decision() for _ in range(40)]), stability=0.75, now=NOW
    )
    assert result.recommended_cap_minor == 0
    assert "75%" in " ".join(result.reasons)
    assert result.agreement_lower >= TARGET_AGREEMENT, (
        "agreement was fine; stability is what refused it"
    )


def test_the_cap_is_the_median_not_the_largest():
    """Setting it at the largest would authorise, unsupervised, the single most
    expensive decision the agent has ever made — on the strength of one person
    agreeing with it once."""
    # 39 routine bookings around ₦1,000-₦5,000 and one outlier at ₦90,000.
    amounts = [1_000_00] * 30 + [5_000_00] * 9 + [90_000_00]
    result = recommend(
        _agreement([_decision(amount=a) for a in amounts]),
        stability=1.0, now=NOW,
    )
    assert result.recommended_cap_minor == 1_000_00
    assert result.largest_seen_minor == 90_000_00
    assert "90,000" in " ".join(result.reasons), (
        "the outlier must be visible, or the recommendation looks arbitrary"
    )


def test_a_recent_rejection_blocks_the_raise():
    """Recency beats rate. An agent reliable for months that proposed something
    refused last Tuesday has changed, and the aggregate hides it."""
    decisions = [_decision() for _ in range(60)]
    decisions.append(_decision(approved=False, days_ago=3))
    result = recommend(_agreement(decisions), now=NOW)

    assert result.recommended_cap_minor == 0
    assert "3 day(s) ago" in " ".join(result.reasons)


def test_an_old_rejection_does_not_block_forever():
    decisions = [_decision() for _ in range(60)]
    decisions.append(_decision(approved=False, days_ago=COOLING_OFF.days + 30))
    result = recommend(_agreement(decisions), stability=1.0, now=NOW)
    assert result.recommended_cap_minor > 0


def test_disagreement_pushes_the_bound_under_the_target():
    decisions = [_decision() for _ in range(30)]
    decisions += [_decision(approved=False, days_ago=200) for _ in range(6)]
    result = recommend(_agreement(decisions), now=NOW)

    assert result.recommended_cap_minor == 0
    assert result.agreement_rate < 1.0
    assert "lower bound" in " ".join(result.reasons)


def test_approvals_with_no_amount_support_no_monetary_cap():
    result = recommend(
        _agreement([_decision(amount=None) for _ in range(40)]),
        stability=1.0, now=NOW,
    )
    assert result.recommended_cap_minor == 0
    assert "nothing to base a monetary cap on" in " ".join(result.reasons)


def test_mixed_currencies_are_not_averaged():
    """A cap is a policy value in one currency. Averaging across them produces
    a number that is not a limit on anything."""
    decisions = [_decision() for _ in range(20)]
    decisions += [
        Decision(
            action="book_shipment", tier=3, amount_minor=500_00, currency="USD",
            approved=True, decided_by="x", decided_at=NOW - timedelta(days=90),
            reference="r", policy_reason=None,
        )
        for _ in range(20)
    ]
    result = recommend(_agreement(decisions), now=NOW)
    assert "/" in result.currency, "mixed currencies must be visible, not hidden"


def test_the_recommendation_says_measurement_stops_when_the_cap_rises():
    """Raising a cap removes exactly the decisions that were being measured.
    An operator who does not know that will never re-check."""
    result = recommend(
        _agreement([_decision() for _ in range(40)]), stability=1.0, now=NOW
    )
    assert "stops being measured" in " ".join(result.reasons)


def test_agreement_is_reported_per_action():
    """An agent may be reliable at re-sourcing and poor at expediting; one
    combined number hides both, and caps are per-action for the same reason."""
    decisions = [
        _decision(action="book_shipment"),
        _decision(action="book_shipment", approved=False),
        _decision(action="reroute_vehicle"),
    ]
    grouped = by_action(decisions)
    assert set(grouped) == {"book_shipment", "reroute_vehicle"}
    assert grouped["book_shipment"].proportion.rate == 0.5
    assert grouped["reroute_vehicle"].proportion.rate == 1.0


# ------------------------------------------------------------ the corpus


def test_the_corpus_loads_and_is_satisfiable():
    """`load` refuses a case whose expected answer is also forbidden. Without
    the check that reads as the agent failing, on every run, forever."""
    cases = load()
    assert len(cases) >= 8
    for case in cases:
        assert case.case.exceptions, f"{case.id} gives the agent nothing to judge"
        assert not (case.expect.allowed & set(case.expect.forbidden_kinds))


def test_the_corpus_covers_restraint_as_well_as_action():
    """An eval made only of "do something" cases rewards an agent that always
    acts — which is the expensive failure mode, not the safe one."""
    cases = load()
    tags = {t for c in cases for t in c.tags}
    assert "restraint" in tags
    assert "money" in tags
    assert sum(1 for c in cases if "restraint" in c.tags) >= 3


def test_a_duplicate_case_id_is_refused(tmp_path):
    path = tmp_path / "dupes.jsonl"
    line = json.dumps({
        "id": "same", "exceptions": [{"kind": "DWELL"}], "expect": {},
    })
    path.write_text(f"{line}\n{line}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate case id"):
        load(path)


def test_an_unknown_resolution_name_is_refused(tmp_path):
    path = tmp_path / "typo.jsonl"
    path.write_text(
        json.dumps({
            "id": "typo", "exceptions": [{"kind": "DWELL"}],
            "expect": {"kind": "RESOURCE_CARIER"},
        }) + "\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="unknown resolution"):
        load(path)


def test_an_unsatisfiable_case_is_refused(tmp_path):
    path = tmp_path / "impossible.jsonl"
    path.write_text(
        json.dumps({
            "id": "impossible", "exceptions": [{"kind": "DWELL"}],
            "expect": {"kind": "NO_ACTION", "forbidden_kinds": ["NO_ACTION"]},
        }) + "\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="no answer could pass"):
        load(path)


def test_severity_ordering():
    assert severity_at_least("CRITICAL", "HIGH")
    assert severity_at_least("HIGH", "HIGH")
    assert not severity_at_least("MEDIUM", "HIGH")
    assert not severity_at_least("nonsense", "LOW")


# ------------------------------------------------------------- scoring


def _outcome(case_id="c", *, passed=True, confidence=0.9, kind="NO_ACTION"):
    return Outcome(
        case_id=case_id, kind=kind, confidence=confidence, severity="HIGH",
        deadline_at_risk=True, escalated=False, tier=None,
        failures=() if passed else ("wrong",),
    )


def test_an_unusable_answer_is_not_counted_as_wrong():
    """A provider outage is an availability problem. Mixing it into accuracy
    makes a flaky endpoint look like a stupid agent."""
    card = Scorecard(outcomes=[
        _outcome("a"), _outcome("b"),
        Outcome("c", None, None, None, None, False, None,
                ("no usable investigation",)),
    ])
    assert card.unusable == 1
    assert card.accuracy.total == 2
    assert card.accuracy.rate == 1.0


def test_calibration_buckets_by_stated_confidence():
    """Gating on "act alone when confident" only works if confidence carries
    information — an agent saying 0.95 on everything cannot be gated that way."""
    card = Scorecard(outcomes=[
        _outcome("a", confidence=0.95, passed=True),
        _outcome("b", confidence=0.95, passed=True),
        _outcome("c", confidence=0.5, passed=False),
    ])
    buckets = dict(card.calibration())
    assert buckets["0.9-1.0"].rate == 1.0
    assert buckets["below 0.65"].rate == 0.0


def test_stability_measures_repeat_agreement():
    """A decision that changes when you ask twice is not a judgement, and being
    right on average is no comfort when one roll books a truck."""
    card = Scorecard(outcomes=[
        _outcome("a", kind="NO_ACTION"),
        _outcome("a", kind="NO_ACTION"),
        _outcome("b", kind="NO_ACTION"),
        _outcome("b", kind="RESOURCE_CARRIER"),
    ])
    stability = card.stability()
    assert stability["a"] == 1.0
    assert stability["b"] == 0.5


def test_a_single_pass_reports_no_stability():
    """Nothing to compare against; reporting 1.0 would claim a property that
    was never measured."""
    assert Scorecard(outcomes=[_outcome("a")]).stability() == {}


def test_an_ungated_action_fails_regardless_of_the_expectation():
    """Independent of any case's opinion. An action the policy gate would wave
    through is a bug in the agent, not a difference of view."""
    from logistics.eval.cases import EvalCase
    from logistics.exception_agent.gather import CaseFile, OpenException
    from logistics.exception_agent.reason import (
        Investigation,
        Resolution,
        ResolutionKind,
    )
    from logistics.domain.states import ShipmentState

    case = EvalCase(
        id="x", note="", expect=Expectation(),
        case=CaseFile(
            reference="X", state=ShipmentState.EXCEPTION,
            exceptions=[OpenException("DWELL", "LOW", "s", {}, "d", 1.0)],
        ),
    )
    investigation = Investigation(
        cause="c", impact="i", severity="LOW", deadline_at_risk=False,
        resolutions=[Resolution(kind=ResolutionKind.ACCEPT_DELAY, rationale="r")],
        confidence=0.9,
    )
    outcome = score(case, investigation)
    # ACCEPT_DELAY is tier 2, which is gated — so this must pass.
    assert outcome.passed, outcome.failures


# ---------------------------------------------------------- against the db


async def test_gathering_decisions_ignores_what_nobody_decided(db, repo, reference):
    """An expired approval is nobody looking, not a human disagreeing.
    Counting it as a rejection punishes the agent for an operational gap."""
    shipment = await repo.create(reference=reference)
    async with db.connection() as conn:
        cur = await conn.execute(
            "INSERT INTO proposed_actions (shipment_id, action, params, tier,"
            "                              policy_decision, state)"
            " VALUES (%s, 'book_shipment', '{}'::jsonb, 3, 'REQUIRE_APPROVAL',"
            "         'PROPOSED') RETURNING id",
            (shipment.id,),
        )
        action_id = (await cur.fetchone())["id"]

        for state, token, decided in (
            ("APPROVED", "t-approved", "ops@example.com"),
            ("REJECTED", "t-rejected", "ops@example.com"),
            ("EXPIRED", "t-expired", None),
            ("PENDING", "t-pending", None),
        ):
            await conn.execute(
                "INSERT INTO approvals (proposed_action_id, shipment_id, token,"
                "                       summary, amount_minor, state, decided_by,"
                "                       decided_at, expires_at)"
                " VALUES (%s, %s, %s, 'x', 100000, %s, %s,"
                # The cast is required: Postgres cannot infer a parameter's
                # type from inside a CASE, and refuses the statement outright.
                "         CASE WHEN %s::text IS NULL THEN NULL ELSE now() END,"
                "         now() + interval '1 day')",
                (action_id, shipment.id, token, state, decided, decided),
            )

    decisions = await gather_decisions(db)
    assert len(decisions) == 2
    assert {d.approved for d in decisions} == {True, False}


async def test_the_pending_backlog_is_reported(db, repo, reference):
    """A large backlog means the sample is biased, not just small: easy calls
    get decided and hard ones sit, so measured agreement flatters the agent."""
    assert await pending_backlog(db) == 0

    shipment = await repo.create(reference=reference)
    async with db.connection() as conn:
        cur = await conn.execute(
            "INSERT INTO proposed_actions (shipment_id, action, params, tier,"
            "                              policy_decision, state)"
            " VALUES (%s, 'book_shipment', '{}'::jsonb, 3, 'REQUIRE_APPROVAL',"
            "         'PROPOSED') RETURNING id",
            (shipment.id,),
        )
        action_id = (await cur.fetchone())["id"]
        await conn.execute(
            "INSERT INTO approvals (proposed_action_id, shipment_id, token,"
            "                       summary, state, expires_at)"
            " VALUES (%s, %s, 'pending-1', 'x', 'PENDING',"
            "         now() + interval '1 day')",
            (action_id, shipment.id),
        )

    assert await pending_backlog(db) == 1


async def test_evidence_does_not_cross_organisations(db, other_org):
    """One tenant's approvals must never raise another tenant's caps."""
    async with db.connection(privileged=True) as conn:
        cur = await conn.execute(
            "INSERT INTO shipments (org_id, reference, state)"
            " VALUES (%s, 'THEIR-EVIDENCE', 'DRAFT') RETURNING id",
            (other_org,),
        )
        shipment_id = (await cur.fetchone())["id"]
        cur = await conn.execute(
            "INSERT INTO proposed_actions (org_id, shipment_id, action, params,"
            "                              tier, policy_decision, state)"
            " VALUES (%s, %s, 'book_shipment', '{}'::jsonb, 3,"
            "         'REQUIRE_APPROVAL', 'PROPOSED') RETURNING id",
            (other_org, shipment_id),
        )
        action_id = (await cur.fetchone())["id"]
        await conn.execute(
            "INSERT INTO approvals (org_id, proposed_action_id, shipment_id, token,"
            "                       summary, amount_minor, state, decided_by,"
            "                       decided_at, expires_at)"
            " VALUES (%s, %s, %s, 'their-token', 'x', 100000, 'APPROVED',"
            "         'them@other.example', now(), now() + interval '1 day')",
            (other_org, action_id, shipment_id),
        )

    assert await gather_decisions(db) == []
