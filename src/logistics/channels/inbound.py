"""Inbound routing.

Turns a message from any channel into a conversation about a shipment. The
hard part is not the transport — it is that a customer writes "where's my
order?" with no reference at all.

Three ways to resolve it, cheapest first:

  1. A reference in the text. A regex, not a model.
  2. The contact's last shipment. Someone who asked about LG-82931 an hour ago
     is almost certainly still asking about LG-82931.
  3. Their email address matched to a customer with exactly one open shipment.

If none work, the agent asks which shipment — which is the honest answer, and
far better than guessing and confidently describing the wrong one.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from logistics.channels.base import ChannelKind, Inbound
from logistics.db import Database
from logistics.obs import get_logger

log = get_logger(__name__)

# Shipment references look like LG-82931 / DEMO-001 / SIM-LATE or 6-9 digit
# WPCargo tracking numbers like 0576420. Deliberately loose on the suffix and
# strict on the shape, so ordinary words and 10-11 digit phone numbers do not match.
REFERENCE_PATTERN = re.compile(
    r"\b([A-Z]{2,6}-[A-Z0-9]{2,10}|\d{6,9})\b", re.IGNORECASE
)

ASK_FOR_REFERENCE = (
    "Thanks for getting in touch. Could you send your shipment reference — it "
    "looks like LG-12345 — and I'll pull up the details right away?"
)


@dataclass(frozen=True, slots=True)
class Routed:
    contact_id: UUID
    communication_id: UUID
    shipment_id: UUID | None
    reference: str | None
    needs_reference: bool


def extract_reference(text: str) -> str | None:
    """First reference-shaped token in the message."""
    match = REFERENCE_PATTERN.search(text or "")
    return match.group(1).upper() if match else None


class InboundRouter:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def route(self, message: Inbound) -> Routed | None:
        """Record the message and work out what it is about.

        Returns None when the message is a duplicate the provider re-delivered.
        """
        contact_id, last_shipment_id = await self._upsert_contact(message)

        if await self._already_seen(message):
            log.info("inbound.duplicate", channel=str(message.channel))
            return None

        shipment_id, reference = await self._resolve_shipment(
            message, last_shipment_id
        )

        communication_id = await self._record(message, contact_id, shipment_id)

        if shipment_id is not None:
            await self._remember_shipment(contact_id, shipment_id)

        return Routed(
            contact_id=contact_id,
            communication_id=communication_id,
            shipment_id=shipment_id,
            reference=reference,
            needs_reference=shipment_id is None,
        )

    # ----------------------------------------------------------- internals

    async def _upsert_contact(self, message: Inbound) -> tuple[UUID, UUID | None]:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                INSERT INTO channel_contacts (channel, external_id, display_name)
                VALUES (%s, %s, %s)
                ON CONFLICT (org_id, channel, external_id) DO UPDATE
                    SET last_seen_at = now(),
                        display_name = COALESCE(EXCLUDED.display_name,
                                                channel_contacts.display_name)
                RETURNING id, last_shipment_id
                """,
                (str(message.channel), message.external_id, message.display_name),
            )
            row = await cur.fetchone()
        return row["id"], row["last_shipment_id"]

    async def _already_seen(self, message: Inbound) -> bool:
        """Providers redeliver. A webhook retry must not produce two replies."""
        if not message.external_ref:
            return False
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT 1 FROM communications"
                " WHERE external_ref = %s AND direction = 'INBOUND' LIMIT 1",
                (message.external_ref,),
            )
            return await cur.fetchone() is not None

    async def _resolve_shipment(
        self, message: Inbound, last_shipment_id: UUID | None
    ) -> tuple[UUID | None, str | None]:
        haystack = f"{message.subject or ''} {message.text or ''}"

        if reference := extract_reference(haystack):
            async with self._db.connection() as conn:
                cur = await conn.execute(
                    "SELECT id, reference FROM shipments WHERE upper(reference) = %s",
                    (reference,),
                )
                row = await cur.fetchone()
            if row:
                return row["id"], row["reference"]
            # A reference that does not exist is worth distinguishing from no
            # reference at all — the customer may have mistyped it.
            log.info("inbound.unknown_reference", reference=reference)

        if last_shipment_id is not None:
            async with self._db.connection() as conn:
                cur = await conn.execute(
                    "SELECT id, reference FROM shipments WHERE id = %s",
                    (last_shipment_id,),
                )
                row = await cur.fetchone()
            if row:
                return row["id"], row["reference"]

        # Email only: an address we know, with exactly one shipment still open.
        # "Exactly one" matters — with two, guessing is worse than asking.
        if message.channel is ChannelKind.GMAIL:
            async with self._db.connection() as conn:
                cur = await conn.execute(
                    """
                    SELECT s.id, s.reference
                      FROM shipments s
                      JOIN customers c ON c.id = s.customer_id
                     WHERE s.state NOT IN ('CLOSED', 'CANCELLED', 'FAILED')
                       AND c.contacts::text ILIKE %s
                     LIMIT 2
                    """,
                    (f"%{message.external_id}%",),
                )
                rows = await cur.fetchall()
            if len(rows) == 1:
                return rows[0]["id"], rows[0]["reference"]

        return None, None

    async def _record(
        self, message: Inbound, contact_id: UUID, shipment_id: UUID | None
    ) -> UUID:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                INSERT INTO communications
                    (shipment_id, contact_id, channel, direction, body, subject,
                     recipient, state, external_ref, safety_checked)
                VALUES (%s, %s, %s, 'INBOUND', %s, %s, %s, 'RECEIVED', %s, false)
                RETURNING id
                """,
                (
                    shipment_id,
                    contact_id,
                    str(message.channel),
                    message.text,
                    message.subject,
                    message.external_id,
                    message.external_ref,
                ),
            )
            row = await cur.fetchone()
        return row["id"]

    async def _remember_shipment(self, contact_id: UUID, shipment_id: UUID) -> None:
        async with self._db.connection() as conn:
            await conn.execute(
                "UPDATE channel_contacts SET last_shipment_id = %s WHERE id = %s",
                (shipment_id, contact_id),
            )


async def record_outbound(
    db: Database,
    *,
    contact_id: UUID | None,
    shipment_id: UUID | None,
    channel: ChannelKind | str,
    text: str,
    subject: str | None = None,
    recipient: str | None = None,
    delivered: bool,
) -> UUID:
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            INSERT INTO communications
                (shipment_id, contact_id, channel, direction, body, subject,
                 recipient, state, template, sent_at)
            VALUES (%s, %s, %s, 'OUTBOUND', %s, %s, %s, %s, 'support.reply',
                    CASE WHEN %s THEN now() ELSE NULL END)
            RETURNING id
            """,
            (
                shipment_id,
                contact_id,
                str(channel),
                text,
                subject,
                recipient,
                "SENT" if delivered else "FAILED",
                delivered,
            ),
        )
        row = await cur.fetchone()
    return row["id"]


async def contact_for(db: Database, contact_id: UUID) -> dict[str, Any] | None:
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id, channel, external_id, display_name, last_shipment_id"
            "  FROM channel_contacts WHERE id = %s",
            (contact_id,),
        )
        return await cur.fetchone()
