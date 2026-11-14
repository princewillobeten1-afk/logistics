"""Command line entry points."""

from __future__ import annotations

import asyncio
import json
import signal
from datetime import datetime
from pathlib import Path
from typing import Annotated

import typer

from logistics import audit
from logistics.app import build_app
from logistics.config import get_settings
from logistics.db import Database, current_org, use_org
from logistics.obs import configure_logging
from logistics.runtime import run as _run

app = typer.Typer(add_completion=False, help="AI Logistics Control Tower")

# Which organisation the command acts for. A CLI operator is always working on
# behalf of one company; the worker is the exception, and opts out below.
_ORG = "default"


@app.callback()
def _global(
    org: Annotated[
        str,
        typer.Option(
            "--org", envvar="LOGISTICS_ORG",
            help="Organisation slug to act on behalf of.",
        ),
    ] = "default",
) -> None:
    global _ORG  # noqa: PLW0603
    _ORG = org


async def _app():  # noqa: ANN202
    """Build the app scoped to --org. Every command below uses this rather
    than build_app() directly, so none of them can forget the scope and
    silently return nothing."""
    return await build_app(org=_ORG)


@app.command()
def migrate() -> None:
    """Apply pending SQL migrations."""

    async def _main() -> None:
        settings = get_settings()
        configure_logging(settings.log_level, settings.log_json)
        db = Database(settings)
        await db.open()
        try:
            applied = await db.migrate()
        finally:
            await db.close()
        if applied:
            typer.echo(f"Applied: {', '.join(applied)}")
        else:
            typer.echo("Already up to date.")

    _run(_main())


@app.command("seed-demo")
def seed_demo_cmd() -> None:
    """Populate warehouses, stock and carriers for local development."""

    async def _main() -> None:
        from logistics.seed import seed_demo

        instance = await _app()
        try:
            counts = await seed_demo(instance.db)
        finally:
            await instance.aclose()
        typer.echo(f"Seeded into {_ORG}: {counts}")

    _run(_main())


@app.command()
def worker() -> None:
    """Run the orchestrator worker until interrupted."""

    async def _main() -> None:
        # Deliberately unscoped: the worker serves every tenant, and sets the
        # scope per work item from the item's own org_id. A process-wide org
        # here would make it a single-tenant worker.
        instance = await build_app()
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:
                # Windows: KeyboardInterrupt handles it instead.
                pass
        try:
            await instance.worker().run(stop)
        except KeyboardInterrupt:
            stop.set()
        finally:
            await instance.aclose()

    _run(_main())


@app.command()
def submit(
    file: Annotated[Path, typer.Argument(help="JSON order file")],
    start: Annotated[bool, typer.Option(help="Schedule the first step immediately")] = True,
) -> None:
    """Create a shipment from a JSON order and put it on the queue."""

    async def _main() -> None:
        order = json.loads(file.read_text(encoding="utf-8"))
        instance = await _app()
        try:
            deadline = order.get("deadline")
            shipment = await instance.repo.create(
                reference=order["reference"],
                customer_ref=order.get("customer"),
                origin=order.get("origin", {}),
                destination=order.get("destination", {}),
                cargo=order.get("cargo", {}),
                deadline=datetime.fromisoformat(deadline) if deadline else None,
            )
            typer.echo(f"Created {shipment.reference}  id={shipment.id}  state={shipment.state}")
            if start:
                item = await instance.orchestrator.start(shipment.id)
                typer.echo(f"Scheduled: {item}")
        finally:
            await instance.aclose()

    _run(_main())


