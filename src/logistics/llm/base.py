"""Provider-neutral model interface.

Handlers depend on this, never on the OpenAI client or NVIDIA directly. That
indirection is not decoration: the hosted NIM tier is not licensed for
production, so the endpoint will move to self-hosted vLLM. Because both speak
the same wire format, that move is a base_url change — but only if nothing
imported the vendor client.
"""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, replace
from typing import Any, Generic, TypeVar
from uuid import UUID

from pydantic import BaseModel, ValidationError

from logistics.llm.registry import Job, ModelSpec, spec_for

T = TypeVar("T", bound=BaseModel)


class LLMError(Exception):
    """Any model-layer failure."""


class InvalidOutput(LLMError):
    """The model produced output that would not validate after every retry.

    Expected, not exceptional. Open-weight models miss schemas; the caller is
    supposed to catch this and route the item to a human queue.
    """

    def __init__(self, message: str, *, attempts: int, last_text: str = "") -> None:
        super().__init__(message)
        self.attempts = attempts
        self.last_text = last_text


class ProviderError(LLMError):
    """Transport, auth, or upstream failure."""


@dataclass(frozen=True, slots=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True, slots=True)
class LLMRequest:
    job: Job
    messages: list[dict[str, Any]] = field(default_factory=list)
    system: str | None = None
    tools: list[dict[str, Any]] | None = None
    response_schema: type[BaseModel] | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    model_override: str | None = None

    # Audit context — carried through to the agent_runs row.
    agent: str = "unknown"
    shipment_id: UUID | None = None
    work_item_id: UUID | None = None
    prompt_version: str | None = None

    @property
    def spec(self) -> ModelSpec:
        return spec_for(self.job)

    @property
    def model(self) -> str:
        return self.model_override or self.spec.model

    def wire_messages(self) -> list[dict[str, Any]]:
        if self.system:
            return [{"role": "system", "content": self.system}, *self.messages]
        return list(self.messages)


@dataclass(frozen=True, slots=True)
class LLMResponse:
    text: str
    model: str
    tool_calls: tuple[ToolCall, ...] = ()
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    latency_ms: int = 0
    finish_reason: str | None = None
    reasoning: str | None = None
    """Nemotron 3's chain of thought, returned separately from the answer.

    Worth keeping: it is the "why" behind an agent's decision and belongs in the
    audit trail. It is NOT customer-safe text — see `truncated`.
    """
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def truncated(self) -> bool:
        """The model hit max_tokens before finishing.

        Treat `text` as unusable when true. A reasoning model cut off mid-thought
        can spill its raw monologue into `content` — observed at max_tokens=16,
        where a "reply with one word" prompt returned the model's internal
        deliberation. On a customer-facing path that reaches a customer.
        """
        return self.finish_reason == "length"


@dataclass(frozen=True, slots=True)
class Structured(Generic[T]):
    value: T
    response: LLMResponse
    attempts: int


# --------------------------------------------------------------------------
# Output cleaning.
#
# Reasoning models emit <think> blocks; instruction-tuned models fence JSON or
# preface it with prose. None of that is an error worth a retry — strip it and
# parse what is actually there.
# --------------------------------------------------------------------------

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def _balanced_span(text: str) -> str | None:
    """Return the first balanced {...} or [...] region, ignoring braces inside
    strings. Cheaper and far more reliable than a regex for nested JSON."""
    starts = {"{": "}", "[": "]"}
    for i, ch in enumerate(text):
        if ch not in starts:
            continue
        closer = starts[ch]
        depth = 0
        in_str = False
        escaped = False
        for j in range(i, len(text)):
            c = text[j]
            if in_str:
                if escaped:
                    escaped = False
                elif c == "\\":
                    escaped = True
                elif c == '"':
                    in_str = False
                continue
            if c == '"':
                in_str = True
            elif c == ch:
                depth += 1
            elif c == closer:
                depth -= 1
                if depth == 0:
                    return text[i : j + 1]
        return None
    return None


def extract_json(text: str) -> Any:
    """Pull a JSON value out of a model response. Raises ValueError if absent."""
    cleaned = _THINK_RE.sub("", text or "").strip()

    candidates: list[str] = []
    if fenced := _FENCE_RE.search(cleaned):
        candidates.append(fenced.group(1).strip())
    candidates.append(cleaned)
    if span := _balanced_span(cleaned):
        candidates.append(span)

    for candidate in candidates:
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    raise ValueError("no parseable JSON in model output")


def _repair_prompt(
    error: Exception, schema: type[BaseModel], *, truncated: bool = False
) -> str:
    if truncated:
        # Re-prompting a truncated response with the generic repair text just
        # truncates again. Ask for brevity instead.
        return (
            "Your previous response was cut off before it finished, so it could "
            "not be parsed. Answer again, much more concisely, and return ONLY "
            "a JSON object matching this schema — omit any explanation.\n\n"
            f"{json.dumps(schema.model_json_schema(), indent=2)}"
        )

    if isinstance(error, ValidationError):
        problems = "\n".join(
            f"  - {'.'.join(str(p) for p in e['loc']) or '(root)'}: {e['msg']}"
            for e in error.errors()[:10]
        )
        detail = f"These fields failed validation:\n{problems}"
    else:
        detail = f"The response was not valid JSON: {error}"

    return (
        f"{detail}\n\n"
        "Return ONLY a JSON object matching this schema. No prose, no code fences, "
        "no explanation before or after.\n\n"
        f"{json.dumps(schema.model_json_schema(), indent=2)}"
    )


class LLMClient(ABC):
    """Base for every model client. Subclasses implement `complete`; the
    validated-retry loop in `structured` is shared and is where open-weight
    schema misses get absorbed."""

    default_max_attempts: int = 3

    @abstractmethod
    async def complete(self, req: LLMRequest) -> LLMResponse: ...

    async def structured(
        self,
        req: LLMRequest,
        schema: type[T],
        *,
        max_attempts: int | None = None,
    ) -> Structured[T]:
        """Call the model and validate against `schema`, re-prompting with the
        specific validation errors on failure.

        Raises InvalidOutput once the attempt budget is spent — the caller
        routes that to a human, the same path an unparseable carrier quote takes.
        """
        attempts = max_attempts or self.default_max_attempts
        current = replace(req, response_schema=schema)
        last_text = ""
        last_error: Exception | None = None

        for attempt in range(1, attempts + 1):
            response = await self.complete(current)
            last_text = response.text
            try:
                return Structured(
                    value=schema.model_validate(extract_json(response.text)),
                    response=response,
                    attempts=attempt,
                )
            except (ValueError, ValidationError) as exc:
                last_error = exc
                if attempt == attempts:
                    break
                current = replace(
                    current,
                    messages=[
                        *current.messages,
                        {"role": "assistant", "content": response.text},
                        {
                            "role": "user",
                            "content": _repair_prompt(
                                exc, schema, truncated=response.truncated
                            ),
                        },
                    ],
                )

        raise InvalidOutput(
            f"{schema.__name__} did not validate after {attempts} attempts: {last_error}",
            attempts=attempts,
            last_text=last_text,
        )
