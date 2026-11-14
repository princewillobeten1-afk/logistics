"""The tool registry — what each agent may do, and what happens before it does it.

Until now an agent's capabilities were whatever its handler happened to import.
That is not a boundary: it is a description of the code as written, discoverable
only by reading all of it, and it changes silently whenever someone adds an
import. §34 wrote the permissions down in prose; this makes them data, and puts
them where they are actually enforced.

Every call passes four gates, in this order:

    1. does the tool exist
    2. **may this agent call it** — before anything else, so an agent reaching
       outside its remit fails earlier and more loudly than one merely over
       budget. A carrier agent asking for `release_inventory` is a bug in the
       system; a carrier agent asking to spend too much is a Tuesday.
    3. do the arguments validate
    4. what does policy say about the tier

Only then does anything happen. The registry never decides *whether* an action
is wise — `PolicyEngine` does that, and the model cannot reach either.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from enum import IntEnum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ValidationError

from logistics.db import Database
from logistics.obs import get_logger
from logistics.tools.executor import ToolExecutor, ToolResult, idempotency_key

log = get_logger(__name__)


class Tier(IntEnum):
    """How much damage a tool can do.

    The numbers were already load-bearing — the seeded policy carries
    `auto_execute_tiers: [0, 1]`, and `exception_agent/resolve.py` has its own
    copy of the mapping — but they were an undocumented convention spread
    across three files. This is the declaration those were referring to.
    """

    READ = 0
    """Answers a question. Cannot change anything, so it is never gated."""

    INTERNAL = 1
    """Writes our own records. Reversible by us, invisible outside."""

    EXTERNAL = 2
    """Leaves the building. Costs no money but cannot be unsaid — a message to
    a customer is irreversible socially."""

    SPEND = 3
    """Commits money. Every one of these reaches a human until the caps move."""


# --------------------------------------------------------------- failures


class ToolNotFound(Exception):
    pass


class PermissionDenied(Exception):
    """The agent has no business calling this tool at all.

    Distinct from `ToolDenied` on purpose. Over budget is a normal outcome that
    routes to an approver; outside your remit means the wiring is wrong, and it
    should never be handled by asking a human to approve it.
    """

    def __init__(self, agent: str, tool: str) -> None:
        super().__init__(f"agent {agent!r} may not call {tool!r}")
        self.agent = agent
        self.tool = tool


class ToolInputError(Exception):
    """The arguments did not match the schema. For a model-produced call this
    is the common failure, and the message is fed back for a retry."""

    def __init__(self, tool: str, detail: str) -> None:
        super().__init__(f"{tool}: {detail}")
        self.tool = tool
        self.detail = detail


class ToolDenied(Exception):
    """Policy refused, or wants a human first. Carries the proposal so the
    caller can raise an approval against it rather than inventing a new one."""

    def __init__(
        self, tool: str, decision: str, reason: str, proposal_id: UUID | None = None
    ) -> None:
        super().__init__(f"{tool}: {decision} — {reason}")
        self.tool = tool
        self.decision = decision
        self.reason = reason
        self.proposal_id = proposal_id


# --------------------------------------------------------------- context


@dataclass(frozen=True, slots=True)
class ToolContext:
    """What a tool is given. Deliberately narrower than `StepContext`: a tool
    gets the database and the identifiers, not the work item or the registry,
    so it cannot reach back and schedule itself."""

    db: Database
    agent: str
    policy: Any = None
    shipment_id: UUID | None = None
    agent_run_id: UUID | None = None
    work_item_id: UUID | None = None
    telegram: Any = None

    proposal_id: UUID | None = None
    """The gate's own audit row, filled in by `call()` before the tool runs.

    A tool that enqueues a gated handler has to name the proposal that
    authorised it — `carrier.book` refuses to tender against a booking with no
    decision behind it, which is the guard that makes the whole propose → gate
    → execute sequence mean something.
    """

    def executor(self) -> ToolExecutor:
        return ToolExecutor(self.db)


ToolFn = Callable[[ToolContext, Any], Awaitable[dict[str, Any]]]


@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: str
    description: str
    tier: Tier
    args: type[BaseModel]
    fn: ToolFn
    action: str
    """The policy action name. Policy rules are keyed on this, so a tool and
    the rule that governs it are joined by a string that must match."""

    key_fields: tuple[str, ...] = ()
    """Which argument fields identify this call for idempotency. Empty means
    the tool is not run through the executor — correct for reads and for
    internal writes that are already transactional."""

    def schema(self) -> dict[str, Any]:
        """What a model is told about this tool. The same JSON Schema the
        arguments are validated against, so the description an agent reads and
        the contract it is held to cannot drift apart."""
        return {
            "name": self.name,
            "description": self.description,
            "tier": int(self.tier),
            "parameters": self.args.model_json_schema(),
        }


# ------------------------------------------------------------- the registry


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}
        self._grants: dict[str, frozenset[str]] = {}

    # ------------------------------------------------------------ wiring

    def register(self, spec: ToolSpec) -> None:
        if spec.name in self._tools:
            raise ValueError(f"tool {spec.name!r} is already registered")
        self._tools[spec.name] = spec

    def grant(self, agent: str, tools: set[str]) -> None:
        self._grants[agent] = frozenset(tools)

    @property
    def names(self) -> list[str]:
        return sorted(self._tools)

    def get(self, name: str) -> ToolSpec:
        try:
            return self._tools[name]
        except KeyError:
            raise ToolNotFound(f"no tool named {name!r}") from None

    def may(self, agent: str, tool: str) -> bool:
        """Unknown agents get nothing. Fails closed, like everything else that
        decides what is allowed."""
        return tool in self._grants.get(agent, frozenset())

    def for_agent(self, agent: str) -> list[ToolSpec]:
        return [self._tools[n] for n in sorted(self._grants.get(agent, ())) if n in self._tools]

    def schemas_for(self, agent: str) -> list[dict[str, Any]]:
        """The tool list to put in a prompt. An agent is only ever told about
        tools it may actually call — describing one it cannot use invites it to
        try, and then the refusal reads as a system fault rather than a
        boundary."""
        return [spec.schema() for spec in self.for_agent(agent)]

    def unreachable(self) -> set[str]:
        """Registered tools no agent may call. A tool nobody can reach is
        either a permission that was forgotten or code that should be deleted;
        both are worth knowing about."""
        granted: set[str] = set()
        for tools in self._grants.values():
            granted |= tools
        return set(self._tools) - granted

    def undefined(self) -> set[str]:
        """Granted names with no tool behind them — a typo in a permission set,
        which would otherwise surface as a puzzling ToolNotFound at runtime."""
        granted: set[str] = set()
        for tools in self._grants.values():
            granted |= tools
        return granted - set(self._tools)

    # ------------------------------------------------------------ calling

    async def call(
        self,
        agent: str,
        name: str,
        args: dict[str, Any],
        ctx: ToolContext | None = None,
        *,
        db: Database | None = None,
        **context_kwargs: Any,
    ) -> ToolResult:
        """Run a tool on behalf of an agent, through every gate."""
        spec = self.get(name)  # 1. exists

        if not self.may(agent, name):  # 2. permitted
            log.error("tool.forbidden", agent=agent, tool=name)
            raise PermissionDenied(agent, name)

        try:  # 3. arguments
            parsed = spec.args.model_validate(args)
        except ValidationError as exc:
            raise ToolInputError(name, _explain(exc)) from exc

        if ctx is None:
            if db is None:
                raise ValueError("call() needs either a ToolContext or a db")
            ctx = ToolContext(db=db, agent=agent, **context_kwargs)
        elif context_kwargs:
            raise ValueError("pass context_kwargs or a ToolContext, not both")

        proposal_id = await self._gate(spec, parsed, ctx)  # 4. policy
        if proposal_id is not None:
            ctx = replace(ctx, proposal_id=proposal_id)

        payload = parsed.model_dump(mode="json")

        if not spec.key_fields:
            # Reads and internal writes run directly: the executor exists to
            # make *external* calls happen at most once, and wrapping a SELECT
            # in an intent row would fill tool_calls with noise.
            response = await spec.fn(ctx, parsed)
            return ToolResult(ok=True, response=response)

        key = idempotency_key(
            name, *(payload.get(f) for f in spec.key_fields)
        )
        return await ctx.executor().execute(
            key=key,
            tool=name,
            tier=int(spec.tier),
            request=payload,
            call=lambda: spec.fn(ctx, parsed),
            shipment_id=ctx.shipment_id,
            agent_run_id=ctx.agent_run_id,
        )

    async def _gate(
        self, spec: ToolSpec, parsed: BaseModel, ctx: ToolContext
    ) -> UUID | None:
        """Tier 0 is ungated — a read cannot hurt anyone. Everything else asks
        `PolicyEngine`, which the model cannot reach and cannot argue with.

        Returns the proposal id when one was written, so the tool can name the
        decision that authorised it.
        """
        if spec.tier is Tier.READ:
            return None
        if ctx.policy is None:
            # No gate configured is not permission to proceed. A tool that
            # spends money with no policy behind it is the failure this whole
            # structure exists to prevent.
            raise ToolDenied(
                spec.name, "DENY", "no policy engine is configured for this call"
            )

        params = parsed.model_dump(mode="json")

        if ctx.shipment_id is None:
            # `proposed_actions.shipment_id` is NOT NULL, so a tool call with
            # no shipment cannot leave a proposal row. The decision is still
            # made and still binding — only the audit row is missing, and
            # inventing a shipment to hang it on would be worse.
            result = await ctx.policy.evaluate(spec.action, params, tier=int(spec.tier))
            if str(result.decision) != "ALLOW":
                raise ToolDenied(spec.name, str(result.decision), result.reason)
            return None

        proposal = await ctx.policy.propose(
            shipment_id=ctx.shipment_id,
            action=spec.action,
            params=params,
            tier=int(spec.tier),
            rationale=f"{ctx.agent} agent called {spec.name}",
            agent_run_id=ctx.agent_run_id,
            work_item_id=ctx.work_item_id,
        )
        if str(proposal.result.decision) != "ALLOW":
            raise ToolDenied(
                spec.name,
                str(proposal.result.decision),
                proposal.result.reason,
                proposal.id,
            )
        return proposal.id


def _explain(exc: ValidationError) -> str:
    """One line per problem, naming the field. This text goes back to a model
    as a retry prompt, so it has to say what to fix rather than how it broke."""
    return "; ".join(
        f"{'.'.join(str(p) for p in err['loc']) or 'input'}: {err['msg']}"
        for err in exc.errors()
    )


registry = ToolRegistry()


def tool(
    name: str,
    *,
    tier: Tier,
    description: str,
    args: type[BaseModel],
    action: str | None = None,
    key_fields: tuple[str, ...] = (),
) -> Callable[[ToolFn], ToolFn]:
    """Register a tool. The decorated function keeps working as a plain
    function, so a handler that already calls it directly is unaffected."""

    def decorate(fn: ToolFn) -> ToolFn:
        registry.register(
            ToolSpec(
                name=name,
                description=description,
                tier=tier,
                args=args,
                fn=fn,
                action=action or name,
                key_fields=key_fields,
            )
        )
        return fn

    return decorate
