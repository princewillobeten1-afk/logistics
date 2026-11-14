"""Audit wrapper.

Every model call writes an agent_runs row — success or failure. That table is
the audit trail, the cost ledger, and the corpus the replay harness scores
against, so recording is not optional and not the handler's job to remember.
"""

from __future__ import annotations

import json
from typing import Any

from logistics.db import Database
from logistics.llm.base import LLMClient, LLMError, LLMRequest, LLMResponse
from logistics.obs import get_logger

log = get_logger(__name__)

_MAX_RECORDED_CHARS = 20_000


def _truncate(value: Any) -> Any:
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    if len(text) <= _MAX_RECORDED_CHARS:
        return value
    return text[:_MAX_RECORDED_CHARS] + f"… [{len(text) - _MAX_RECORDED_CHARS} chars truncated]"


class AuditedLLMClient(LLMClient):
    def __init__(self, inner: LLMClient, db: Database) -> None:
        self._inner = inner
        self._db = db
        self.default_max_attempts = inner.default_max_attempts

    async def complete(self, req: LLMRequest) -> LLMResponse:
        try:
            response = await self._inner.complete(req)
        except LLMError as exc:
            await self._record(req, None, status="ERROR", error=str(exc))
            raise
        await self._record(req, response, status="OK")
        return response

    async def _record(
        self,
        req: LLMRequest,
        response: LLMResponse | None,
        *,
        status: str,
        error: str | None = None,
    ) -> None:
        request_blob = {
            "messages": _truncate(req.wire_messages()),
            "tools": [t.get("function", {}).get("name") for t in (req.tools or [])],
            "schema": req.response_schema.__name__ if req.response_schema else None,
            "temperature": req.temperature,
        }
        response_blob = (
            {
                "text": _truncate(response.text),
                # The "why" behind the decision. Kept for the audit trail and
                # for the replay harness to score against.
                "reasoning": _truncate(response.reasoning) if response.reasoning else None,
                "tool_calls": [
                    {"name": c.name, "arguments": _truncate(c.arguments)}
                    for c in response.tool_calls
                ],
                "finish_reason": response.finish_reason,
                "truncated": response.truncated,
            }
            if response is not None
            else None
        )

        try:
            async with self._db.connection() as conn:
                await conn.execute(
                    """
                    INSERT INTO agent_runs (
                        shipment_id, work_item_id, agent, job, model, prompt_version,
                        request, response, prompt_tokens, completion_tokens,
                        latency_ms, status, error
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        req.shipment_id,
                        req.work_item_id,
                        req.agent,
                        str(req.job),
                        req.model,
                        req.prompt_version,
                        json.dumps(request_blob, default=str),
                        json.dumps(response_blob, default=str) if response_blob else None,
                        response.prompt_tokens if response else None,
                        response.completion_tokens if response else None,
                        response.latency_ms if response else None,
                        status,
                        error,
                    ),
                )
        except Exception as exc:  # noqa: BLE001
            # Losing an audit row must never fail the shipment. Loud, not fatal.
            log.error("agent_run.record_failed", error=str(exc), job=str(req.job))