@app.command()
def status(reference: str) -> None:
    """Show a shipment's state and its event timeline."""

    async def _main() -> None:
        instance = await _app()
        try:
            shipment = await instance.repo.get_by_reference(reference)
            if shipment is None:
                typer.echo(f"No shipment with reference {reference!r}")
                raise typer.Exit(1)

            typer.echo(f"{shipment.reference}   {shipment.state}   v{shipment.version}")
            if shipment.plan:
                typer.echo(f"  plan: {json.dumps(shipment.plan, default=str)}")
            if shipment.allocation:
                typer.echo(f"  allocation: {json.dumps(shipment.allocation, default=str)}")

            async with instance.db.connection() as conn:
                cur = await conn.execute(
                    "SELECT seq, type, from_state, to_state, actor, created_at"
                    "  FROM shipment_events WHERE shipment_id = %s ORDER BY seq",
                    (shipment.id,),
                )
                typer.echo("\n  seq  event                            transition")
                for row in await cur.fetchall():
                    # ASCII arrow: the Windows console defaults to cp1252 and
                    # cannot encode U+2192.
                    move = (
                        f"{row['from_state'] or '-'} -> {row['to_state']}"
                        if row["to_state"]
                        else ""
                    )
                    typer.echo(f"  {row['seq']:>3}  {row['type']:<32} {move}")
        finally:
            await instance.aclose()

    _run(_main())


@app.command("queue")
def queue_stats() -> None:
    """Counts by work-item state and shipment state."""

    async def _main() -> None:
        instance = await _app()
        try:
            typer.echo(f"work_items: {await instance.queue.stats()}")
            typer.echo(f"shipments:  {await instance.repo.counts_by_state()}")
        finally:
            await instance.aclose()

    _run(_main())


@app.command()
def simulate(
    scenario: Annotated[
        str, typer.Option(help="clean | delayed | off-route")
    ] = "delayed",
    reference: Annotated[str, typer.Option(help="Shipment reference to create")] = "SIM-0001",
    pings: Annotated[int, typer.Option(help="Position updates to feed")] = 6,
) -> None:
    """Drive a synthetic shipment down a lane to exercise detection."""

    async def _main() -> None:
        from logistics.simulate import simulate_journey

        instance = await _app()
        try:
            result = await simulate_journey(
                instance.db, instance.queue,
                reference=reference, scenario=scenario, pings=pings,
            )
            typer.echo(f"\n{result['reference']}  scenario={result['scenario']}")
            typer.echo(f"  {result['description']}")
            typer.echo(f"  {result['pings']} tracking events ingested")
            typer.echo(
                f"  raised: {', '.join(result['raised']) if result['raised'] else 'nothing'}"
            )
            typer.echo("\nRun the worker to apply the state change:")
            typer.echo("  python -m logistics.cli worker")
        finally:
            await instance.aclose()

    _run(_main())


@app.command()
def sweep() -> None:
    """Run absence detection once — missed checkpoints and silent shipments."""

    async def _main() -> None:
        from logistics.domain.models import WorkRequest

        instance = await _app()
        try:
            await instance.queue.enqueue(
                WorkRequest(kind="detection.sweep", dedupe_key=None)
            )
            worker = instance.worker()
            done = 0
            while done < 40 and await worker.process_one():
                done += 1
            typer.echo(f"Swept. {done} step(s) processed.")
            typer.echo(f"work_items: {await instance.queue.stats()}")
        finally:
            await instance.aclose()

    _run(_main())


# --------------------------------------------------------------- accounts


@app.command("create-org")
def create_org_cmd(
    name: Annotated[str, typer.Argument(help="Display name, e.g. 'Acme Logistics'")],
    slug: Annotated[str | None, typer.Option("--slug", help="URL-safe id")] = None,
) -> None:
    """Create an organisation and give it its own channel connections."""

    async def _main() -> None:
        from logistics.auth import AuthRepo
        from logistics.channels.store import seed_channels

        settings = get_settings()
        configure_logging(settings.log_level, settings.log_json)
        db = Database(settings)
        await db.open()
        try:
            resolved = slug or _slugify(name)
            org_id = await AuthRepo(db).create_org(name, resolved)
            # A new tenant starts with no channel rows at all — migration 010
            # seeded them for the org that existed then. Without this, Settings
            # shows an empty page and nothing can be connected.
            with use_org(org_id):
                created = await seed_channels(db)
        finally:
            await db.close()
        typer.echo(f"Organisation '{name}' created.")
        typer.echo(f"  slug     : {resolved}")
        typer.echo(f"  id       : {org_id}")
        typer.echo(f"  channels : {created} connection(s) ready to configure")
        typer.echo(f"\nUse it with:  --org {resolved}")

    _run(_main())


