"""channels.configure — apply a channel change requested from Settings.

The dashboard writes an intent; this does the work. Credential encryption, the
Fernet key and provider verification all live on the Python side, so the
security-critical half of this feature has exactly one implementation.
"""

from __future__ import annotations

from logistics.channels.base import ChannelKind
from logistics.channels.crypto import CredentialsNotConfigured
from logistics.channels.store import ChannelStore
from logistics.domain.models import StepResult
from logistics.handlers.base import PermanentFailure, StepContext, handler


@handler("channels.configure")
async def configure(ctx: StepContext) -> StepResult:
    payload = ctx.item.payload
    raw_channel = payload.get("channel")
    action = payload.get("action", "save")

    if not raw_channel:
        raise PermanentFailure("channels.configure requires a channel")

    try:
        channel = ChannelKind(raw_channel)
    except ValueError as exc:
        raise PermanentFailure(f"unknown channel {raw_channel!r}") from exc

    store = ChannelStore(ctx.db)

    if action == "disconnect":
        await store.disconnect(channel)
        ctx.log.info("channel.disconnected", channel=str(channel))
        return StepResult()

    if action in ("enable", "disable"):
        ok, message = await store.set_enabled(channel, action == "enable")
        ctx.log.info("channel.toggled", channel=str(channel), ok=ok, message=message)
        if not ok:
            await store.record_error(channel, message)
        return StepResult()

    try:
        ok, message = await store.save(channel, payload.get("fields") or {})
    except CredentialsNotConfigured as exc:
        # Not retryable: no amount of waiting produces a CREDENTIALS_KEY. The
        # message tells the operator exactly what to run.
        await store.record_config_failure(channel, str(exc))
        raise PermanentFailure(str(exc)) from exc

    ctx.log.info("channel.configured", channel=str(channel), ok=ok, message=message)
    if not ok:
        # Recorded on the connection so Settings can show it; the step itself
        # succeeded — bad credentials are an answer, not a failure to run.
        # `save()` has already set state and disabled it.
        await store.record_error(channel, message)

    return StepResult()
