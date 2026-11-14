"""NVIDIA NIM client.

The endpoint is OpenAI-compatible, so this is the `openai` SDK with a different
base_url. Swapping to self-hosted Nemotron on vLLM before phase 5 means
changing NVIDIA_BASE_URL and nothing else.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from openai import APIConnectionError, APIStatusError, AsyncOpenAI, RateLimitError

from logistics.config import Settings, get_settings
from logistics.llm.base import LLMClient, LLMRequest, LLMResponse, ProviderError, ToolCall
from logistics.llm.ratelimit import TokenBucket
from logistics.obs import get_logger

log = get_logger(__name__)

_TRANSIENT = (APIConnectionError, RateLimitError, asyncio.TimeoutError)


class NvidiaClient(LLMClient):
    def __init__(
        self,
        settings: Settings | None = None,
        *,
        bucket: TokenBucket | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        if not self._settings.nvidia_api_key:
            raise ProviderError(
                "NVIDIA_API_KEY is not set. Put it in .env or the environment — "
                "never in source."
            )
        self._client = AsyncOpenAI(
            base_url=self._settings.nvidia_base_url,
            api_key=self._settings.nvidia_api_key.get_secret_value(),
            timeout=self._settings.llm_timeout_s,
            max_retries=0,  # retried here, so the wait is inside the bucket
        )
        self._bucket = bucket or TokenBucket(self._settings.llm_max_rpm)
        self._sem = asyncio.Semaphore(self._settings.llm_max_concurrency)
        self.default_max_attempts = self._settings.llm_max_attempts

    async def aclose(self) -> None:
        await self._client.close()

    def _payload(self, req: LLMRequest) -> dict[str, Any]:
        spec = req.spec
        payload: dict[str, Any] = {
            "model": req.model,
            "messages": req.wire_messages(),
            "max_tokens": req.max_tokens or spec.max_tokens,
            "temperature": req.temperature if req.temperature is not None else spec.temperature,
            "top_p": spec.top_p,
        }
        # Nemotron 3.5 Super VL reasons into a separate `reasoning_content`
        # field controlled by `chat_template_kwargs: {"enable_thinking": ...}`.
        payload["extra_body"] = {
            "chat_template_kwargs": {"enable_thinking": spec.reasoning}
        }

        if req.tools and spec.supports_tools:
            payload["tools"] = req.tools
            payload["parallel_tool_calls"] = True
        if req.response_schema is not None and spec.supports_json_schema:
            # Guided decoding. When the model ignores it, base.structured()
            # still catches the miss and re-prompts.
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": req.response_schema.__name__,
                    "schema": req.response_schema.model_json_schema(),
                    "strict": True,
                },
            }
        return payload

    async def complete(self, req: LLMRequest) -> LLMResponse:
        payload = self._payload(req)
        attempts = self._settings.llm_max_attempts
        delay = 1.0

        for attempt in range(1, attempts + 1):
            await self._bucket.acquire()
            started = time.monotonic()
            try:
                async with self._sem:
                    completion = await self._client.chat.completions.create(**payload)
            except _TRANSIENT as exc:
                if attempt == attempts:
                    raise ProviderError(f"{type(exc).__name__} after {attempts} attempts") from exc
                log.warning(
                    "llm.transient", job=str(req.job), attempt=attempt, error=str(exc)
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)
                continue
            except APIStatusError as exc:
                # 5xx is the provider's problem, not ours, and the hosted tier
                # returns 503 "Service temporarily overloaded" under ordinary
                # congestion. Treating that as permanent meant a busy minute at
                # NVIDIA surfaced as a DEAD work item needing a human — the
                # retry loop below exists for exactly this.
                if exc.status_code >= 500 and attempt < attempts:
                    log.warning(
                        "llm.provider_unavailable",
                        job=str(req.job), attempt=attempt, status=exc.status_code,
                    )
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 30.0)
                    continue

                # 4xx other than rate limiting is our bug — a bad model id, a
                # malformed schema. Retrying cannot help.
                raise ProviderError(f"{exc.status_code} from {req.model}: {exc.message}") from exc

            latency_ms = int((time.monotonic() - started) * 1000)
            response = self._to_response(completion, req, latency_ms)

            if response.truncated:
                # Almost always a max_tokens set too low for the job. Loud,
                # because a truncated reasoning model can spill its monologue
                # into the answer.
                log.warning(
                    "llm.truncated",
                    job=str(req.job),
                    model=response.model,
                    max_tokens=payload["max_tokens"],
                    reasoning=req.spec.reasoning,
                )
            return response

        raise ProviderError("unreachable")  # pragma: no cover

    @staticmethod
    def _to_response(completion: Any, req: LLMRequest, latency_ms: int) -> LLMResponse:
        choice = completion.choices[0] if completion.choices else None
        message = getattr(choice, "message", None)

        tool_calls: list[ToolCall] = []
        for call in getattr(message, "tool_calls", None) or []:
            raw_args = getattr(call.function, "arguments", "") or "{}"
            try:
                args = json.loads(raw_args)
            except json.JSONDecodeError:
                # Malformed tool arguments are an expected open-weight failure.
                # Surface them rather than crashing; the handler decides.
                args = {"__unparsed__": raw_args}
            tool_calls.append(
                ToolCall(id=call.id, name=call.function.name, arguments=args)
            )

        usage = getattr(completion, "usage", None)
        return LLMResponse(
            text=(getattr(message, "content", None) or ""),
            model=getattr(completion, "model", req.model),
            tool_calls=tuple(tool_calls),
            prompt_tokens=getattr(usage, "prompt_tokens", None),
            completion_tokens=getattr(usage, "completion_tokens", None),
            latency_ms=latency_ms,
            finish_reason=getattr(choice, "finish_reason", None),
            reasoning=getattr(message, "reasoning_content", None),
        )
