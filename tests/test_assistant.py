"""The shipment assistant and the operator's view.

Two things being pinned. First that `OperatorView` shows what `CustomerView`
deliberately hides — they are opposite by design, and a change that quietly
made them the same would be a leak in one direction or a useless panel in the
other. Second that the assistant cannot claim to have acted.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from logistics.domain.states import ShipmentState
from logistics.support.assist import Answer, answer_question
from logistics.support.operator import OperatorView, QuoteLine, build_operator_view
from logistics.support.view import build_view
from tests.conftest import ScriptedLLM

S = ShipmentState


def _answer(**kw) -> str:
    base = {
        "answer": "It is held at Lokoja; the carrier has not replied since Tuesday.",
        "confidence": 0.8,
        "suggested_next_step": "Call the carrier, or re-source with T-PREMIUM.",
        "grounded": True,
    }
    return json.dumps({**base, **kw})


# ------------------------------------------------- the assistant cannot act


@pytest.mark.parametrize(
    "claim",
    [
        "I have booked T-PREMIUM for you.",
        "I've rebooked this with the premium carrier.",
        "I have notified the customer about the delay.",
        "I'll send them an update now.",
        "I have cancelled the original booking.",
    ],
)
def test_the_assistant_cannot_claim_to_have_done_something(claim: str):
    """It has no tools. An operator who reads "I've rebooked with T-PREMIUM"
    and moves on has been actively misled — worse than a refusal, and much
    harder to notice than a wrong fact."""
    with pytest.raises(ValidationError, match="cannot act"):
        Answer(answer=claim, confidence=0.9)


def test_describing_what_the_operator_should_do_is_fine():
    """The line is between reporting an action and recommending one."""
    ok = Answer(
        answer="You could rebook with T-PREMIUM; they quoted 11 hours transit.",
        confidence=0.8,
        suggested_next_step="Rebook with T-PREMIUM",
    )
    assert "rebook" in ok.answer.lower()


def test_the_third_person_is_not_caught():
    """The guard must not fire on the system having done something, only on
    the assistant claiming it did."""
    Answer(
        answer="The carrier agent booked T-SOLID at 14:02 and the customer was "
               "notified an hour later.",
        confidence=0.9,
    )


async def test_a_confident_answer_comes_back(db):
    llm = ScriptedLLM(_answer())
    view = OperatorView(reference="SHP-1", state="EXCEPTION")
    result = await answer_question(llm, view, "why is this delayed?")

    assert result is not None
    assert "Lokoja" in result.answer
    assert len(llm.requests) == 1, "one call per question; this is interactive"


async def test_an_unreadable_answer_returns_nothing(db):
    """Better an honest "I could not answer" than a fabricated explanation of
    a shipment someone is about to act on."""
    llm = ScriptedLLM("garbage", "still garbage", "nope")
    view = OperatorView(reference="SHP-1", state="EXCEPTION")
    assert await answer_question(llm, view, "why?") is None


async def test_the_question_and_the_case_notes_both_reach_the_model(db):
    llm = ScriptedLLM(_answer())
    view = OperatorView(
        reference="SHP-9", state="EXCEPTION",
        quotes=[QuoteLine("T-PREMIUM", "RECEIVED", 45_000_00, "NGN", 11.0, 0.82)],
    )
    await answer_question(llm, view, "what are the options?")

    prompt = llm.requests[0].messages[-1]["content"]
    assert "SHP-9" in prompt
    assert "what are the options?" in prompt
    assert "T-PREMIUM" in prompt


async def test_earlier_turns_are_included_but_bounded(db):
    """An operator's chat is a working aid, not a transcript. A long tail of it
    crowds out the case notes it is supposed to be reasoning over."""
    llm = ScriptedLLM(_answer())
    history = [("user", f"question {i}") for i in range(20)]
    await answer_question(
        llm, OperatorView(reference="X", state="DRAFT"), "and now?", history
    )

    sent = " ".join(m["content"] for m in llm.requests[0].messages)
    assert "question 19" in sent
    assert "question 0" not in sent


async def test_the_model_is_told_it_is_not_talking_to_a_customer(db):
    llm = ScriptedLLM(_answer())
    await answer_question(llm, OperatorView(reference="X", state="DRAFT"), "hi")
    assert "not to a customer" in llm.requests[0].system


# ------------------------------------------------------ the operator's view


async def test_the_operator_sees_what_the_customer_must_not(db, repo, reference):
    """The two views are opposite by design. This is the test that fails if
    someone widens `CustomerView` to serve operators — which would turn an
    allowlist into a redaction list, where forgetting to hide something leaks
    it rather than merely omitting it."""
    shipment = await repo.create(
        reference=reference, state=S.AWAITING_APPROVAL,
        origin={"city": "Lagos"}, destination={"city": "Abuja"},
    )
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO proposed_actions"
            " (shipment_id, action, params, tier, policy_decision, policy_reason, state)"
            " VALUES (%s, 'book_shipment', '{}'::jsonb, 3, 'REQUIRE_APPROVAL',"
            "         'cap is zero', 'PROPOSED')",
            (shipment.id,),
        )

    operator = await build_operator_view(db, reference)
    customer = await build_view(db, reference)

    assert operator is not None and customer is not None

    # The operator gets the real state and the gate's reasoning.
    assert operator.state == "AWAITING_APPROVAL"
    assert any(g["policy_decision"] == "REQUIRE_APPROVAL" for g in operator.gates)
    assert "cap is zero" in operator.as_prompt()

    # The customer is told the shipment has not left yet, and nothing about why.
    assert customer.status == "Arranging transport"
    assert "REQUIRE_APPROVAL" not in customer.as_prompt()
    assert "cap is zero" not in customer.as_prompt()


async def test_prices_reach_the_operator_and_not_the_customer(
    db, repo, reference, carriers
):
    from logistics.carriers.adapter import Quote, QuoteState
    from logistics.carriers.repo import QuoteRepo
    from logistics.domain.money import Money

    shipment = await repo.create(reference=reference, state=S.SOURCING)
    async with db.connection() as conn:
        cur = await conn.execute("SELECT id FROM carriers WHERE code = 'T-PREMIUM'")
        carrier_id = (await cur.fetchone())["id"]

    await QuoteRepo(db).record(
        shipment_id=shipment.id, round=1, source="API",
        quote=Quote(
            carrier_id=carrier_id, state=QuoteState.RECEIVED,
            price=Money(450_000_00, "NGN"), transit_hours=11.0,
        ),
    )

    operator = await build_operator_view(db, reference)
    customer = await build_view(db, reference)

    assert "450,000" in operator.as_prompt()
    assert "450,000" not in customer.as_prompt()
    assert "T-PREMIUM" not in customer.as_prompt(), "no carrier until it is booked"


async def test_stuck_work_is_visible_to_the_operator(db, repo, reference):
    """Usually the actual answer to "why is this stuck", and it appears nowhere
    in the customer view because a customer cannot act on it."""
    shipment = await repo.create(reference=reference, state=S.SOURCING)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO work_items (shipment_id, kind, payload, state, attempts,"
            "                        last_error)"
            " VALUES (%s, 'carrier.source', '{}'::jsonb, 'DEAD', 5,"
            "         'no adapter available')",
            (shipment.id,),
        )

    view = await build_operator_view(db, reference)
    assert any(w["state"] == "DEAD" for w in view.queued)
    assert "no adapter available" in view.as_prompt()


async def test_silence_towards_the_customer_is_stated_not_omitted(db, repo, reference):
    """"Has the customer been told" is one of the three questions this panel
    exists for, and an empty list renders as nothing at all unless it is said."""
    await repo.create(reference=reference, state=S.EXCEPTION)
    view = await build_operator_view(db, reference)
    assert "nobody has been told anything" in view.as_prompt()


async def test_a_missing_shipment_yields_nothing(db):
    assert await build_operator_view(db, "NOT-A-REFERENCE") is None


async def test_the_operator_view_is_tenant_scoped(db, other_org):
    """It reads widely by design, so the thing worth checking is that "widely"
    stops at the organisation boundary."""
    async with db.connection(privileged=True) as conn:
        await conn.execute(
            "INSERT INTO shipments (org_id, reference, state)"
            " VALUES (%s, 'THEIR-OPS-1', 'IN_TRANSIT')",
            (other_org,),
        )
    assert await build_operator_view(db, "THEIR-OPS-1") is None


# ------------------------------------------------------------ the handler


async def _ask(db, shipment_id, question: str, user_id=None):
    """Write a question and the empty answer row the handler will fill, the
    same way the dashboard's server action does."""
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO assistant_messages (shipment_id, user_id, role, body, state)"
            " VALUES (%s, %s, 'user', %s, 'DONE')",
            (shipment_id, user_id, question),
        )
        cur = await conn.execute(
            "INSERT INTO assistant_messages (shipment_id, user_id, role, state)"
            " VALUES (%s, %s, 'assistant', 'PENDING') RETURNING id",
            (shipment_id, user_id),
        )
        return (await cur.fetchone())["id"]


