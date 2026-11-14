from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass

import pytest

from logistics.config import Settings
from logistics.db import Database, current_org, use_org
from logistics.handlers.base import HandlerRegistry
from logistics.llm.base import LLMClient, LLMRequest, LLMResponse
from logistics.orchestrator.orchestrator import Orchestrator
from logistics.orchestrator.policy import PolicyEngine
from logistics.orchestrator.queue import WorkQueue
from logistics.runtime import loop_factory
from logistics.shipments import ShipmentRepo

# A separate database from the one the CLI uses. The suite TRUNCATEs, so
# sharing would silently wipe seeded development data mid-session.
TEST_DSN = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://logistics:logistics@localhost:5433/logistics_test"
)


def _ensure_test_database() -> None:
    """Create the test database if it does not exist. CREATE DATABASE cannot
    run inside a transaction, hence autocommit against the maintenance db."""
    import psycopg

    target = TEST_DSN.rsplit("/", 1)[-1]
    admin_dsn = TEST_DSN.rsplit("/", 1)[0] + "/postgres"
    with psycopg.connect(admin_dsn, autocommit=True, connect_timeout=10) as conn:
        exists = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (target,)
        ).fetchone()
        if not exists:
            conn.execute(f'CREATE DATABASE "{target}"')


def pytest_asyncio_loop_factories(config, item):  # noqa: ANN001, ANN201, ARG001
    """Run tests on a loop psycopg supports. See logistics.runtime."""
    return {"selector": loop_factory}


@pytest.fixture(scope="session")
def settings() -> Settings:
    return Settings(
        database_url=TEST_DSN,
        worker_concurrency=1,
        worker_poll_interval_s=0.05,
        worker_idle_backoff_s=0.1,
        worker_lease_s=30,
        retry_base_delay_s=0.01,
        retry_max_delay_s=0.05,
        log_level="WARNING",
        wpcargo_url=None,
        wpcargo_username=None,
        wpcargo_password=None,
        nvidia_api_key=None,
        nvidia_cuopt_api_key=None,
    )


@pytest.fixture
async def db(settings: Settings) -> AsyncIterator[Database]:
    database = Database(settings)
    try:
        _ensure_test_database()
        await database.open()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Postgres unavailable at {TEST_DSN}: {exc}")
    await database.migrate()
    # Truncate rather than recreate: fast, and keeps the schema under test.
    # CASCADE reaches the operational tables that reference shipments.
    #
    # Privileged, because this is schema maintenance rather than application
    # work: `logistics_app` is not the tables' owner, and a TRUNCATE issued
    # under tenant scope would be the wrong shape for a fixture that is meant
    # to clear everything.
    async with database.connection(privileged=True) as conn:
        await conn.execute(
            "TRUNCATE shipments, shipment_events, work_items, agent_runs,"
            " tool_calls, proposed_actions, approvals, customers, orders,"
            " products, locations, warehouses, inventory, carriers,"
            " conveyances, drivers, routes, exceptions, documents,"
            " communications, claims, invoices, audit_logs, fx_rates,"
            # Accounts too, or a test using a fixed email collides with the
            # previous run. `organisations` is not truncated: the default org
            # is seeded by migration 015 and everything else points at it.
            " users, sessions"
            " RESTART IDENTITY CASCADE"
        )
        # Channel rows are seeded by migration 010; restore them rather than
        # truncating, the same way policies are.
        await conn.execute("DELETE FROM channel_contacts")
        await conn.execute(
            "UPDATE channel_connections SET credentials = NULL,"
            " config = '{}'::jsonb, state = 'UNCONFIGURED', enabled = false,"
            " verified_at = NULL, last_error = NULL, cursor = NULL,"
            " last_inbound_at = NULL"
        )
        # `currencies` is reference data from migration 003 and stays.
        # `fx_rates` is truncated so each test controls its own rates —
        # migration 006's seed is a dev convenience, not a test fixture.
        # policies is seeded by migration, not by tests, so it is restored
        # rather than truncated. Tests that install their own rules use a
        # version >= 90; drop those and re-activate the seeded one.
        await conn.execute("DELETE FROM policies WHERE version >= 90")
        await conn.execute(
            "UPDATE policies SET active ="
            " (version = (SELECT max(version) FROM policies))"
        )
        cur = await conn.execute("SELECT id FROM organisations WHERE slug = 'default'")
        org_id = (await cur.fetchone())["id"]

    # Every test runs inside an organisation, because since migration 016 an
    # unscoped query returns nothing at all. Tests that care about isolation
    # itself override this explicitly; the rest never notice it is here.
    with use_org(org_id):
        yield database
    await database.close()


