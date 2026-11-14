"""Handler contract and registry.

A handler receives a StepContext and returns a StepResult. It must not write to
shipments, shipment_events, or work_items — the orchestrator applies its result
in one transaction. Keeping handlers side-effect-free with respect to core
state is what makes a crashed step safe to retry.

External side effects (a carrier tender, an outbound message) are the exception
and go through the tool layer with an idempotency key.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from logistics.config import Settings
from logistics.db import Database
from logistics.domain.models import Shipment, StepResult, WorkItem
from logistics.llm.base import LLMClient
from logistics.obs import get_logger

if TYPE_CHECKING:
    from logistics.orchestrator.policy import PolicyEngine

log = get_logger(__name__)


@dataclass(slots=True)
class StepContext:
    item: WorkItem
    shipment: Shipment | None
    db: Database
    settings: Settings
    llm: LLMClient | None = None
    policy: PolicyEngine | None = None
    telegram: Any = None
    """TelegramAdapter when a bot token is configured. None otherwise, and
    sourcing simply skips Telegram carriers rather than failing."""

    @property
    def log(self):  # noqa: ANN201 - structlog's bound type is not worth importing here
        return log.bind(
            kind=self.item.kind,
            item_id=str(self.item.id),
            shipment_id=str(self.item.shipment_id) if self.item.shipment_id else None,
            attempt=self.item.attempts,
        )

    def require_shipment(self) -> Shipment:
        if self.shipment is None:
            raise HandlerError(f"step {self.item.kind!r} requires a shipment")
        return self.shipment

    def require_llm(self) -> LLMClient:
        if self.llm is None:
            raise HandlerError(
                f"step {self.item.kind!r} needs a model but none is configured "
                "(set NVIDIA_API_KEY)"
            )
        return self.llm

    def require_policy(self) -> PolicyEngine:
        if self.policy is None:
            raise HandlerError(f"step {self.item.kind!r} requires the policy engine")
        return self.policy


class HandlerError(Exception):
    """Retryable handler failure."""


class PermanentFailure(HandlerError):
    """A failure retrying cannot fix — a malformed payload, an unknown kind.

    The worker sends these straight to DEAD instead of burning the retry budget.
    """


Handler = Callable[[StepContext], Awaitable[StepResult]]


class HandlerRegistry:
    def __init__(self) -> None:
        self._handlers: dict[str, Handler] = {}

    def register(self, kind: str) -> Callable[[Handler], Handler]:
        def decorate(fn: Handler) -> Handler:
            if kind in self._handlers:
                raise ValueError(f"handler already registered for {kind!r}")
            self._handlers[kind] = fn
            return fn

        return decorate

    def get(self, kind: str) -> Handler | None:
        return self._handlers.get(kind)

    @property
    def kinds(self) -> list[str]:
        return sorted(self._handlers)


registry = HandlerRegistry()
handler = registry.register
