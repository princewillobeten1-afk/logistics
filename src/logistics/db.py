"""Postgres access.

One async pool for the process. Handlers never hold a transaction open across
external I/O — they read what they need, do their I/O, and hand a StepResult
back to the orchestrator, which commits it in a single short transaction.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from pathlib import Path
from uuid import UUID

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from logistics.config import Settings, get_settings

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"


# --------------------------------------------------------------- tenancy
#
# Migration 016 put row-level security on every business table, keyed off the
# `app.current_org` setting. These two context variables are what put a value
# there. Because they are ContextVars they follow the async task, so an org set
# once at the top of a work item is inherited by every nested query without a
# single handler having to pass it down.
#
# Unset means *no rows*, not all rows. That is deliberate: forgetting to scope
# a query is the common mistake, and it should return nothing rather than
# everything.

current_org: ContextVar[UUID | None] = ContextVar("current_org", default=None)

# The escape hatch from tenancy. Two modules are entitled to it: this one
# (`Database.migrate`) and `orchestrator/queue.py`, which claims and reclaims
# across orgs because one worker process serves every tenant and must see every
# tenant's queue to know whose work is due. Both touch queue bookkeeping only.
# `test_tenancy.py` asserts the import appears in exactly those two files.
system_mode: ContextVar[bool] = ContextVar("system_mode", default=False)


@contextmanager
def use_org(org_id: UUID | None) -> Iterator[None]:
    """Scope everything inside to one organisation."""
    token = current_org.set(org_id)
    try:
        yield
    finally:
        current_org.reset(token)


@contextmanager
def system_context() -> Iterator[None]:
    """Bypass tenant isolation. Migrations and the queue claim only."""
    token = system_mode.set(True)
    try:
        yield
    finally:
        system_mode.reset(token)


# The role application queries run as. It is not the tables' owner and has no
# BYPASSRLS, which is the only reason the policies in migration 016 have any
# effect: the connection role `logistics` is a superuser, and superusers ignore
# row level security entirely — FORCE included. Migration 017 has the details.
APP_ROLE = "logistics_app"


async def _apply_scope(conn: AsyncConnection, *, privileged: bool = False) -> None:
    """Stamp the current context onto a freshly checked-out connection.

    Session-level rather than SET LOCAL: the pool runs in autocommit, where
    there is no surrounding transaction for a LOCAL setting to belong to, and
    Postgres would discard it with a warning. `_clear_scope` is registered as
    the pool's reset hook so neither the role nor the org can outlive the
    checkout and leak into whoever gets the connection next.

    `privileged` keeps the owner's rights and is for DDL only.
    """
    org = current_org.get()
    if not privileged:
        await conn.execute(f"SET ROLE {APP_ROLE}")
    await conn.execute(
        "SELECT set_config('app.current_org', %s, false),"
        "       set_config('app.system', %s, false)",
        (str(org) if org else "", "on" if system_mode.get() else ""),
    )


async def _clear_scope(conn: AsyncConnection) -> None:
    """Pool reset hook — runs when a connection goes back to the pool."""
    await conn.execute(
        "RESET ROLE;"
        "SELECT set_config('app.current_org', '', false),"
        "       set_config('app.system', '', false)"
    )


class Database:
    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._pool: AsyncConnectionPool | None = None

    async def open(self) -> None:
        if self._pool is not None:
            return
        self._pool = AsyncConnectionPool(
            conninfo=self._settings.database_url,
            min_size=self._settings.db_pool_min,
            max_size=self._settings.db_pool_max,
            kwargs={"row_factory": dict_row, "autocommit": True},
            reset=_clear_scope,
            open=False,
        )
        await self._pool.open(wait=True, timeout=30)

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    @property
    def pool(self) -> AsyncConnectionPool:
        if self._pool is None:
            raise RuntimeError("Database.open() has not been called")
        return self._pool

    @asynccontextmanager
    async def connection(
        self, *, privileged: bool = False
    ) -> AsyncIterator[AsyncConnection]:
        async with self.pool.connection() as conn:
            await _apply_scope(conn, privileged=privileged)
            yield conn

    @asynccontextmanager
    async def transaction(
        self, *, privileged: bool = False
    ) -> AsyncIterator[AsyncConnection]:
        # The scope is applied before the transaction opens, so a rollback
        # cannot revert it and leave the connection unscoped mid-flight.
        async with self.pool.connection() as conn:
            await _apply_scope(conn, privileged=privileged)
            async with conn.transaction():
                yield conn

    async def migrate(self) -> list[str]:
        """Apply any .sql file in migrations/ not yet in schema_migrations.

        Each file runs in its own transaction and is expected to be idempotent
        (IF NOT EXISTS throughout), so a partial failure is safe to re-run.
        """
        files = sorted(MIGRATIONS_DIR.glob("*.sql"))
        # Sanctioned system-context caller #1. A migration seeding a table that
        # RLS protects would otherwise insert rows it could not then see.
        with system_context(), use_org(None):
            return await self._apply(files)

    async def _apply(self, files: list[Path]) -> list[str]:
        applied: list[str] = []
        # The one place that keeps the owner's rights: DDL needs them, and
        # `logistics_app` deliberately cannot alter the schema that constrains
        # it. Migration 017 creates that role, so this must also work before it
        # exists.
        async with self.connection(privileged=True) as conn:
            await conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                " version TEXT PRIMARY KEY,"
                " applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
            )
            cur = await conn.execute("SELECT version FROM schema_migrations")
            done = {row["version"] for row in await cur.fetchall()}

            for path in files:
                version = path.stem
                if version in done:
                    continue
                async with conn.transaction():
                    await conn.execute(path.read_text(encoding="utf-8"))
                    await conn.execute(
                        "INSERT INTO schema_migrations (version) VALUES (%s)"
                        " ON CONFLICT (version) DO NOTHING",
                        (version,),
                    )
                applied.append(version)
        return applied
