"""The four channel providers.

Each is thin on purpose: declare the fields, verify against the real service,
fetch, send. The interesting logic — matching a message to a shipment, drafting
the reply — is channel-agnostic and lives in `inbound.py` and `support.py`.
"""

from __future__ import annotations

import email
import imaplib
import smtplib
import ssl
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Any

from logistics.channels.base import (
    ChannelKind,
    CredentialField,
    Inbound,
    Outbound,
    VerifyResult,
)
from logistics.obs import get_logger

log = get_logger(__name__)


# --------------------------------------------------------------- Telegram


class TelegramProvider:
    kind = ChannelKind.TELEGRAM
    label = "Telegram"
    description = (
        "Customers message your bot. No business verification and no template "
        "approval — a token from @BotFather works immediately. The one limit: "
        "a bot cannot start a conversation, so the customer messages first."
    )
    fields = (
        CredentialField(
            key="bot_token",
            label="Bot token",
            secret=True,
            placeholder="123456:ABC-DEF…",
            help="From @BotFather on Telegram: /newbot, then copy the token.",
        ),
    )

    async def verify(
        self, credentials: dict[str, Any], config: dict[str, Any]
    ) -> VerifyResult:
        from logistics.carriers.telegram import HttpTransport, TelegramError

        token = (credentials.get("bot_token") or "").strip()
        if not token:
            return VerifyResult(False, "Enter your bot token.")

        transport = HttpTransport(token)
        try:
            me = await transport.call("getMe", {})
        except TelegramError as exc:
            return VerifyResult(
                False, f"Telegram rejected the token: {exc.description}"
            )
        except Exception as exc:  # noqa: BLE001
            return VerifyResult(False, f"Could not reach Telegram: {exc}")
        finally:
            await transport.aclose()

        username = me.get("username", "")
        return VerifyResult(
            True,
            f"Connected as @{username}. Share t.me/{username} with your customers.",
            config={
                "username": username,
                "bot_name": me.get("first_name"),
                "link": f"https://t.me/{username}",
            },
        )

    async def fetch(
        self, credentials: dict[str, Any], config: dict[str, Any], cursor: str | None
    ) -> tuple[list[Inbound], str | None]:
        from logistics.carriers.telegram import HttpTransport

        transport = HttpTransport(credentials["bot_token"])
        payload: dict[str, Any] = {"timeout": 0, "allowed_updates": ["message"]}
        if cursor:
            payload["offset"] = int(cursor)

        try:
            updates = await transport.call("getUpdates", payload)
        finally:
            await transport.aclose()

        messages: list[Inbound] = []
        offset = int(cursor) if cursor else None

        for update in updates or []:
            # Advance past everything seen, including shapes we ignore, or an
            # unhandled update is replayed forever.
            offset = update["update_id"] + 1
            message = update.get("message") or {}
            chat = message.get("chat") or {}
            text = message.get("text")
            if not text or chat.get("id") is None:
                continue

            sender = message.get("from") or {}
            messages.append(
                Inbound(
                    channel=self.kind,
                    external_id=str(chat["id"]),
                    text=text,
                    display_name=" ".join(
                        p for p in (sender.get("first_name"), sender.get("last_name")) if p
                    )
                    or sender.get("username"),
                    external_ref=str(update["update_id"]),
                    received_at=datetime.now(UTC),
                )
            )

        return messages, str(offset) if offset is not None else cursor

    async def send(
        self, credentials: dict[str, Any], config: dict[str, Any], message: Outbound
    ) -> bool:
        from logistics.carriers.telegram import HttpTransport, TelegramAdapter

        # Telegram chat ids are integers. A non-numeric external_id means the
        # contact came from somewhere else — a test fixture, a mis-routed
        # message — and is not reachable here.
        try:
            chat_id = int(message.external_id)
        except (TypeError, ValueError):
            log.warning("telegram.bad_chat_id", external_id=message.external_id)
            return False

        transport = HttpTransport(credentials["bot_token"])
        try:
            return await TelegramAdapter(transport).send(chat_id, message.text)
        finally:
            await transport.aclose()


# --------------------------------------------------------------- WhatsApp


