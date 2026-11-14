from __future__ import annotations

import asyncio
import time

import pytest
from pydantic import BaseModel, Field

from logistics.llm.base import InvalidOutput, extract_json
from logistics.llm.ratelimit import TokenBucket
from logistics.llm.registry import MODEL_ROUTES, Job, spec_for
from tests.conftest import Reply, ScriptedLLM


class Quote(BaseModel):
    carrier: str
    amount_minor: int = Field(ge=0)
    confidence: float = Field(ge=0, le=1)


# ------------------------------------------------------------------ parsing


def test_extract_plain_json():
    assert extract_json('{"a": 1}') == {"a": 1}


def test_extract_strips_reasoning_block():
    """Nemotron emits <think> blocks. That is not a schema miss."""
    text = "<think>Let me work through the rate...</think>\n{\"a\": 1}"
    assert extract_json(text) == {"a": 1}


def test_extract_from_code_fence():
    assert extract_json('Here you go:\n```json\n{"a": 1}\n```') == {"a": 1}


def test_extract_ignores_prose_around_json():
    assert extract_json('Sure! {"a": 1} Hope that helps.') == {"a": 1}


def test_extract_handles_nested_and_braces_in_strings():
    text = 'result: {"note": "cost is {high}", "inner": {"b": [1, 2]}}'
    assert extract_json(text) == {"note": "cost is {high}", "inner": {"b": [1, 2]}}


def test_extract_raises_when_absent():
    with pytest.raises(ValueError, match="no parseable JSON"):
        extract_json("no json at all")


# ----------------------------------------------------------- validated retry


async def test_structured_accepts_first_valid_reply():
    client = ScriptedLLM('{"carrier": "A", "amount_minor": 41000000, "confidence": 0.9}')
    result = await client.structured(_req(), Quote)
    assert result.value.carrier == "A"
    assert result.attempts == 1


async def test_structured_repairs_a_schema_miss():
    """The realistic open-weight failure: right shape, wrong types."""
    client = ScriptedLLM(
        '{"carrier": "A", "amount_minor": "four hundred k", "confidence": 0.9}',
        '{"carrier": "A", "amount_minor": 41000000, "confidence": 0.9}',
    )
    result = await client.structured(_req(), Quote)
    assert result.value.amount_minor == 41000000
    assert result.attempts == 2

    # The repair prompt must name the offending field, or the retry is a coin flip.
    repair = client.requests[1].messages[-1]["content"]
    assert "amount_minor" in repair


async def test_structured_gives_up_and_raises_invalid_output():
    client = ScriptedLLM("nonsense", "still nonsense", "nope")
    with pytest.raises(InvalidOutput) as excinfo:
        await client.structured(_req(), Quote, max_attempts=3)
    assert excinfo.value.attempts == 3
    assert len(client.requests) == 3


def _req():
    from logistics.llm.base import LLMRequest

    return LLMRequest(
        job=Job.CARRIER_REPLY_PARSING,
        messages=[{"role": "user", "content": "parse this"}],
    )


# -------------------------------------------------------------- rate limiter


async def test_bucket_allows_burst_then_throttles():
    bucket = TokenBucket(rate_per_minute=600, burst=3)  # 10/s
    started = time.monotonic()
    for _ in range(3):
        await bucket.acquire()
    assert time.monotonic() - started < 0.05, "burst capacity should not block"

    await bucket.acquire()
    assert time.monotonic() - started >= 0.08, "the 4th call must wait for a refill"


async def test_bucket_is_safe_under_concurrency():
    bucket = TokenBucket(rate_per_minute=1200, burst=2)
    await asyncio.gather(*(bucket.acquire() for _ in range(8)))


def test_bucket_rejects_impossible_request():
    with pytest.raises(ValueError, match="cannot acquire"):
        asyncio.run(TokenBucket(60, burst=2).acquire(5))


# -------------------------------------------------------- provider errors


class _Status(Exception):
    """Stands in for openai.APIStatusError, which needs a real httpx response
    to construct."""

    def __init__(self, status_code: int) -> None:
        super().__init__(f"status {status_code}")
        self.status_code = status_code
        self.message = f"status {status_code}"


async def _run_with_errors(monkeypatch, errors: list[Exception | None]):
    """Drive NvidiaClient.complete against a scripted sequence of outcomes."""
    from openai import APIStatusError

    from logistics.config import Settings
    from logistics.llm import nvidia as nvidia_mod
    from logistics.llm.base import LLMRequest

    monkeypatch.setattr(nvidia_mod, "APIStatusError", _Status)
    assert APIStatusError is not _Status  # the real one still exists

    # Capture the real sleep before patching, or the replacement calls itself.
    # The backoff is seconds long by design; a test should not wait it out.
    real_sleep = asyncio.sleep
    monkeypatch.setattr(asyncio, "sleep", lambda _s: real_sleep(0))

    client = nvidia_mod.NvidiaClient(
        Settings(nvidia_api_key="x" * 20, llm_max_attempts=4)
    )
    calls = {"n": 0}

    async def fake_create(**_kw):
        outcome = errors[calls["n"]]
        calls["n"] += 1
        if outcome is not None:
            raise outcome

        class _Msg:
            content = '{"ok": true}'
            reasoning_content = None
            tool_calls = None

        class _Choice:
            message = _Msg()
            finish_reason = "stop"

        class _Completion:
            choices = [_Choice()]
            usage = None
            model = "test"

        return _Completion()

    monkeypatch.setattr(
        client._client.chat.completions, "create", fake_create
    )
    result = await client.complete(
        LLMRequest(job=Job.CUSTOMER_CHAT, messages=[{"role": "user", "content": "x"}])
    )
    return result, calls["n"]


