"""Model routing.

All model jobs route to `nvidia/nemotron-3.5-super-vl-120b-a12b` (120B total /
12B active MoE vision-language model on NVIDIA NIM), with per-job controls for
thinking (`enable_thinking`), `temperature`, `top_p`, and `max_tokens`.

Model id verified against https://integrate.api.nvidia.com/v1.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Final


class Job(StrEnum):
    """What the model is being asked to do. Handlers name a Job, never a model —
    so re-routing a job to a different model is a one-line change here."""

    ORDER_EXTRACTION = "order_extraction"
    EXCEPTION_REASONING = "exception_reasoning"
    EXCEPTION_ESCALATION = "exception_escalation"
    CARRIER_REPLY_PARSING = "carrier_reply_parsing"
    CUSTOMER_CHAT = "customer_chat"
    CUSTOMER_NOTIFICATION = "customer_notification"
    OPERATOR_ASSIST = "operator_assist"
    SAFETY_SCREEN = "safety_screen"
    DOCUMENT_PARSE = "document_parse"
    ANALYTICS = "analytics"
    ROUTE_OPTIMIZATION = "route_optimization"


@dataclass(frozen=True, slots=True)
class ModelSpec:
    model: str
    max_tokens: int = 2048
    temperature: float = 0.2
    top_p: float = 0.95
    supports_tools: bool = True
    supports_json_schema: bool = True
    reasoning: bool = True
    """Nemotron 3.5 Super VL thinks into a separate `reasoning_content` field
    controlled via `extra_body={"chat_template_kwargs": {"enable_thinking": ...}}`.

    Turn it off for mechanical or interactive work. Leave it on where the model
    is making a judgment and the reasoning is worth auditing.
    """
    note: str = ""


DEFAULT_MODEL: Final = "nvidia/nemotron-3.5-super-vl-120b-a12b"
_SUPER: Final = DEFAULT_MODEL
_NANO: Final = DEFAULT_MODEL
_ULTRA: Final = DEFAULT_MODEL
_SAFETY: Final = DEFAULT_MODEL
_PARSE: Final = DEFAULT_MODEL


MODEL_ROUTES: Final[dict[Job, ModelSpec]] = {
    # 1M context swallows a forwarded email thread whole; RL-trained on
    # structured output, which is exactly what extraction needs.
    # Reasoning stays ON: judging whether an address is deliverable is the
    # highest-value call in phase 2, and ~500–5,000/day is not the hot loop.
    Job.ORDER_EXTRACTION: ModelSpec(
        model=_SUPER, max_tokens=4096, temperature=0.0, reasoning=True,
        note="Deterministic extraction — temperature pinned to 0.",
    ),
    Job.EXCEPTION_REASONING: ModelSpec(
        model=_SUPER, max_tokens=16384, temperature=0.3, reasoning=True,
        note="Multi-step tool use and exception investigation.",
    ),
    Job.EXCEPTION_ESCALATION: ModelSpec(
        model=_ULTRA, max_tokens=16384, temperature=0.3, reasoning=True,
        note="Deep reasoning pass for escalated exceptions.",
    ),
    # Mechanical: slang → typed Quote. Thinking buys nothing and costs latency.
    Job.CARRIER_REPLY_PARSING: ModelSpec(
        model=_SUPER, max_tokens=1024, temperature=0.0, reasoning=False,
        note="Free-text pricing in slang into a typed, confidence-scored Quote.",
    ),
    # Fast customer responses: thinking disabled for low latency.
    Job.CUSTOMER_CHAT: ModelSpec(
        model=_NANO, max_tokens=1024, temperature=0.4, reasoning=False,
    ),
    Job.CUSTOMER_NOTIFICATION: ModelSpec(
        model=_NANO, max_tokens=512, temperature=0.4, reasoning=False,
    ),
    # Interactive operator panel: reasoning stays OFF so responses return fast.
    Job.OPERATOR_ASSIST: ModelSpec(
        model=_SUPER, max_tokens=1024, temperature=0.3, reasoning=False,
        note="Interactive: latency is the binding constraint, not depth.",
    ),
    Job.SAFETY_SCREEN: ModelSpec(
        model=_SAFETY, max_tokens=256, temperature=0.0,
        supports_tools=False, reasoning=False,
        note="Guardrail pass over inbound untrusted text. Third layer — never the only one.",
    ),
    Job.DOCUMENT_PARSE: ModelSpec(
        model=_PARSE, max_tokens=4096, temperature=0.0,
        supports_tools=False, supports_json_schema=False, reasoning=False,
        note="Vision-language input for POD and waybill parsing.",
    ),
    Job.ANALYTICS: ModelSpec(
        model=_ULTRA, max_tokens=16384, temperature=0.4, reasoning=True,
    ),
    Job.ROUTE_OPTIMIZATION: ModelSpec(
        model=_SUPER, max_tokens=4096, temperature=0.0, reasoning=True,
        note="Route waypoint selection, corridor risk analysis, and dispatch advisory.",
    ),
}


def spec_for(job: Job) -> ModelSpec:
    try:
        return MODEL_ROUTES[job]
    except KeyError:  # pragma: no cover - guards a typo'd Job at call sites
        raise ValueError(f"No model route registered for job {job!r}") from None
