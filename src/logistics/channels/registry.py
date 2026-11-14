"""Provider lookup."""

from __future__ import annotations

from logistics.channels.base import ChannelKind, ChannelProvider
from logistics.channels.providers import (
    GmailProvider,
    TelegramProvider,
    WhatsAppProvider,
    WidgetProvider,
)

_PROVIDERS: dict[ChannelKind, ChannelProvider] = {
    ChannelKind.TELEGRAM: TelegramProvider(),
    ChannelKind.WHATSAPP: WhatsAppProvider(),
    ChannelKind.GMAIL: GmailProvider(),
    ChannelKind.WIDGET: WidgetProvider(),
}


def provider_for(kind: ChannelKind | str) -> ChannelProvider:
    key = ChannelKind(kind)
    provider = _PROVIDERS.get(key)
    if provider is None:  # pragma: no cover - the enum makes this unreachable
        raise ValueError(f"no provider for channel {kind!r}")
    return provider


def providers() -> list[ChannelProvider]:
    return list(_PROVIDERS.values())
