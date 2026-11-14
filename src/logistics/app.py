"""Assembly.

One place where the object graph is wired, so tests can build the same graph
with a fake model client and nothing else changes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from logistics.config import Settings, get_settings
from logistics.db import Database, current_org
from logistics.handlers import registry
from logistics.handlers.allocate import set_inventory_source
from logistics.handlers.base import HandlerRegistry
from logistics.inventory import PostgresInventory
from logistics.llm.audited import AuditedLLMClient
from logistics.llm.base import LLMClient
from logistics.obs import configure_logging, get_logger
from logistics.orchestrator.orchestrator import Orchestrator
from logistics.orchestrator.policy import PolicyEngine
from logistics.orchestrator.queue import WorkQueue
from logistics.orchestrator.worker import Worker
from logistics.shipments import ShipmentRepo

log = get_logger(__name__)


@dataclass(slots=True)
class App:
    settings: Settings
    db: Database
    queue: WorkQueue
    repo: ShipmentRepo
    orchestrator: Orchestrator
    policy: PolicyEngine
    handlers: HandlerRegistry
    llm: LLMClient | None
    telegram: Any = None

    def worker(self) -> Worker:
        return Worker(
            db=self.db,
            queue=self.queue,
            orchestrator=self.orchestrator,
            repo=self.repo,
            registry=self.handlers,
            llm=self.llm,
            policy=self.policy,
            telegram=self.telegram,
            settings=self.settings,
        )

    async def aclose(self) -> None:
        await self.db.close()


class UnknownOrganisation(Exception):
    pass


async def resolve_org(db: Database, slug: str) -> UUID:
    """Slug to id. `organisations` is outside RLS — it has to be, since
    resolving which org you are is what happens before any scope exists."""
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id FROM organisations WHERE slug = %s AND active", (slug,)
        )
        row = await cur.fetchone()
    if row is None:
        raise UnknownOrganisation(f"no active organisation with slug {slug!r}")
    return row["id"]


async def build_app(
    settings: Settings | None = None,
    *,
    llm: LLMClient | None = None,
    handlers: HandlerRegistry | None = None,
    org: str | None = None,
) -> App:
    """Wire the object graph.

    `org` scopes the whole process to one organisation's data — what a CLI
    command wants, since it acts on behalf of one company. The worker passes
    nothing: it serves every tenant and sets the scope per work item instead.
    Left unset, every tenant-scoped query returns zero rows, which is the
    intended outcome for a caller that never said whose data it wanted.
    """
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    db = Database(settings)
    await db.open()

    if org is not None:
        current_org.set(await resolve_org(db, org))

    # Real inventory now that the tables exist. Tests swap the in-memory stub
    # back in through the same seam.
    set_inventory_source(PostgresInventory(db))

    queue = WorkQueue(db, settings)
    repo = ShipmentRepo(db)

    if llm is None and settings.has_llm:
        from logistics.llm.nvidia import NvidiaClient

        llm = NvidiaClient(settings)

    if llm is not None:
        llm = AuditedLLMClient(llm, db)
    else:
        log.warning("llm.disabled", reason="NVIDIA_API_KEY is not set")

    telegram = None
    if settings.has_telegram:
        from logistics.carriers.telegram import HttpTransport, TelegramAdapter

        telegram = TelegramAdapter(
            HttpTransport(settings.telegram_bot_token.get_secret_value())
        )
    else:
        # Not fatal: sourcing simply skips Telegram carriers and asks the API
        # ones. A missing token narrows the fleet, it does not stop the system.
        log.info("telegram.disabled", reason="TELEGRAM_BOT_TOKEN is not set")

    return App(
        settings=settings,
        db=db,
        queue=queue,
        repo=repo,
        orchestrator=Orchestrator(db, queue, repo, settings),
        policy=PolicyEngine(db),
        handlers=handlers or registry,
        llm=llm,
        telegram=telegram,
    )