class WhatsAppProvider:
    kind = ChannelKind.WHATSAPP
    label = "WhatsApp Business"
    description = (
        "Meta Cloud API. Replies within 24 hours of a customer message are "
        "free-form; anything outside that window needs a template Meta has "
        "approved, which has real lead time. Inbound arrives by webhook."
    )
    fields = (
        CredentialField(
            key="access_token",
            label="Access token",
            secret=True,
            help="Permanent token from your Meta app under WhatsApp → API Setup.",
        ),
        CredentialField(
            key="phone_number_id",
            label="Phone number ID",
            secret=False,
            placeholder="1234567890",
            help="Not the phone number itself — the numeric ID Meta assigns it.",
        ),
        CredentialField(
            key="verify_token",
            label="Webhook verify token",
            secret=True,
            required=False,
            help="Any string you choose. Meta echoes it when registering the webhook.",
        ),
    )

    API = "https://graph.facebook.com/v21.0"

    async def verify(
        self, credentials: dict[str, Any], config: dict[str, Any]
    ) -> VerifyResult:
        import httpx

        token = (credentials.get("access_token") or "").strip()
        number_id = (credentials.get("phone_number_id") or "").strip()
        if not token or not number_id:
            return VerifyResult(False, "Both the access token and phone number ID are required.")

        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.get(
                    f"{self.API}/{number_id}",
                    params={"fields": "display_phone_number,verified_name"},
                    headers={"Authorization": f"Bearer {token}"},
                )
        except Exception as exc:  # noqa: BLE001
            return VerifyResult(False, f"Could not reach Meta: {exc}")

        if response.status_code != 200:
            detail = response.json().get("error", {}).get("message", response.text[:120])
            return VerifyResult(False, f"Meta rejected the credentials: {detail}")

        body = response.json()
        number = body.get("display_phone_number", "")
        return VerifyResult(
            True,
            f"Connected to {number} ({body.get('verified_name', 'unverified')}).",
            config={
                "phone_number": number,
                "verified_name": body.get("verified_name"),
                "phone_number_id": number_id,
            },
        )

    async def fetch(
        self, credentials: dict[str, Any], config: dict[str, Any], cursor: str | None
    ) -> tuple[list[Inbound], str | None]:
        """WhatsApp pushes rather than polls, so there is nothing to fetch.

        Messages arrive at the webhook endpoint and are handed straight to
        `inbound.py`. Returning empty is correct, not a stub.
        """
        return [], cursor

    async def send(
        self, credentials: dict[str, Any], config: dict[str, Any], message: Outbound
    ) -> bool:
        import httpx

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{self.API}/{credentials['phone_number_id']}/messages",
                headers={"Authorization": f"Bearer {credentials['access_token']}"},
                json={
                    "messaging_product": "whatsapp",
                    "to": message.external_id,
                    "type": "text",
                    "text": {"body": message.text},
                },
            )
        if response.status_code >= 400:
            log.warning("whatsapp.send_failed", status=response.status_code)
            return False
        return True


# ------------------------------------------------------------------ Gmail


class GmailProvider:
    kind = ChannelKind.GMAIL
    label = "Support mailbox"
    description = (
        "Reads a Gmail inbox over IMAP and replies over SMTP. Uses a Google "
        "app password, so it works immediately — no Google Cloud project and "
        "no verification review. Requires 2-step verification on the account."
    )
    fields = (
        CredentialField(
            key="address",
            label="Email address",
            secret=False,
            placeholder="support@yourcompany.com",
        ),
        CredentialField(
            key="app_password",
            label="App password",
            secret=True,
            placeholder="abcd efgh ijkl mnop",
            help=(
                "Google Account → Security → 2-Step Verification → App passwords. "
                "Not your normal Google password."
            ),
        ),
    )

    IMAP_HOST = "imap.gmail.com"
    SMTP_HOST = "smtp.gmail.com"

    async def verify(
        self, credentials: dict[str, Any], config: dict[str, Any]
    ) -> VerifyResult:
        import asyncio

        address = (credentials.get("address") or "").strip()
        # Google prints app passwords in groups of four; people paste them that
        # way and IMAP rejects the spaces.
        password = (credentials.get("app_password") or "").replace(" ", "")
        if not address or not password:
            return VerifyResult(False, "Both the address and app password are required.")

        def _check() -> tuple[bool, str, int]:
            try:
                with imaplib.IMAP4_SSL(self.IMAP_HOST) as imap:
                    imap.login(address, password)
                    status, data = imap.select("INBOX", readonly=True)
                    count = int(data[0]) if status == "OK" and data and data[0] else 0
                    return True, "", count
            except imaplib.IMAP4.error as exc:
                return False, str(exc), 0
            except Exception as exc:  # noqa: BLE001
                return False, str(exc), 0

        ok, error, count = await asyncio.to_thread(_check)

        if not ok:
            hint = ""
            if "credentials" in error.lower() or "auth" in error.lower():
                hint = (
                    " Use an app password, not your normal Google password, and "
                    "make sure 2-step verification is on."
                )
            return VerifyResult(False, f"Gmail rejected the login: {error}.{hint}")

        return VerifyResult(
            True,
            f"Connected to {address}. {count} message(s) in the inbox.",
            config={"address": address},
        )

    async def fetch(
        self, credentials: dict[str, Any], config: dict[str, Any], cursor: str | None
    ) -> tuple[list[Inbound], str | None]:
        import asyncio

        address = credentials["address"]
        password = credentials["app_password"].replace(" ", "")
        since_uid = int(cursor) if cursor else 0

        def _read() -> tuple[list[Inbound], int]:
            found: list[Inbound] = []
            highest = since_uid
            with imaplib.IMAP4_SSL(self.IMAP_HOST) as imap:
                imap.login(address, password)
                imap.select("INBOX")
                # UID search, not sequence numbers: sequence numbers shift as
                # mail arrives and would skip or repeat messages.
                status, data = imap.uid("search", None, f"UID {since_uid + 1}:*")
                if status != "OK" or not data or not data[0]:
                    return found, highest

                for uid_bytes in data[0].split()[:25]:
                    uid = int(uid_bytes)
                    if uid <= since_uid:
                        continue
                    status, payload = imap.uid("fetch", str(uid), "(RFC822)")
                    if status != "OK" or not payload or not payload[0]:
                        continue

                    message = email.message_from_bytes(payload[0][1])
                    sender = parseaddr(message.get("From", ""))[1]
                    if not sender:
                        highest = max(highest, uid)
                        continue

                    found.append(
                        Inbound(
                            channel=ChannelKind.GMAIL,
                            external_id=sender.lower(),
                            text=_plain_text(message),
                            display_name=parseaddr(message.get("From", ""))[0] or sender,
                            subject=message.get("Subject", ""),
                            external_ref=message.get("Message-ID") or str(uid),
                            received_at=datetime.now(UTC),
                        )
                    )
                    highest = max(highest, uid)
            return found, highest

        try:
            messages, highest = await asyncio.to_thread(_read)
        except Exception as exc:  # noqa: BLE001
            log.warning("gmail.fetch_failed", error=str(exc))
            return [], cursor

        return messages, str(highest)

    async def send(
        self, credentials: dict[str, Any], config: dict[str, Any], message: Outbound
    ) -> bool:
        import asyncio

        address = credentials["address"]
        password = credentials["app_password"].replace(" ", "")

        def _send() -> bool:
            note = EmailMessage()
            note["From"] = address
            note["To"] = message.external_id
            note["Subject"] = message.subject or "Your shipment"
            if message.reply_to_ref:
                # Threads the reply under the customer's original mail.
                note["In-Reply-To"] = message.reply_to_ref
                note["References"] = message.reply_to_ref
            note.set_content(message.text)

            with smtplib.SMTP_SSL(
                self.SMTP_HOST, 465, context=ssl.create_default_context()
            ) as smtp:
                smtp.login(address, password)
                smtp.send_message(note)
            return True

        try:
            return await asyncio.to_thread(_send)
        except Exception as exc:  # noqa: BLE001
            log.warning("gmail.send_failed", error=str(exc))
            return False