@app.command("create-user")
def create_user_cmd(
    email: Annotated[str, typer.Option("--email", prompt=True)],
    role: Annotated[str, typer.Option("--role", help="VIEWER|DISPATCHER|APPROVER|ADMIN")] = "VIEWER",
    name: Annotated[str | None, typer.Option("--name")] = None,
    password: Annotated[
        str | None,
        typer.Option(
            "--password", prompt=True, hide_input=True, confirmation_prompt=True,
            help="Prompted for, so it does not land in your shell history.",
        ),
    ] = None,
) -> None:
    """Create a user in the --org organisation."""

    async def _main() -> None:
        from logistics.auth import AuthRepo, Role

        try:
            parsed = Role(role.upper())
        except ValueError:
            typer.echo(f"Unknown role {role!r}. One of: {', '.join(r for r in Role)}")
            raise typer.Exit(1) from None

        instance = await _app()
        try:
            user = await AuthRepo(instance.db).create_user(
                org_id=current_org.get(), email=email,
                password=password, role=parsed, name=name,
            )
            await audit.record(
                instance.db, actor="cli", action=audit.Action.USER_CREATED,
                actor_type="SYSTEM", entity_type="user", entity_id=user.id,
                after={"email": user.email, "role": str(parsed)},
            )
        finally:
            await instance.aclose()
        typer.echo(f"Created {user.email} as {parsed} in '{_ORG}'.")

    _run(_main())


@app.command("reset-password")
def reset_password_cmd(
    email: Annotated[str, typer.Option("--email", prompt=True)],
    password: Annotated[
        str | None,
        typer.Option(
            "--password", prompt=True, hide_input=True, confirmation_prompt=True
        ),
    ] = None,
) -> None:
    """Set a new password. Every existing session for that user is revoked."""

    async def _main() -> None:
        from logistics.auth import AuthRepo

        instance = await _app()
        try:
            changed = await AuthRepo(instance.db).set_password(email, password)
            if changed:
                await audit.record(
                    instance.db, actor="cli", action=audit.Action.PASSWORD_RESET,
                    actor_type="SYSTEM", entity_type="user",
                    after={"email": email.strip().lower()},
                )
        finally:
            await instance.aclose()
        if not changed:
            typer.echo(f"No user with email {email!r}.")
            raise typer.Exit(1)
        typer.echo(f"Password changed for {email}. All sessions signed out.")

    _run(_main())


@app.command()
def users() -> None:
    """List the users in the --org organisation."""

    async def _main() -> None:
        from logistics.auth import AuthRepo

        instance = await _app()
        try:
            found = await AuthRepo(instance.db).list_users(current_org.get())
        finally:
            await instance.aclose()
        if not found:
            typer.echo(f"No users in '{_ORG}'. Create one with create-user.")
            return
        typer.echo(f"{'EMAIL':<34} {'ROLE':<11} NAME")
        for u in found:
            flag = "" if u.active else "  (disabled)"
            typer.echo(f"{u.email:<34} {u.role:<11} {u.name or '-'}{flag}")

    _run(_main())


def _slugify(name: str) -> str:
    import re

    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "org"


@app.command()
def tools(
    agent: Annotated[
        str | None,
        typer.Option("--agent", help="Show only what this agent may call."),
    ] = None,
) -> None:
    """What each agent is allowed to do, and what it costs when it does it."""
    from logistics.tools import AGENT_TOOLS, registry

    tiers = {0: "read", 1: "internal", 2: "external", 3: "SPEND"}

    if agent is not None:
        if agent not in AGENT_TOOLS:
            typer.echo(f"Unknown agent {agent!r}. One of: {', '.join(sorted(AGENT_TOOLS))}")
            raise typer.Exit(1)
        specs = registry.for_agent(agent)
        if not specs:
            typer.echo(f"{agent} has no tools. (The orchestrator routes work; it does not act.)")
            return
        typer.echo(f"\n{agent} may call {len(specs)} tool(s):\n")
        for spec in specs:
            typer.echo(f"  {spec.name:<24} {tiers[int(spec.tier)]:<9} {spec.description[:44]}")
            fields = ", ".join(spec.args.model_fields)
            typer.echo(f"  {'':<24} {'':<9} args: {fields or 'none'}")
        return

    typer.echo(f"\n{len(registry.names)} tools, {len(AGENT_TOOLS)} agents\n")
    typer.echo(f"  {'TOOL':<24} {'TIER':<9} {'AGENTS'}")
    for name in registry.names:
        spec = registry.get(name)
        allowed = sorted(a for a, t in AGENT_TOOLS.items() if name in t)
        typer.echo(f"  {name:<24} {tiers[int(spec.tier)]:<9} {', '.join(allowed)}")

    # A tool nobody may call is dead code; a permission naming no tool is a
    # typo that would otherwise surface as a puzzling failure at runtime.
    if orphans := registry.unreachable():
        typer.echo(f"\n  WARNING: granted to nobody: {', '.join(sorted(orphans))}")
    if missing := registry.undefined():
        typer.echo(f"\n  WARNING: granted but not defined: {', '.join(sorted(missing))}")

    typer.echo("\nSpend tools reach a human under the current policy. See: approvals\n")


