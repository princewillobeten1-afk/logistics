"""The Exception Management Agent.

The one place in the platform where open-ended reasoning genuinely earns its
cost. Detection is arithmetic — a truck is late, off route, or silent — but
*what to do about it* has an unbounded option space: re-source a carrier,
accept the delay and tell the customer, split the load, expedite, or fetch a
human. That is a judgment, and there are ~370 of them a day rather than a
million.

Same three layers as the support agent, for the same reasons:

    gather.py   the case file, assembled deterministically
    reason.py   one structured model call: cause, impact, ranked resolutions
    resolve.py  turning a resolution into orchestrator work — pure

The model reasons about the situation. It never executes anything: every
resolution becomes a `PolicyEngine.propose`, and the gate decides. Your spec's
"execute permitted solutions, request approval when required" is exactly what
the gate already does.
"""

from logistics.exception_agent.gather import CaseFile, build_case
from logistics.exception_agent.reason import (
    Investigation,
    Resolution,
    ResolutionKind,
    investigate,
)
from logistics.exception_agent.resolve import plan_resolution

__all__ = [
    "CaseFile",
    "Investigation",
    "Resolution",
    "ResolutionKind",
    "build_case",
    "investigate",
    "plan_resolution",
]
