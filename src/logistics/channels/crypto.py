"""Credential encryption.

Channel credentials — a Telegram bot token, a WhatsApp access token, a Gmail
app password — move out of `.env` and into Postgres so Settings can manage
them. That is only acceptable if they are encrypted at rest: a database dump
should yield ciphertext and nothing else.

Fernet (AES-128-CBC + HMAC) from `cryptography`. The key lives in
`CREDENTIALS_KEY` and never in the database — storing both together would make
the encryption decorative.

**Fails closed.** With no key configured, saving a secret raises rather than
writing plaintext. A missing key is a configuration error, not a reason to
downgrade security silently.
"""

from __future__ import annotations

import json
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from logistics.config import get_settings


class CredentialsNotConfigured(Exception):
    """No CREDENTIALS_KEY. Refusing to store secrets in plaintext."""

    def __init__(self) -> None:
        super().__init__(
            "CREDENTIALS_KEY is not set, so channel credentials cannot be "
            "encrypted. Generate one with:\n"
            "  python -m logistics.cli generate-key\n"
            "and add it to .env. Secrets are never written unencrypted."
        )


class CredentialsUnreadable(Exception):
    """Ciphertext that will not decrypt with the configured key.

    Almost always a rotated or mismatched CREDENTIALS_KEY, which means every
    stored credential must be re-entered — worth saying plainly rather than
    surfacing as a generic decrypt error.
    """


def generate_key() -> str:
    """A new Fernet key, base64-encoded and ready to paste into .env."""
    return Fernet.generate_key().decode()


def _cipher() -> Fernet:
    settings = get_settings()
    if not settings.credentials_key:
        raise CredentialsNotConfigured
    try:
        return Fernet(settings.credentials_key.get_secret_value().encode())
    except (ValueError, TypeError) as exc:
        raise CredentialsUnreadable(
            f"CREDENTIALS_KEY is not a valid Fernet key: {exc}. "
            "Generate one with `python -m logistics.cli generate-key`."
        ) from exc


def encrypt(payload: dict[str, Any]) -> bytes:
    """Encrypt a credential dict for storage."""
    return _cipher().encrypt(json.dumps(payload).encode())


def decrypt(blob: bytes | memoryview | None) -> dict[str, Any]:
    """Decrypt stored credentials. Empty when nothing is stored."""
    if not blob:
        return {}
    try:
        return json.loads(_cipher().decrypt(bytes(blob)).decode())
    except InvalidToken as exc:
        raise CredentialsUnreadable(
            "Stored credentials could not be decrypted. CREDENTIALS_KEY has "
            "most likely changed — every channel will need reconnecting."
        ) from exc


def is_configured() -> bool:
    return get_settings().credentials_key is not None


def mask(value: str | None, *, keep: int = 4) -> str:
    """A recognisable stub for the UI. Never the secret itself."""
    if not value:
        return "—"
    if len(value) <= keep:
        return "•" * len(value)
    return "•" * (len(value) - keep) + value[-keep:]