@app.command("generate-key")
def generate_key_cmd() -> None:
    """Generate a CREDENTIALS_KEY for encrypting channel credentials."""
    from logistics.channels.crypto import generate_key

    typer.echo("\nAdd this to .env:\n")
    typer.echo(f"CREDENTIALS_KEY={generate_key()}\n")
    typer.echo(
        "Keep it safe. Changing it makes every stored channel credential\n"
        "unreadable and they will all need reconnecting."
    )


@app.command()
def channels() -> None:
    """Show how customers can currently reach your support agent."""

    async def _main() -> None:
        from logistics.channels.crypto import is_configured
        from logistics.channels.store import ChannelStore

        instance = await _app()
        try:
            if not is_configured():
                typer.echo(
                    "CREDENTIALS_KEY is not set — channels cannot be configured.\n"
                    "Run: python -m logistics.cli generate-key\n"
                )

            connections = await ChannelStore(instance.db).all()
            typer.echo(f"\n  {'CHANNEL':<10} {'STATE':<14} {'LIVE':<6} DETAIL")
            for c in connections:
                detail = (
                    c.config.get("username")
                    or c.config.get("address")
                    or c.config.get("phone_number")
                    or (", ".join(c.config.get("allowed_origins", [])) or "—")
                )
                typer.echo(
                    f"  {str(c.channel):<10} {str(c.state):<14}"
                    f" {'yes' if c.live else 'no':<6} {detail}"
                )
                if c.last_error:
                    typer.echo(f"             error: {c.last_error[:70]}")
            typer.echo("\nConfigure them at /settings on the dashboard.")
        finally:
            await instance.aclose()

    _run(_main())


@app.command()
def carriers() -> None:
    """List the fleet and who can actually be reached."""

    async def _main() -> None:
        from logistics.carriers.repo import CarrierRepo

        instance = await _app()
        try:
            async with instance.db.connection() as conn:
                cur = await conn.execute(
                    "SELECT code, name, integration, approved, active,"
                    "       telegram_chat_id, modes"
                    "  FROM carriers ORDER BY code"
                )
                rows = await cur.fetchall()

            if not rows:
                typer.echo("No carriers. Run: python -m logistics.cli seed-demo")
                return

            def reachability(row) -> str:  # noqa: ANN001
                if row["integration"] == "API":
                    return "yes"
                if row["integration"] == "TELEGRAM":
                    return "yes" if row["telegram_chat_id"] else "not onboarded"
                # EMAIL and MANUAL have no adapter at all — that is a different
                # thing from a Telegram carrier who simply has not pressed Start.
                return "no adapter"

            typer.echo(f"\n  {'CODE':<12} {'INTEGRATION':<11} {'REACHABLE':<14} NAME")
            for r in rows:
                typer.echo(
                    f"  {r['code']:<12} {r['integration']:<11}"
                    f" {reachability(r):<14} {r['name']}"
                )

            missing = [
                r["code"]
                for r in rows
                if r["integration"] == "TELEGRAM" and r["telegram_chat_id"] is None
            ]
            if missing:
                typer.echo(
                    "\nA Telegram bot cannot start a conversation. These carriers must"
                    "\nmessage the bot once (press Start) before they can be asked to quote:"
                )
                for code in missing:
                    typer.echo(f"  {code}")
                typer.echo("\nThen: python -m logistics.cli telegram-poll")
        finally:
            await instance.aclose()

    _run(_main())


