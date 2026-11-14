"""Inbound channels.

How customers reach the operator. They never see the dashboard — they message
a Telegram bot, a WhatsApp number, a support mailbox, or a widget on the
operator's own site, and the support agent answers on whichever one they used.

Each provider does three things: describe what it needs to be configured,
verify those credentials against the real service, and normalise whatever
arrives into an `Inbound`. Everything downstream is channel-agnostic.
"""

from logistics.channels.base import (
    ChannelKind,
    ChannelProvider,
    ChannelStatus,
    CredentialField,
    Inbound,
    Outbound,
    VerifyResult,
)
from logistics.channels.registry import provider_for, providers
from logistics.channels.store import ChannelStore, Connection

__all__ = [
    "ChannelKind",
    "ChannelProvider",
    "ChannelStatus",
    "ChannelStore",
    "Connection",
    "CredentialField",
    "Inbound",
    "Outbound",
    "VerifyResult",
    "provider_for",
    "providers",
]
