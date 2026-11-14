"""The shipment assistant — answers an operator's question about one shipment.

Deliberately *not* built on `decide.py`. That module is shaped around a
customer conversation: it classifies into STATUS / NEW_ORDER / CHANGE_REQUEST,
extracts an `OrderDraft`, and hands intents to `delegate.py`. An operator
asking "why is this delayed" does not map onto any of that, and forcing it
through would mean an operator's question could produce a customer's shipment.

What this does instead is narrow and, in §19's terms, exactly what a model is
for: it reads the full internal picture and explains it in a sentence or two.
It has no tools. It cannot book, reroute, message anyone, or change state. The
worst outcome from a wrong answer here is a wrong answer — an operator reads
it, disagrees, and acts through the same gated paths as before.

That constraint is the design, not a limitation to be lifted later. An
assistant that answers questions is judged by whether it is useful. One that
also acts is judged by whether it is safe, which is a much harder bar and needs
the approval flow, not a chat box.
"""

from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from logistics.llm.base import InvalidOutput, LLMClient, LLMRequest
from logistics.llm.registry import Job
from logistics.obs import get_logger
from logistics.support.operator import OperatorView

log = get_logger(__name__)

PROMPT_VERSION = "support.assist/v1"

SYSTEM = """\
You are an operations assistant inside a logistics control tower. You are \
talking to a dispatcher or operations manager at the freight company — not to \
a customer. They can see everything you can see.

Answer their question about this shipment from the case notes below. Be \
direct and specific: name the carrier, the state, the actual delay, the actual \
number. An operator asking "why is this late" wants the cause, not a summary \
of the status field they are already looking at.

Rules:
- Use only what is in the case notes. If the notes do not say, say they do not \
say — never fill a gap with something plausible.
- Prices, scores and policy decisions are internal. You may discuss them \
freely here; this is not a customer conversation.
- You cannot do anything. You have no tools and take no actions. If the right \
next step is to rebook, reroute or message someone, say so and let the \
operator do it through the proper screen — do not imply you have done it or \
will do it.
- Two or three sentences unless genuinely more is needed. These people are \
busy and reading between other tasks.
"""

INSTRUCTIONS = """\
Return JSON only:

{
  "answer": "<your reply to the operator, 2-3 sentences>",
  "confidence": <0.0-1.0, how well the notes actually support your answer>,
  "suggested_next_step": "<one action an operator might take, or null>",
  "grounded": <true if the notes contain what you needed, false if you had to
               say the notes do not cover it>
}
"""


class Answer(BaseModel):
    answer: str = Field(min_length=1, max_length=2000)
    confidence: float = Field(ge=0.0, le=1.0)
    suggested_next_step: str | None = None
    grounded: bool = True

    @field_validator("answer")
    @classmethod
    def _not_a_promise(cls, v: str) -> str:
        """The model has no tools, so a reply claiming it acted is false.

        Caught here rather than trusted to the prompt: an operator who reads
        "I've rebooked with T-PREMIUM" and moves on has been actively misled,
        which is worse than a refusal and much harder to notice.
        """
        lowered = v.lower()
        claims = (
            "i have booked", "i've booked", "i have rebooked", "i've rebooked",
            "i have cancelled", "i've cancelled", "i have sent", "i've sent",
            "i have notified", "i've notified", "i have rerouted", "i've rerouted",
            "i have updated", "i've updated", "i will book", "i'll book",
            "i will send", "i'll send", "i will notify", "i'll notify",
            "i will reroute", "i'll reroute", "i have arranged", "i've arranged",
        )
        for claim in claims:
            if claim in lowered:
                raise ValueError(
                    f"the assistant cannot act, so it must not say {claim!r}; "
                    "describe what the operator should do instead"
                )
        return v


async def answer_question(
    llm: LLMClient,
    view: OperatorView,
    question: str,
    history: list[tuple[str, str]] | None = None,
    *,
    shipment_id: UUID | None = None,
    work_item_id: UUID | None = None,
) -> Answer | None:
    """One model call. Returns None when the model could not produce a usable
    answer after retries — the panel then says so rather than inventing one."""
    messages: list[dict[str, str]] = []
    if history:
        # Only the last few turns: an operator's chat is a working aid, not a
        # transcript, and a long tail of it crowds out the case notes it is
        # supposed to be reasoning over.
        messages += [
            {"role": "user" if role == "user" else "assistant", "content": text}
            for role, text in history[-6:]
        ]

    messages.append(
        {
            "role": "user",
            "content": (
                f"Case notes for {view.reference}:\n\n{view.as_prompt()}"
                f"\n\nOperator asks: {question}\n\n{INSTRUCTIONS}"
            ),
        }
    )

    try:
        result = await llm.structured(
            LLMRequest(
                job=Job.OPERATOR_ASSIST,
                system=SYSTEM,
                messages=messages,
                agent="assistant",
                shipment_id=shipment_id,
                work_item_id=work_item_id,
                prompt_version=PROMPT_VERSION,
            ),
            Answer,
        )
    except InvalidOutput as exc:
        log.warning(
            "assist.unreadable", reference=view.reference, attempts=exc.attempts
        )
        return None

    if result.response.truncated:
        # A cut-off reasoning model can spill its monologue into `content`.
        # An operator reading half a thought as if it were a conclusion is
        # worse than being told the answer did not come back.
        log.warning("assist.truncated", reference=view.reference)
        return None

    return result.value