@app.command("telegram-onboard")
def telegram_onboard(
    code: Annotated[str, typer.Argument(help="Carrier code, e.g. CARRIER-B")],
    wait: Annotated[int, typer.Option(help="Seconds to wait for a message")] = 120,
) -> None:
    """Attach the next inbound Telegram chat to a carrier.

    A bot cannot open a conversation, so a carrier has to message it first.
    Run this, then have them open the bot link and press Start.
    """

    async def _main() -> None:
        import asyncio

        from logistics.carriers.repo import CarrierRepo
        from logistics.carriers.telegram import HttpTransport, TelegramAdapter

        settings = get_settings()
        configure_logging(settings.log_level, settings.log_json)
        if not settings.has_telegram:
            typer.echo("TELEGRAM_BOT_TOKEN is not set.")
            raise typer.Exit(1)

        instance = await _app()
        transport = HttpTransport(settings.telegram_bot_token.get_secret_value())
        adapter = TelegramAdapter(transport)
        repo = CarrierRepo(instance.db)

        try:
            async with instance.db.connection() as conn:
                cur = await conn.execute(
                    "SELECT name, integration FROM carriers WHERE code = %s", (code,)
                )
                carrier = await cur.fetchone()
            if carrier is None:
                typer.echo(f"No carrier {code!r}. Try: python -m logistics.cli carriers")
                raise typer.Exit(1)

            me = await transport.call("getMe", {})
            link = f"https://t.me/{me.get('username', '')}"

            typer.echo(f"\nOnboarding {code} ({carrier['name']}).")
            typer.echo(f"Ask them to open {link} and press Start.")
            typer.echo(f"Waiting up to {wait}s…\n")

            deadline = asyncio.get_running_loop().time() + wait
            while asyncio.get_running_loop().time() < deadline:
                for message in await adapter.poll(timeout=10):
                    existing = await repo.by_telegram_chat(message.chat_id)
                    if existing is not None and existing.code != code:
                        typer.echo(
                            f"  chat {message.chat_id} already belongs to {existing.code}"
                        )
                        continue

                    await repo.onboard_telegram(
                        code=code, chat_id=message.chat_id, username=message.username
                    )
                    await adapter.send(
                        message.chat_id,
                        f"Thanks — {carrier['name']} is connected. "
                        "Quote requests will arrive here; reply with your price "
                        "in plain text.",
                    )
                    typer.echo(
                        f"  {code} onboarded: chat {message.chat_id}"
                        f" (@{message.username or '?'})"
                    )
                    return

            typer.echo("  Timed out. Nobody messaged the bot.")
        finally:
            await transport.aclose()
            await instance.aclose()

    _run(_main())


@app.command("telegram-poll")
def telegram_poll(
    once: Annotated[bool, typer.Option(help="One cycle then exit")] = False,
) -> None:
    """Long-poll Telegram: onboard carriers and parse their quote replies."""

    async def _main() -> None:
        from logistics.carriers.repo import CarrierRepo, QuoteRepo
        from logistics.carriers.telegram import HttpTransport, TelegramAdapter

        settings = get_settings()
        configure_logging(settings.log_level, settings.log_json)
        if not settings.telegram_bot_token:
            typer.echo(
                "TELEGRAM_BOT_TOKEN is not set.\n"
                "Create a bot with @BotFather, then put the token in .env."
            )
            raise typer.Exit(1)

        instance = await _app()
        transport = HttpTransport(settings.telegram_bot_token.get_secret_value())
        adapter = TelegramAdapter(transport)
        repo = CarrierRepo(instance.db)

        typer.echo("Polling Telegram. Ctrl-C to stop.")
        try:
            while True:
                for message in await adapter.poll():
                    carrier = await repo.by_telegram_chat(message.chat_id)

                    if carrier is None:
                        # An unknown chat. Show the id so it can be attached to
                        # a carrier record — this is the onboarding handshake.
                        typer.echo(
                            f"\n  unknown chat {message.chat_id}"
                            f" (@{message.username or '?'} {message.full_name or ''})"
                            f"\n  {message.text[:80]}"
                            f"\n  attach it with:  UPDATE carriers SET telegram_chat_id="
                            f"{message.chat_id} WHERE code='...';"
                        )
                        continue

                    typer.echo(f"\n  {carrier.code}: {message.text[:80]}")
                    if message.is_start:
                        await adapter.send(
                            message.chat_id,
                            f"Thanks {carrier.name} — you are connected. "
                            "You will receive quote requests here.",
                        )
                        continue

                    if instance.llm is None:
                        typer.echo("  (no model configured — cannot parse)")
                        continue

                    from logistics.carriers.parse import parse_reply

                    quote = await parse_reply(
                        instance.llm, message.text, carrier_id=carrier.id
                    )
                    typer.echo(
                        f"  → {quote.state}"
                        + (f"  {quote.price.format()}" if quote.price else "")
                        + (f"  confidence {quote.confidence:.2f}" if quote.confidence else "")
                    )
                if once:
                    return
        except KeyboardInterrupt:
            pass
        finally:
            await transport.aclose()
            await instance.aclose()

    _run(_main())