def _ctx(db, settings, payload, shipment, llm):  # noqa: ANN001
    from uuid import uuid4

    from logistics.domain.models import WorkItem
    from logistics.handlers.base import StepContext

    return StepContext(
        item=WorkItem(
            id=uuid4(), kind="shipment.assist", payload=payload,
            attempts=1, max_attempts=3, shipment_id=shipment.id,
        ),
        shipment=shipment, db=db, settings=settings, llm=llm,
    )


async def test_the_handler_writes_the_answer_back(db, settings, repo, reference):
    from logistics.handlers.assist import assist

    shipment = await repo.create(reference=reference, state=S.EXCEPTION)
    answer_id = await _ask(db, shipment.id, "why is this delayed?")

    llm = ScriptedLLM(_answer())
    await assist(_ctx(db, settings, {"message_id": str(answer_id)}, shipment, llm))

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT body, state, confidence, next_step FROM assistant_messages"
            " WHERE id = %s", (answer_id,)
        )
        row = await cur.fetchone()

    assert row["state"] == "DONE"
    assert "Lokoja" in row["body"]
    assert float(row["confidence"]) == 0.8
    assert row["next_step"]


async def test_the_handler_changes_nothing_about_the_shipment(
    db, settings, repo, reference
):
    """The assistant explains. An assistant that can move a shipment is a
    different and much more dangerous feature."""
    from logistics.handlers.assist import assist

    shipment = await repo.create(reference=reference, state=S.EXCEPTION)
    answer_id = await _ask(db, shipment.id, "should we rebook?")

    result = await assist(
        _ctx(db, settings, {"message_id": str(answer_id)}, shipment, ScriptedLLM(_answer()))
    )

    assert result.transition is None, "it must not move the shipment"
    assert not result.enqueue, "it must not schedule work"
    assert not result.events, "it does not even write to the shipment's history"

    after = await repo.get(shipment.id)
    assert after.state is S.EXCEPTION
    assert after.version == shipment.version


