"""Carrier and quote persistence."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from logistics.carriers.adapter import CarrierRef, Quote, QuoteState
from logistics.carriers.scoring import CarrierSignals
from logistics.db import Database
from logistics.domain.money import Money
from logistics.obs import get_logger

log = get_logger(__name__)


def _f(value: Any) -> float | None:
    return None if value is None else float(value)


class CarrierRepo:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def eligible(self, mode: str, *, approved_only: bool = False) -> list[CarrierRef]:
        """Carriers that can run this mode and can actually be reached.

        A Telegram carrier without a chat_id is filtered out here rather than
        failing at send time — the bot cannot open a conversation, so an
        un-onboarded carrier is simply not a candidate.
        """
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                SELECT id, code, name, integration, telegram_chat_id, api_config, approved
                  FROM carriers
                 WHERE active
                   AND %s = ANY(modes)
                   AND (integration = 'API'
                        OR (integration = 'TELEGRAM' AND telegram_chat_id IS NOT NULL))
                   AND (NOT %s OR approved)
                 ORDER BY approved DESC, code
                """,
                (mode, approved_only),
            )
            rows = await cur.fetchall()

        return [
            CarrierRef(
                id=r["id"],
                code=r["code"],
                name=r["name"],
                integration=r["integration"],
                telegram_chat_id=r["telegram_chat_id"],
                api_config=r["api_config"] or {},
            )
            for r in rows
        ]

    async def get(self, carrier_id: UUID) -> CarrierRef | None:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT id, code, name, integration, telegram_chat_id, api_config"
                "  FROM carriers WHERE id = %s",
                (carrier_id,),
            )
            row = await cur.fetchone()
        if row is None:
            return None
        return CarrierRef(
            id=row["id"], code=row["code"], name=row["name"],
            integration=row["integration"], telegram_chat_id=row["telegram_chat_id"],
            api_config=row["api_config"] or {},
        )

    async def by_telegram_chat(self, chat_id: int) -> CarrierRef | None:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT id, code, name, integration, telegram_chat_id, api_config"
                "  FROM carriers WHERE telegram_chat_id = %s",
                (chat_id,),
            )
            row = await cur.fetchone()
        if row is None:
            return None
        return CarrierRef(
            id=row["id"], code=row["code"], name=row["name"],
            integration=row["integration"], telegram_chat_id=row["telegram_chat_id"],
            api_config=row["api_config"] or {},
        )

    async def onboard_telegram(
        self, *, code: str, chat_id: int, username: str | None
    ) -> bool:
        """Record the chat_id captured from a carrier's first message."""
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                UPDATE carriers
                   SET telegram_chat_id = %s, telegram_username = %s,
                       onboarded_at = COALESCE(onboarded_at, now())
                 WHERE code = %s
                RETURNING id
                """,
                (chat_id, username, code),
            )
            return await cur.fetchone() is not None

    async def signals(self) -> dict[UUID, CarrierSignals]:
        """Overall performance per carrier — the non-cost 70% of the score."""
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                SELECT c.id, c.code, p.on_time_rate, p.damage_rate,
                       p.availability_rate, p.service_score, p.shipments_count
                  FROM carriers c
                  LEFT JOIN carrier_performance p
                         ON p.carrier_id = c.id
                        AND p.origin_region IS NULL
                        AND p.destination_region IS NULL
                        AND p.mode IS NULL
                """
            )
            rows = await cur.fetchall()

        return {
            r["id"]: CarrierSignals(
                carrier_id=r["id"],
                code=r["code"],
                on_time_rate=_f(r["on_time_rate"]),
                damage_rate=_f(r["damage_rate"]),
                availability_rate=_f(r["availability_rate"]),
                service_score=_f(r["service_score"]),
                shipments_count=r["shipments_count"],
            )
            for r in rows
        }