@app.command()
def quotes(reference: str) -> None:
    """Show the quotes gathered for a shipment."""

    async def _main() -> None:
        from logistics.carriers.repo import QuoteRepo

        instance = await _app()
        try:
            shipment = await instance.repo.get_by_reference(reference)
            if shipment is None:
                typer.echo(f"No shipment {reference!r}")
                raise typer.Exit(1)

            repo = QuoteRepo(instance.db)
            round_no = await repo.current_round(shipment.id)
            if round_no == 0:
                typer.echo("No sourcing rounds yet.")
                return

            rows = await repo.for_round(shipment.id, round_no)
            typer.echo(f"\n{reference}  round {round_no}  ({shipment.state})")
            typer.echo(f"\n  {'CARRIER':<12} {'STATE':<12} {'AMOUNT':>14}  SCORE  SOURCE")
            for r in rows:
                amount = (
                    f"NGN {int(r['amount_minor']) / 100:,.0f}"
                    if r["amount_minor"]
                    else "-"
                )
                score = f"{float(r['score']):.3f}" if r["score"] is not None else "  -  "
                typer.echo(
                    f"  {r['carrier_code']:<12} {r['state']:<12} {amount:>14}"
                    f"  {score}  {r['source']}"
                )
        finally:
            await instance.aclose()

    _run(_main())


@app.command()
def approvals() -> None:
    """List approvals waiting on a human."""

    async def _main() -> None:
        from logistics.approvals import ApprovalRepo

        instance = await _app()
        try:
            pending = await ApprovalRepo(instance.db).pending()
            if not pending:
                typer.echo("Nothing awaiting approval.")
                return
            for a in pending:
                amount = (
                    f"{a.currency} {a.amount_minor / 100:,.0f}"
                    if a.amount_minor
                    else "-"
                )
                typer.echo(f"\n  {amount}   expires {a.expires_at:%d %b %H:%M}")
                typer.echo(f"  {a.summary}")
                typer.echo(f"  approve: python -m logistics.cli approve {a.token}")
        finally:
            await instance.aclose()

    _run(_main())


@app.command()
def approve(
    token: str,
    by: Annotated[str, typer.Option(help="Who is approving")] = "cli",
    reject: Annotated[bool, typer.Option(help="Reject instead of approve")] = False,
    note: Annotated[str | None, typer.Option(help="Reason")] = None,
) -> None:
    """Approve or reject a pending action, then let the worker act on it."""

    async def _main() -> None:
        from logistics.approvals import ApprovalRepo
        from logistics.domain.models import WorkRequest

        instance = await _app()
        try:
            repo = ApprovalRepo(instance.db)
            decided = await repo.decide(token, approved=not reject, by=by, note=note)

            if decided is None:
                typer.echo(
                    "That token is not actionable — it may already have been used, "
                    "rejected, or expired."
                )
                raise typer.Exit(1)

            typer.echo(f"{decided.state}: {decided.summary}")

            async with instance.db.connection() as conn:
                cur = await conn.execute(
                    "SELECT params FROM proposed_actions WHERE id = %s",
                    (decided.proposed_action_id,),
                )
                row = await cur.fetchone()
            round_no = (row["params"] or {}).get("round", 1) if row else 1

            await instance.queue.enqueue(
                WorkRequest(
                    kind="approval.refused" if reject else "approval.granted",
                    shipment_id=decided.shipment_id,
                    payload={
                        "approval_id": str(decided.id),
                        "proposed_action_id": str(decided.proposed_action_id),
                        "decided_by": by,
                        "note": note,
                        "round": round_no,
                    },
                    priority=10,
                )
            )
            typer.echo("Queued. Run the worker to act on it:")
            typer.echo("  python -m logistics.cli worker")
        finally:
            await instance.aclose()

    _run(_main())