async def test_a_503_is_retried_not_surfaced(monkeypatch):
    """The hosted tier returns 503 "Service temporarily overloaded" under
    ordinary congestion. Treating that as permanent turned a busy minute at
    NVIDIA into a DEAD work item needing a human — which is what happened."""
    _, attempts = await _run_with_errors(
        monkeypatch, [_Status(503), _Status(503), None]
    )
    assert attempts == 3, "it must keep trying while the provider is overloaded"


async def test_a_500_is_retried(monkeypatch):
    _, attempts = await _run_with_errors(monkeypatch, [_Status(500), None])
    assert attempts == 2


async def test_a_400_is_not_retried(monkeypatch):
    """A malformed schema or a bad model id fails the same way every time.
    Retrying burns quota and delays the error reaching someone who can fix it."""
    from logistics.llm.base import ProviderError

    with pytest.raises(ProviderError, match="400"):
        await _run_with_errors(monkeypatch, [_Status(400), None])


async def test_a_404_is_not_retried(monkeypatch):
    from logistics.llm.base import ProviderError

    with pytest.raises(ProviderError, match="404"):
        await _run_with_errors(monkeypatch, [_Status(404), None])


async def test_a_persistent_outage_still_gives_up(monkeypatch):
    """Retrying is not the same as hanging. Four attempts, then it surfaces."""
    from logistics.llm.base import ProviderError

    with pytest.raises(ProviderError, match="503"):
        await _run_with_errors(monkeypatch, [_Status(503)] * 4)


# ---------------------------------------------------------------- registry


def test_every_job_routes_to_a_model():
    for job in Job:
        assert spec_for(job).model.startswith("nvidia/")


def test_extraction_and_parsing_are_deterministic():
    """Anything feeding a typed schema runs at temperature 0."""
    for job in (Job.ORDER_EXTRACTION, Job.CARRIER_REPLY_PARSING, Job.SAFETY_SCREEN):
        assert MODEL_ROUTES[job].temperature == 0.0


def test_cheap_model_handles_the_high_volume_jobs():
    """Customer chat runs with thinking disabled; analytics runs with thinking enabled."""
    assert MODEL_ROUTES[Job.CUSTOMER_CHAT].model == "nvidia/nemotron-3.5-super-vl-120b-a12b"
    assert MODEL_ROUTES[Job.CUSTOMER_CHAT].reasoning is False
    assert MODEL_ROUTES[Job.ANALYTICS].model == "nvidia/nemotron-3.5-super-vl-120b-a12b"
    assert MODEL_ROUTES[Job.ANALYTICS].reasoning is True


# ----------------------------------------------------------- reasoning mode


def test_mechanical_jobs_do_not_reason():
    """Thinking costs latency and tokens; these jobs gain nothing from it."""
    for job in (
        Job.CARRIER_REPLY_PARSING,
        Job.CUSTOMER_CHAT,
        Job.CUSTOMER_NOTIFICATION,
        Job.SAFETY_SCREEN,
        Job.DOCUMENT_PARSE,
    ):
        assert MODEL_ROUTES[job].reasoning is False, f"{job} should not reason"


def test_judgment_jobs_reason():
    for job in (
        Job.ORDER_EXTRACTION,
        Job.EXCEPTION_REASONING,
        Job.EXCEPTION_ESCALATION,
        Job.ANALYTICS,
    ):
        assert MODEL_ROUTES[job].reasoning is True, f"{job} should reason"


async def test_reasoning_is_captured_separately_from_the_answer():
    client = ScriptedLLM(
        Reply(
            text='{"carrier": "A", "amount_minor": 41000000, "confidence": 0.9}',
            reasoning="Carrier A is cheaper but B is more reliable...",
        )
    )
    result = await client.structured(_req(), Quote)
    assert result.value.carrier == "A"
    assert "more reliable" in result.response.reasoning


def test_truncated_is_driven_by_finish_reason():
    from logistics.llm.base import LLMResponse

    assert LLMResponse(text="x", model="m", finish_reason="length").truncated is True
    assert LLMResponse(text="x", model="m", finish_reason="stop").truncated is False
    assert LLMResponse(text="x", model="m").truncated is False


async def test_truncated_reply_gets_a_brevity_repair_not_a_schema_dump():
    """Re-prompting a cut-off response with the generic text just truncates
    again. This is the observed max_tokens=16 monologue leak."""
    client = ScriptedLLM(
        Reply(text="The user asks: I need to work out the rate, so", finish_reason="length"),
        '{"carrier": "A", "amount_minor": 41000000, "confidence": 0.9}',
    )
    result = await client.structured(_req(), Quote)

    assert result.attempts == 2
    repair = client.requests[1].messages[-1]["content"]
    assert "cut off" in repair
    assert "concisely" in repair