@pytest.fixture
async def org_id(db: Database) -> uuid.UUID:
    """The organisation the `db` fixture scopes everything to."""
    return current_org.get()


@pytest.fixture
async def other_org(db: Database) -> uuid.UUID:
    """A second organisation, for proving the first cannot see it."""
    async with db.connection(privileged=True) as conn:
        cur = await conn.execute(
            "INSERT INTO organisations (name, slug) VALUES ('Other Ltd', 'other')"
            " ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        )
        return (await cur.fetchone())["id"]


@pytest.fixture
def queue(db: Database, settings: Settings) -> WorkQueue:
    return WorkQueue(db, settings)


@pytest.fixture
def repo(db: Database) -> ShipmentRepo:
    return ShipmentRepo(db)


@pytest.fixture
def policy(db: Database) -> PolicyEngine:
    return PolicyEngine(db)


@pytest.fixture
def orchestrator(db, queue, repo, settings) -> Orchestrator:  # noqa: ANN001
    return Orchestrator(db, queue, repo, settings)


@pytest.fixture
def reference() -> str:
    return f"TEST-{uuid.uuid4().hex[:8].upper()}"


# (code, name, integration, on_time, damage, availability, service, shipments)
FLEET = [
    ("T-CHEAP", "Budget Movers", "API", 0.78, 0.09, 0.98, 0.62, 240),
    ("T-SOLID", "Steady Freight", "API", 0.91, 0.02, 0.85, 0.88, 180),
    ("T-PREMIUM", "Premier Logistics", "API", 0.97, 0.01, 0.70, 0.94, 300),
]


@pytest.fixture
async def carriers(db: Database) -> list[str]:
    """A small API fleet so sourcing has someone to ask.

    Spread deliberately: the cheapest carrier has the worst on-time and damage
    record, so the scoring model has a real trade-off to resolve rather than a
    single obvious winner.
    """
    async with db.connection() as conn:
        for code, name, integration, on_time, damage, avail, service, n in FLEET:
            cur = await conn.execute(
                "INSERT INTO carriers (code, name, modes, integration, approved, active)"
                " VALUES (%s, %s, ARRAY['ROAD','SEA','AIR'], %s, true, true)"
                " ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name"
                " RETURNING id",
                (code, name, integration),
            )
            carrier_id = (await cur.fetchone())["id"]
            await conn.execute(
                """
                INSERT INTO carrier_performance
                    (carrier_id, shipments_count, on_time_rate, damage_rate,
                     availability_rate, service_score)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (carrier_id, COALESCE(origin_region, ''),
                             COALESCE(destination_region, ''), COALESCE(mode, ''))
                DO UPDATE SET on_time_rate = EXCLUDED.on_time_rate
                """,
                (carrier_id, n, on_time, damage, avail, service),
            )
    return [c[0] for c in FLEET]


@pytest.fixture
async def fx(db: Database) -> None:
    """A fresh NGN base rate set, so scoring can price non-NGN quotes."""
    from datetime import UTC, datetime

    async with db.connection() as conn:
        for base, quote, rate in (("USD", "NGN", 1580), ("EUR", "NGN", 1710)):
            await conn.execute(
                "INSERT INTO fx_rates (base, quote, rate, as_of, source)"
                " VALUES (%s, %s, %s, %s, 'test')"
                " ON CONFLICT (base, quote, as_of) DO NOTHING",
                (base, quote, rate, datetime.now(UTC)),
            )


# ---------------------------------------------------------------- fake model


@dataclass(frozen=True)
class Reply:
    """A scripted model reply, when a test needs more than the text."""

    text: str
    finish_reason: str | None = "stop"
    reasoning: str | None = None


class ScriptedLLM(LLMClient):
    """Returns canned replies. Lets the whole pipeline run without a network
    call, and lets tests script the malformed and truncated output open-weight
    models actually produce."""

    def __init__(self, *replies: str | Reply) -> None:
        self.replies: list[str | Reply] = list(replies)
        self.requests: list[LLMRequest] = []

    async def complete(self, req: LLMRequest) -> LLMResponse:
        self.requests.append(req)
        reply = self.replies.pop(0) if self.replies else "{}"
        if isinstance(reply, str):
            reply = Reply(text=reply)
        return LLMResponse(
            text=reply.text,
            model=req.model,
            latency_ms=1,
            finish_reason=reply.finish_reason,
            reasoning=reply.reasoning,
        )


@pytest.fixture
def registry() -> HandlerRegistry:
    return HandlerRegistry()