# ------------------------------------------------------- autonomy evidence


@app.command()
def autonomy(
    stability: Annotated[
        float | None,
        typer.Option(
            "--stability",
            help="Measured stability from `eval --repeats N`. Without it, "
                 "no cap can be recommended.",
        ),
    ] = None,
) -> None:
    """What raising a policy cap would currently be justified by.

    Reads the approvals humans have actually decided and reports the cap that
    evidence supports — usually none, and why.

    Stability is not read from the database because it is not a property of
    production data: it comes from replaying the agent against fixed cases, and
    a number computed hours ago against a different prompt would be worse than
    admitting it is unknown.
    """

    async def _main() -> None:
        from logistics.eval.agreement import (
            abandoned,
            by_action,
            gather_decisions,
            pending_backlog,
        )
        from logistics.eval.autonomy import (
            MIN_SAMPLES,
            TARGET_AGREEMENT,
            confidence_note,
            recommend,
        )

        instance = await _app()
        try:
            decisions = await gather_decisions(instance.db)
            backlog = await pending_backlog(instance.db)
            timed_out = await abandoned(instance.db)
            policy = await instance.policy.active()
        finally:
            await instance.aclose()

        rules = (policy[1] if policy else {}) or {}
        caps = {
            action: rule.get("auto_approve_below_minor")
            for action, rule in (rules.get("actions") or {}).items()
        }

        typer.echo("")
        typer.echo(f"  Evidence for raising a cap  (org: {_ORG})")
        typer.echo(f"  {'-' * 62}")
        typer.echo(f"  decided approvals : {len(decisions)}")
        typer.echo(f"  awaiting a human  : {backlog}")
        typer.echo(f"  timed out unread  : {timed_out}")
        typer.echo(f"  bar to clear      : {MIN_SAMPLES}+ decisions, lower bound "
                   f">= {TARGET_AGREEMENT:.0%}")
        typer.echo("")

        if timed_out:
            # Worth saying loudly. Each one is a shipment that stopped and
            # waited for a person who never came, and nothing else surfaces it.
            typer.echo(
                f"  {timed_out} approval(s) expired before anyone decided them."
            )
            typer.echo(
                "  Those are stalled shipments, and they are also why evidence"
            )
            typer.echo(
                "  accrues slowly: a cap can only be earned on decisions humans"
            )
            typer.echo("  actually make.")
            typer.echo("")

        if not decisions:
            typer.echo("  No human has decided an approval yet, so there is nothing")
            typer.echo("  to measure. Every cap stays at zero, which is correct.")
            typer.echo("")
            return

        if backlog > len(decisions):
            typer.echo(
                f"  Note: {backlog} approvals are still waiting against "
                f"{len(decisions)} decided."
            )
            typer.echo(
                "  The sample is biased as well as small — easy calls get decided"
            )
            typer.echo("  and hard ones sit, so agreement flatters the agent.")
            typer.echo("")

        for action, measured in by_action(decisions).items():
            typer.echo(
                "  "
                + recommend(
                    measured,
                    current_cap_minor=caps.get(action),
                    stability=stability,
                ).render().replace("\n", "\n  ")
            )
            for rejected in measured.rejected:
                typer.echo(
                    f"      rejected: {rejected.reference or '?'} — "
                    f"{rejected.policy_reason or 'no reason recorded'}"
                )
            typer.echo("")

        typer.echo(f"  {confidence_note()}")
        typer.echo("")

    _run(_main())


