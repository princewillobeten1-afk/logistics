"""The customer support agent.

The front door to every other agent. A customer message can now cause work —
an order, a change request, an escalation — but only ever by enqueueing it for
the orchestrator, never by calling another agent directly.

Three layers, deliberately separated:

    view.py      what the agent is allowed to know (an allowlist)
    decide.py    what the customer wants and what to say (one model call)
    delegate.py  what work that causes (pure, no model)

The model decides what to *say*. It never decides whether something happens —
`delegate.py` maps intents to work and the policy gate decides whether that
work may proceed. A misclassification produces a wrong sentence, not a wrong
action.
"""

from logistics.support.decide import (
    Intent,
    OrderDraft,
    SupportDecision,
    decide,
)
from logistics.support.delegate import Delegation, plan_delegation
from logistics.support.prompts import SYSTEM
from logistics.support.view import (
    CUSTOMER_DELAY_REASON,
    CUSTOMER_STATUS,
    CustomerView,
    build_view,
)

__all__ = [
    "CUSTOMER_DELAY_REASON",
    "CUSTOMER_STATUS",
    "CustomerView",
    "Delegation",
    "Intent",
    "OrderDraft",
    "SYSTEM",
    "SupportDecision",
    "answer",
    "build_view",
    "decide",
    "normalise",
    "plan_delegation",
]


# Models emit typographic characters that break SMS gateways and some fonts.
_SUBSTITUTIONS = {
    " ": " ",  # narrow no-break space
    " ": " ",  # no-break space
    "‑": "-",  # non-breaking hyphen
    "–": "-",
    "—": "-",
    "‘": "'",
    "’": "'",
    "“": '"',
    "”": '"',
}


def normalise(text: str) -> str:
    """Flatten typographic characters before anything customer-facing.

    Observed live from Nemotron: U+202F and U+2011 in ordinary replies.
    Harmless in a browser, but they corrupt SMS and some WhatsApp gateways.
    """
    for bad, good in _SUBSTITUTIONS.items():
        text = text.replace(bad, good)
    return text


async def answer(llm, view, question, **kwargs):  # noqa: ANN001, ANN201
    """Reply text only, for callers that do not want a full decision.

    Kept so the `/track` preview console and existing tests keep working;
    `decide()` is what the live agent uses.
    """
    decision = await decide(llm, message=question, view=view, **kwargs)
    return normalise(decision.reply)
