"""Channel connection storage.

Secrets are encrypted on the way in and decrypted only where they are used.
`Connection` — the shape the dashboard renders — deliberately has no field
that can hold a plaintext secret, so a template cannot accidentally print one.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from psycopg.types.json import Jsonb

from logistics.channels.base import ChannelKind, ChannelStatus, Inbound
from logistics.channels.crypto import decrypt, encrypt, is_configured, mask
from logistics.channels.registry import provider_for
from logistics.db import Database
from logistics.obs import get_logger

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class Connection:
    """Safe to render. Carries masks, never secrets."""

    channel: ChannelKind
    display_name: str
    state: ChannelStatus
    enabled: bool
    config: dict[str, Any] = field(default_factory=dict)
    masked: dict[str, str] = field(default_factory=dict)
    verified_at: datetime | None = None
    last_inbound_at: datetime | None = None
    last_error: str | None = None
    cursor: str | None = None

    @property
    def live(self) -> bool:
        return self.enabled and self.state is ChannelStatus.VERIFIED


# What every organisation starts with: the four channels, unconfigured, so
# Settings has something to render and connecting one is an UPDATE rather than
# a decision about what exists. Migration 010 seeded these for the single org
# that existed then; every org created since gets them from here.
DEFAULT_CHANNELS = (
    (ChannelKind.TELEGRAM, "Telegram bot"),
    (ChannelKind.WHATSAPP, "WhatsApp Business"),
    (ChannelKind.GMAIL, "Support mailbox"),
    (ChannelKind.WIDGET, "Website widget"),
)


async def seed_channels(db: Database) -> int:
    """Give the current organisation its four unconfigured channels."""
    created = 0
    async with db.transaction() as conn:
        for kind, label in DEFAULT_CHANNELS:
            cur = await conn.execute(
                "INSERT INTO channel_connections (channel, display_name)"
                " VALUES (%s, %s) ON CONFLICT (org_id, channel) DO NOTHING",
                (str(kind), label),
            )
            created += cur.rowcount
    return created


class ChannelStore:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def all(self) -> list[Connection]:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT channel, display_name, config, credentials, state, enabled,"
                "       verified_at, last_inbound_at, last_error, cursor"
                "  FROM channel_connections ORDER BY channel"
            )
            rows = await cur.fetchall()
        return [self._to_connection(r) for r in rows]

    async def get(self, channel: ChannelKind | str) -> Connection | None:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT channel, display_name, config, credentials, state, enabled,"
                "       verified_at, last_inbound_at, last_error, cursor"
                "  FROM channel_connections WHERE channel = %s",
                (str(ChannelKind(channel)),),
            )
            row = await cur.fetchone()
        return self._to_connection(row) if row else None

    async def credentials(self, channel: ChannelKind | str) -> dict[str, Any]:
        """Decrypted secrets. Only for code that is about to use them."""
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT credentials, config FROM channel_connections WHERE channel = %s",
                (str(ChannelKind(channel)),),
            )
            row = await cur.fetchone()
        if row is None:
            return {}
        # Non-secret config travels alongside so callers get one dict.
        return {**(row["config"] or {}), **decrypt(row["credentials"])}

    async def save(
        self, channel: ChannelKind | str, submitted: dict[str, Any]
    ) -> tuple[bool, str]:
        """Verify against the real service, then store. Never stores unverified
        credentials as live — a channel that cannot connect must not look
        connected."""
        kind = ChannelKind(channel)
        provider = provider_for(kind)

        if not is_configured():
            from logistics.channels.crypto import CredentialsNotConfigured

            raise CredentialsNotConfigured

        existing = await self.credentials(kind)
        current = await self.get(kind)

        # Blank secret fields mean "keep what is stored", so an operator can
        # edit a phone number without re-pasting a token.
        merged = dict(existing)
        for field_spec in provider.fields:
            value = submitted.get(field_spec.key)
            if value is None or (field_spec.secret and not str(value).strip()):
                continue
            merged[field_spec.key] = str(value).strip()

        missing = [
            f.label for f in provider.fields if f.required and not merged.get(f.key)
        ]
        if missing:
            return False, f"Required: {', '.join(missing)}"

        result = await provider.verify(merged, (current.config if current else {}))

        secret_keys = {f.key for f in provider.fields if f.secret}
        secrets_only = {k: v for k, v in merged.items() if k in secret_keys}
        config = {
            **{k: v for k, v in merged.items() if k not in secret_keys},
            **result.config,
        }

        async with self._db.connection() as conn:
            await conn.execute(
                """
                UPDATE channel_connections
                   SET credentials = %s,
                       config = %s,
                       state = %s,
                       verified_at = CASE WHEN %s THEN now() ELSE verified_at END,
                       last_error = %s,
                       enabled = CASE WHEN %s THEN enabled ELSE false END
                 WHERE channel = %s
                """,
                (
                    encrypt(secrets_only),
                    Jsonb(config),
                    str(ChannelStatus.VERIFIED if result.ok else ChannelStatus.ERROR),
                    result.ok,
                    None if result.ok else result.message,
                    result.ok,
                    str(kind),
                ),
            )

        log.info("channel.saved", channel=str(kind), ok=result.ok)
        return result.ok, result.message

    async def set_enabled(self, channel: ChannelKind | str, enabled: bool) -> tuple[bool, str]:
        kind = ChannelKind(channel)
        connection = await self.get(kind)
        if connection is None:
            return False, "Unknown channel."
        if enabled and connection.state is not ChannelStatus.VERIFIED:
            # The CHECK constraint would reject this anyway; saying why is
            # more use than surfacing a constraint violation.
            return False, "Connect and verify the channel before enabling it."

        async with self._db.connection() as conn:
            await conn.execute(
                "UPDATE channel_connections SET enabled = %s WHERE channel = %s",
                (enabled, str(kind)),
            )
        return True, "Enabled." if enabled else "Disabled."

    async def disconnect(self, channel: ChannelKind | str) -> None:
        """Forget the credentials entirely."""
        async with self._db.connection() as conn:
            await conn.execute(
                """
                UPDATE channel_connections
                   SET credentials = NULL, config = '{}'::jsonb, enabled = false,
                       state = 'UNCONFIGURED', verified_at = NULL,
                       last_error = NULL, cursor = NULL
                 WHERE channel = %s
                """,
                (str(ChannelKind(channel)),),
            )
        log.info("channel.disconnected", channel=str(channel))

    async def record_cursor(self, channel: ChannelKind | str, cursor: str | None) -> None:
        async with self._db.connection() as conn:
            await conn.execute(
                "UPDATE channel_connections SET cursor = %s, last_inbound_at = now()"
                " WHERE channel = %s",
                (cursor, str(ChannelKind(channel))),
            )

    async def record_error(self, channel: ChannelKind | str, error: str) -> None:
        """Record a runtime failure — a send that bounced, a fetch that timed out.

        Deliberately does NOT change `state`. A failed message is not a
        misconfigured channel, and marking it ERROR while it is enabled
        violates `channel_connections_enabled_is_verified`. Configuration
        failures are handled in `save()`, which is the only place that has
        actually re-verified the credentials.
        """
        async with self._db.connection() as conn:
            await conn.execute(
                "UPDATE channel_connections SET last_error = %s WHERE channel = %s",
                (error[:1000], str(ChannelKind(channel))),
            )

    async def record_config_failure(self, channel: ChannelKind | str, error: str) -> None:
        """Mark a channel unusable. Disables it in the same statement, because
        the constraint will not allow an enabled channel to sit in ERROR."""
        async with self._db.connection() as conn:
            await conn.execute(
                "UPDATE channel_connections"
                "   SET last_error = %s, state = 'ERROR', enabled = false"
                " WHERE channel = %s",
                (error[:1000], str(ChannelKind(channel))),
            )

    # ----------------------------------------------------------- internals

    def _to_connection(self, row: dict[str, Any]) -> Connection:
        kind = ChannelKind(row["channel"])
        provider = provider_for(kind)

        masked: dict[str, str] = {}
        if row["credentials"]:
            try:
                stored = decrypt(row["credentials"])
                for spec in provider.fields:
                    if spec.secret and stored.get(spec.key):
                        masked[spec.key] = mask(str(stored[spec.key]))
            except Exception:  # noqa: BLE001
                # An unreadable blob must not break the settings page — that is
                # exactly when an operator needs to see the error and reconnect.
                masked = {"error": "unreadable"}

        return Connection(
            channel=kind,
            display_name=row["display_name"] or provider.label,
            state=ChannelStatus(row["state"]),
            enabled=row["enabled"],
            config=row["config"] or {},
            masked=masked,
            verified_at=row["verified_at"],
            last_inbound_at=row["last_inbound_at"],
            last_error=row["last_error"],
            cursor=row["cursor"],
        )
