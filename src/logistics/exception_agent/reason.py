"""The reasoning step.

One structured call on `EXCEPTION_REASONING` (Super — reinforcement-trained on
multi-step reasoning), escalating to `EXCEPTION_ESCALATION` (Ultra) when the
first pass is not confident. This is the one place a bigger, slower, dearer
model is worth it: it runs a few hundred times a day, not a million, and the
decisions it informs cost real money.

The model produces *candidate* resolutions with reasoning. It selects nothing
and executes nothing — `resolve.py` maps candidates to work and the policy gate
decides which may proceed.
"""

from __future__ import annotations

from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from logistics.exception_agent.gather import CaseFile
from logistics.llm.base import InvalidOutput, LLMClient, LLMRequest
from logistics.llm.registry import Job
from logistics.obs import get_logger

log = get_logger(__name__)

PROMPT_VERSION = "exception.investigate/v1"

# Below this the first pass is not trusted and the case goes to Ultra.
ESCALATE_BELOW = 0.65


class ResolutionKind(StrEnum):
    RESOURCE_CARRIER = "RESOURCE_CARRIER"
    """Go back to sourcing and find someone else."""

    EXPEDITE = "EXPEDITE"
    """Pay more with the current carrier for a faster service."""

    ACCEPT_DELAY = "ACCEPT_DELAY"
    """Nothing useful can be done; tell the customer honestly."""

    NOTIFY_CUSTOMER = "NOTIFY_CUSTOMER"
    """The customer does not know yet and should."""

    ESCALATE = "ESCALATE"
    """Needs a person — commercially sensitive, or outside what the agent can judge."""

    NO_ACTION = "NO_ACTION"
    """The condition has already cleared."""


class Resolution(BaseModel):
    kind: ResolutionKind
    rationale: str = Field(min_length=1, description="Why this, in one or two sentences")
    expected_outcome: str | None = None
    estimated_cost_minor: int | None = Field(
        default=None,
        ge=0,
        description="Extra cost in minor units, if this option costs more",
    )
    carrier_code: str | None = Field(
        default=None, description="Required for RESOURCE_CARRIER"
    )

    @model_validator(mode="after")
    def _has_what_its_kind_needs(self) -> Resolution:
        if self.kind is ResolutionKind.RESOURCE_CARRIER and not self.carrier_code:
            raise ValueError(
                "RESOURCE_CARRIER needs a carrier_code from the alternatives listed. "
                "If none is suitable, use ESCALATE instead."
            )
        return self


class Investigation(BaseModel):
    cause: str = Field(min_length=1, description="What actually went wrong")
    impact: str = Field(min_length=1, description="What it means for the delivery")
    severity: str = Field(description="LOW | MEDIUM | HIGH | CRITICAL")
    deadline_at_risk: bool
    resolutions: list[Resolution] = Field(
        min_length=1, description="Ranked best first"
    )
    customer_message: str | None = Field(
        default=None, description="What to tell the customer, if anything"
    )
    confidence: float = Field(ge=0.0, le=1.0)

    @property
    def recommended(self) -> Resolution:
        return self.resolutions[0]


SYSTEM = """You are the exception manager for a Nigerian logistics operator. A \
shipment is in trouble and you decide what should be done about it.

You are given a case file assembled from live data: what the detection engine \
found, where the shipment is, how much slack is left against the promised \
delivery, and which other carriers are available. Everything in it is fact.

Your job:

1. Say what actually went wrong — the cause, not the symptom. "Running 90 \
minutes late" is a symptom; "held up in Lagos traffic on a route with no \
slack" is a cause.
2. Say what it means for the delivery.
3. Give ranked options, best first. Be concrete. If re-sourcing, name a \
carrier from the alternatives given — never one that is not listed.
4. If the customer has not been told and should be, write the message.

Judgement to apply:

- **A cheaper option that misses the deadline is not cheaper.** A breached SLA \
costs more than an expedite fee.
- **Do not re-source for a small delay.** Changing carrier mid-shipment has its \
own risk and cost; it is for real failures, not for ninety minutes.
- **If nothing useful can be done, say so.** ACCEPT_DELAY with an honest \
customer message is a real answer and often the right one.
- **Escalate when it is genuinely a commercial call** — a major cost increase, \
a key account, a contractual breach. You are not being judged on autonomy.

You are recommending, not acting. Every option you give is reviewed against \
spending policy before anything happens, and expensive ones go to a human. So \
recommend what is actually best rather than what you think will be approved.

Return JSON only. No prose outside it, no code fences."""


async def investigate(
    llm: LLMClient,
    case: CaseFile,
    *,
    shipment_id: UUID | None = None,
    work_item_id: UUID | None = None,
    allow_escalation: bool = True,
) -> Investigation | None:
    """Work out what to do. Returns None when the model could not produce a
    usable answer, which the caller turns into a human escalation."""
    request = LLMRequest(
        job=Job.EXCEPTION_REASONING,
        system=SYSTEM,
        messages=[{"role": "user", "content": f"Case file:\n\n{case.as_prompt()}"}],
        agent="exception",
        shipment_id=shipment_id,
        work_item_id=work_item_id,
        prompt_version=PROMPT_VERSION,
    )

    try:
        result = await llm.structured(request, Investigation)
    except InvalidOutput as exc:
        log.warning("exception.unreadable", attempts=exc.attempts)
        return None

    if result.response.truncated:
        # The model hit its token budget mid-answer. `support/decide.py` has
        # guarded against this since it was written; this path did not, and it
        # is the one that decides whether to spend money.
        #
        # The danger is not a parse failure — that would raise. It is an answer
        # that parses and is wrong: a `resolutions` list cut short, so the
        # recommendation is whichever option the model happened to write first
        # rather than the one it ranked highest. Returning None sends the case
        # to a human, which is the correct outcome for an answer we cannot
        # trust and cheaper than the alternative.
        log.warning(
            "exception.truncated",
            reference=case.reference,
            recommended=str(result.value.recommended.kind),
        )
        return None

    investigation = result.value

    if investigation.confidence >= ESCALATE_BELOW or not allow_escalation:
        return investigation

    # Not confident. This is the case worth a slower, larger model — a few
    # hundred a day, informing decisions that cost money.
    log.info(
        "exception.escalating_to_ultra", confidence=round(investigation.confidence, 2)
    )
    try:
        second = await llm.structured(
            LLMRequest(
                job=Job.EXCEPTION_ESCALATION,
                system=SYSTEM,
                messages=[
                    {
                        "role": "user",
                        "content": (
                            f"Case file:\n\n{case.as_prompt()}\n\n"
                            "A first assessment was not confident:\n"
                            f"  cause: {investigation.cause}\n"
                            f"  recommended: {investigation.recommended.kind}\n"
                            "Reassess it properly."
                        ),
                    }
                ],
                agent="exception",
                shipment_id=shipment_id,
                work_item_id=work_item_id,
                prompt_version=PROMPT_VERSION,
            ),
            Investigation,
        )
    except InvalidOutput:
        # The first pass was at least readable; keep it rather than losing both.
        return investigation

    return second.value