class QuoteRepo:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def current_round(self, shipment_id: UUID) -> int:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "SELECT COALESCE(MAX(round), 0) AS r FROM quotes WHERE shipment_id = %s",
                (shipment_id,),
            )
            row = await cur.fetchone()
        return int(row["r"]) if row else 0

    async def request(
        self, *, shipment_id: UUID, carrier_id: UUID, round: int, source: str,
        leg_id: UUID | None = None,
    ) -> UUID | None:
        """Record that we asked. Created on the ask, not on the answer, so a
        carrier who never replies is visible as an unanswered request."""
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                INSERT INTO quotes (shipment_id, carrier_id, leg_id, round, source, state)
                VALUES (%s, %s, %s, %s, %s, 'REQUESTED')
                ON CONFLICT (shipment_id, carrier_id, round) DO NOTHING
                RETURNING id
                """,
                (shipment_id, carrier_id, leg_id, round, source),
            )
            row = await cur.fetchone()
        return row["id"] if row else None

    async def record(
        self, *, shipment_id: UUID, round: int, quote: Quote, source: str
    ) -> UUID | None:
        """Store an answer. Upserts, so a carrier replying twice in one round
        revises its quote rather than getting two entries in the comparison."""
        price = quote.price
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                INSERT INTO quotes
                    (shipment_id, carrier_id, round, source, state, amount_minor,
                     currency, transit_hours, valid_until, confidence, raw_text,
                     parsed_by, responded_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (shipment_id, carrier_id, round) DO UPDATE SET
                    state = EXCLUDED.state,
                    amount_minor = EXCLUDED.amount_minor,
                    currency = EXCLUDED.currency,
                    transit_hours = EXCLUDED.transit_hours,
                    valid_until = EXCLUDED.valid_until,
                    confidence = EXCLUDED.confidence,
                    raw_text = EXCLUDED.raw_text,
                    parsed_by = EXCLUDED.parsed_by,
                    responded_at = now()
                RETURNING id
                """,
                (
                    shipment_id,
                    quote.carrier_id,
                    round,
                    source,
                    str(quote.state),
                    price.amount_minor if price else None,
                    price.currency if price else None,
                    quote.transit_hours,
                    quote.valid_until,
                    quote.confidence,
                    quote.raw_text,
                    quote.parsed_by,
                ),
            )
            row = await cur.fetchone()
        return row["id"] if row else None

    async def for_round(self, shipment_id: UUID, round: int) -> list[dict[str, Any]]:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                SELECT q.id, q.carrier_id, q.state, q.amount_minor, q.currency,
                       q.transit_hours, q.valid_until, q.confidence, q.raw_text,
                       q.parsed_by, q.source, q.score, c.code AS carrier_code,
                       c.name AS carrier_name
                  FROM quotes q JOIN carriers c ON c.id = q.carrier_id
                 WHERE q.shipment_id = %s AND q.round = %s
                 ORDER BY q.score DESC NULLS LAST, q.amount_minor
                """,
                (shipment_id, round),
            )
            return list(await cur.fetchall())

    async def usable(self, shipment_id: UUID, round: int) -> list[Quote]:
        rows = await self.for_round(shipment_id, round)
        return [
            Quote(
                carrier_id=r["carrier_id"],
                state=QuoteState(r["state"]),
                price=(
                    Money(int(r["amount_minor"]), r["currency"])
                    if r["amount_minor"] is not None and r["currency"]
                    else None
                ),
                transit_hours=_f(r["transit_hours"]),
                valid_until=r["valid_until"],
                confidence=_f(r["confidence"]),
                raw_text=r["raw_text"],
                parsed_by=r["parsed_by"],
            )
            for r in rows
            if r["state"] == "RECEIVED"
        ]

    async def save_score(
        self, shipment_id: UUID, carrier_id: UUID, round: int,
        score: float, breakdown: dict[str, Any],
    ) -> None:
        async with self._db.connection() as conn:
            await conn.execute(
                "UPDATE quotes SET score = %s, score_breakdown = %s"
                " WHERE shipment_id = %s AND carrier_id = %s AND round = %s",
                (score, Jsonb(breakdown), shipment_id, carrier_id, round),
            )

    async def select(self, shipment_id: UUID, carrier_id: UUID, round: int) -> None:
        """Mark the winner and reject the rest, so the comparison is a record
        rather than something to reconstruct later."""
        async with self._db.connection() as conn:
            await conn.execute(
                "UPDATE quotes SET state = 'REJECTED'"
                " WHERE shipment_id = %s AND round = %s AND state = 'RECEIVED'"
                "   AND carrier_id <> %s",
                (shipment_id, round, carrier_id),
            )
            await conn.execute(
                "UPDATE quotes SET state = 'SELECTED'"
                " WHERE shipment_id = %s AND round = %s AND carrier_id = %s",
                (shipment_id, round, carrier_id),
            )

    async def expire_outstanding(self, shipment_id: UUID, round: int) -> int:
        """Close the window on carriers who never answered."""
        async with self._db.connection() as conn:
            cur = await conn.execute(
                "UPDATE quotes SET state = 'EXPIRED'"
                " WHERE shipment_id = %s AND round = %s AND state = 'REQUESTED'"
                " RETURNING id",
                (shipment_id, round),
            )
            return len(await cur.fetchall())

    async def selected(self, shipment_id: UUID, round: int) -> dict[str, Any] | None:
        async with self._db.connection() as conn:
            cur = await conn.execute(
                """
                SELECT q.id, q.carrier_id, q.amount_minor, q.currency, q.transit_hours,
                       c.code AS carrier_code, c.name AS carrier_name, c.integration
                  FROM quotes q JOIN carriers c ON c.id = q.carrier_id
                 WHERE q.shipment_id = %s AND q.round = %s AND q.state = 'SELECTED'
                """,
                (shipment_id, round),
            )
            return await cur.fetchone()