@app.command("eval")
def eval_cmd(
    repeats: Annotated[
        int, typer.Option("--repeats", help="Runs per case; >1 measures stability.")
    ] = 1,
    escalate: Annotated[
        bool, typer.Option("--escalate/--no-escalate",
                           help="Allow the Ultra escalation path.")
    ] = False,
    temperature: Annotated[
        float | None,
        typer.Option("--temperature",
                     help="Override the routed temperature, to test stability.")
    ] = None,
) -> None:
    """Replay the exception agent against the fixture corpus.

    Calls a model but touches nothing else: `investigate` and `plan_resolution`
    are pure, so a run cannot book, message, or change a shipment.
    """

    async def _main() -> None:
        from logistics.eval.cases import load
        from logistics.eval.replay import run as replay

        cases = load()
        if not cases:
            typer.echo("No cases in fixtures/eval/. Nothing to run.")
            raise typer.Exit(1)

        instance = await _app()
        if instance.llm is None:
            await instance.aclose()
            typer.echo("NVIDIA_API_KEY is not set, so there is no model to evaluate.")
            raise typer.Exit(1)

        typer.echo(
            f"\n  Replaying {len(cases)} case(s)"
            + (f" x {repeats}" if repeats > 1 else "")
            + " against the exception agent...\n"
        )
        try:
            card = await replay(
                instance.llm, cases, repeats=repeats,
                allow_escalation=escalate, temperature=temperature,
            )
        finally:
            await instance.aclose()

        typer.echo(f"  agreement with the corpus : {card.accuracy}")
        if card.unusable:
            typer.echo(
                f"  unusable answers          : {card.unusable} "
                "(provider or parsing, not judgement)"
            )

        calibration = card.calibration()
        if calibration:
            typer.echo("\n  Calibration — does stated confidence predict being right?")
            for label, proportion in calibration:
                typer.echo(f"    {label:<12} {proportion}")

        stability = card.stability()
        if stability:
            typer.echo("\n  Stability across repeats:")
            for case_id, rate in sorted(stability.items(), key=lambda kv: kv[1]):
                flag = "   <-- changes its mind" if rate < 1.0 else ""
                typer.echo(f"    {case_id:<24} {rate:.0%}{flag}")

        if card.failures:
            typer.echo("\n  Disagreements:")
            for outcome in card.failures:
                typer.echo(f"    {outcome.case_id}: {'; '.join(outcome.failures)}")
        typer.echo("")

    _run(_main())


@app.command("check-llm")
def check_llm() -> None:
    """Verify NIM connectivity and that the routed model answers."""

    async def _main() -> None:
        from logistics.llm.base import LLMRequest
        from logistics.llm.nvidia import NvidiaClient
        from logistics.llm.registry import Job, spec_for

        settings = get_settings()
        configure_logging(settings.log_level, settings.log_json)
        if not settings.has_llm:
            typer.echo("NVIDIA_API_KEY is not set.")
            raise typer.Exit(1)

        client = NvidiaClient(settings)
        question = "Where is my order LG-82931? Answer in one short sentence."
        try:
            # Two jobs, because the interesting thing to verify is that the
            # reasoning toggle actually differs between them.
            for job in (Job.CUSTOMER_CHAT, Job.ORDER_EXTRACTION):
                response = await client.complete(
                    LLMRequest(
                        job=job,
                        messages=[{"role": "user", "content": question}],
                        max_tokens=200,
                        agent="cli",
                    )
                )
                expected = "on" if spec_for(job).reasoning else "off"
                typer.echo(f"\n[{job}]  reasoning={expected}")
                typer.echo(f"  model:     {response.model}")
                typer.echo(f"  reply:     {response.text.strip()[:100]!r}")
                typer.echo(
                    f"  reasoning: {'present' if response.reasoning else 'none'}"
                )
                typer.echo(f"  truncated: {response.truncated}")
                typer.echo(
                    f"  latency:   {response.latency_ms} ms   "
                    f"tokens {response.prompt_tokens} in / {response.completion_tokens} out"
                )
        finally:
            await client.aclose()

    _run(_main())


if __name__ == "__main__":
    app()
