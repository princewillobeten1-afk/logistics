"""The channel contract.

A provider declares what it needs, proves it works, and turns whatever the
service sends into one shape. Nothing downstream — routing, the support agent,
the reply path — knows which channel a message came from.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, Protocol


class ChannelKind(StrEnum):
    TELEGRAM = "TELEGRAM"
    WHATSAPP = "WHATSAPP"
    GMAIL = "GMAIL"
    WIDGET = "WIDGET"


class ChannelStatus(StrEnum):
    UNCONFIGURED = "UNCONFIGURED"
    PENDING = "PENDING"
    VERIFIED = "VERIFIED"
    ERROR = "ERROR"


@dataclass(frozen=True, slots=True)
class CredentialField:
    """One input on the Settings form.

    `secret` decides both encryption and rendering: a secret field is stored in
    the encrypted blob and never sent back to the browser, only ever as a mask.
    """

    key: str
    label: str
    secret: bool = False
    required: bool = True
    placeholder: str = ""
    help: str = ""


@dataclass(frozen=True, slots=True)
class VerifyResult:
    ok: bool
    message: str
    """Shown to the operator. On failure this must say what to do about it."""
    config: dict[str, Any] = field(default_factory=dict)
    """Non-secret facts learned while verifying — a bot's username, a mailbox
    address. Stored so the dashboard can show what is connected."""


@dataclass(frozen=True, slots=True)
class Inbound:
    """A customer message, normalised."""

    channel: ChannelKind
    external_id: str
    """Stable identity on that channel: chat_id, wa_id, email address."""
    text: str
    display_name: str | None = None
    subject: str | None = None
    external_ref: str | None = None
    """The provider's own id, so a reply can thread and a message is not
    processed twice."""
    received_at: datetime | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Outbound:
    external_id: str
    text: str
    subject: str | None = None
    reply_to_ref: str | None = None


class ChannelProvider(Protocol):
    kind: ChannelKind
    label: str
    description: str
    fields: tuple[CredentialField, ...]

    async def verify(
        self, credentials: dict[str, Any], config: dict[str, Any]
    ) -> VerifyResult:
        """Prove the credentials work against the real service."""
        ...

    async def fetch(
        self, credentials: dict[str, Any], config: dict[str, Any], cursor: str | None
    ) -> tuple[list[Inbound], str | None]:
        """New messages, and the cursor to resume from."""
        ...

    async def send(
        self, credentials: dict[str, Any], config: dict[str, Any], message: Outbound
    ) -> bool:
        """Reply on this channel."""
        ...