def _plain_text(message: email.message.Message) -> str:
    """The readable body. Prefers text/plain; falls back to stripped HTML."""
    if message.is_multipart():
        for part in message.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    return payload.decode(part.get_content_charset() or "utf-8", "replace")
        for part in message.walk():
            if part.get_content_type() == "text/html":
                payload = part.get_payload(decode=True)
                if payload:
                    return _strip_html(
                        payload.decode(part.get_content_charset() or "utf-8", "replace")
                    )
        return ""

    payload = message.get_payload(decode=True)
    if not payload:
        return ""
    text = payload.decode(message.get_content_charset() or "utf-8", "replace")
    return _strip_html(text) if message.get_content_type() == "text/html" else text


def _strip_html(html: str) -> str:
    import re

    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


# ----------------------------------------------------------------- Widget


class WidgetProvider:
    kind = ChannelKind.WIDGET
    label = "Website widget"
    description = (
        "A chat bubble embedded on your own site. Customers ask without "
        "leaving your page, and messages arrive here like any other channel."
    )
    fields = (
        CredentialField(
            key="allowed_origins",
            label="Allowed website origins",
            secret=False,
            placeholder="https://yourcompany.com",
            help=(
                "Comma-separated. Only these sites may embed the widget — "
                "without this, anyone could point it at your data."
            ),
        ),
    )

    async def verify(
        self, credentials: dict[str, Any], config: dict[str, Any]
    ) -> VerifyResult:
        import secrets

        raw = (credentials.get("allowed_origins") or "").strip()
        if not raw:
            return VerifyResult(False, "Add at least one origin, e.g. https://yourcompany.com")

        origins = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
        bad = [o for o in origins if not o.startswith(("http://", "https://"))]
        if bad:
            return VerifyResult(
                False, f"Origins must include the scheme: {', '.join(bad)}"
            )

        # Reuse the existing site key so re-verifying does not invalidate a
        # snippet the operator has already pasted into their site.
        site_key = config.get("site_key") or f"lgw_{secrets.token_urlsafe(24)}"
        return VerifyResult(
            True,
            f"Widget ready for {len(origins)} origin(s). Copy the snippet below.",
            config={"allowed_origins": origins, "site_key": site_key},
        )

    async def fetch(
        self, credentials: dict[str, Any], config: dict[str, Any], cursor: str | None
    ) -> tuple[list[Inbound], str | None]:
        """The widget posts to the API; there is nothing to poll."""
        return [], cursor

    async def send(
        self, credentials: dict[str, Any], config: dict[str, Any], message: Outbound
    ) -> bool:
        """Replies are read by the widget polling its conversation, so writing
        the outbound row is the whole delivery step."""
        return True