async def test_an_unusable_answer_is_shown_as_failed(db, settings, repo, reference):
    """Not left PENDING. A spinner that never resolves reads as a hang, and
    the operator waits instead of going to look at the panels themselves."""
    from logistics.handlers.assist import assist

    shipment = await repo.create(reference=reference, state=S.EXCEPTION)
    answer_id = await _ask(db, shipment.id, "why?")

    llm = ScriptedLLM("garbage", "still garbage", "nope")
    await assist(_ctx(db, settings, {"message_id": str(answer_id)}, shipment, llm))

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT body, state FROM assistant_messages WHERE id = %s", (answer_id,)
        )
        row = await cur.fetchone()

    assert row["state"] == "FAILED"
    assert row["body"], "it has to say something, or the panel shows an empty box"


async def test_the_handler_needs_a_message_to_answer(db, settings, repo, reference):
    from logistics.handlers.assist import assist
    from logistics.handlers.base import PermanentFailure

    shipment = await repo.create(reference=reference, state=S.DRAFT)
    with pytest.raises(PermanentFailure, match="message_id"):
        await assist(_ctx(db, settings, {}, shipment, ScriptedLLM(_answer())))


async def test_exceptions_carry_their_severity_into_the_notes(db, repo, reference):
    from logistics.exceptions import ExceptionRepo
    from logistics.tracking.detection import Detection, DetectionKind, Severity

    shipment = await repo.create(
        reference=reference, state=S.EXCEPTION,
        deadline=datetime.now(UTC) + timedelta(hours=4),
    )
    await ExceptionRepo(db).raise_detection(
        shipment_id=shipment.id,
        detection=Detection(
            kind=DetectionKind.SLA_BREACH_RISK, severity=Severity.CRITICAL,
            summary="Will miss by three hours",
        ),
    )

    view = await build_operator_view(db, reference)
    assert "SLA_BREACH_RISK" in view.as_prompt()
    assert "CRITICAL" in view.as_prompt()
