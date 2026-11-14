"""The case file.

Everything the agent needs to reason about an exception, assembled by SQL and
arithmetic. No model runs here — gathering facts is not a judgment, and doing
it deterministically means the same exception always produces the same case
file, which is what makes the agent's decisions replayable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from logistics.db import Database
from logistics.domain.states import ShipmentState
from logistics.obs import get_logger

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class OpenException:
    kind: str
    severity: str
    summary: str
    detail: dict[str, Any]
    detected_by: str
    age_hours: float


@dataclass(frozen=True, slots=True)
class CarrierOption:
    code: str
    name: str
    on_time_rate: float | None
    quoted_minor: int | None
    currency: str | None
    reachable: bool


@dataclass(frozen=True, slots=True)
class CaseFile:
    reference: str
    state: ShipmentState
    exceptions: list[OpenException]

    origin: str | None = None
    destination: str | None = None
    deadline: datetime | None = None
    hours_to_deadline: float | None = None
    planned_transit_hours: float | None = None

    current_carrier: str | None = None
    booked_minor: int | None = None
    currency: str | None = None

    last_position_at: datetime | None = None
    percent_complete: int | None = None
    alternatives: list[CarrierOption] = field(default_factory=list)
    sourcing_rounds: int = 0
    customer_told: bool = False

    @property
    def slack_hours(self) -> float | None:
        """Spare time. Negative means the deadline is already unreachable."""
        if self.hours_to_deadline is None or self.planned_transit_hours is None:
            return None
        return self.hours_to_deadline - self.planned_transit_hours

    @property
    def worst_severity(self) -> str:
        order = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
        found = [e.severity for e in self.exceptions]
        for level in order:
            if level in found:
                return level
        return "LOW"

    def as_prompt(self) -> str:
        lines = [
            f"Shipment: {self.reference} ({self.state})",
            f"Route: {self.origin or '?'} to {self.destination or '?'}",
        ]
        if self.current_carrier:
            lines.append(f"Carrier: {self.current_carrier}")
        if self.percent_complete is not None:
            lines.append(f"Journey: about {self.percent_complete}% complete")
        if self.hours_to_deadline is not None:
            lines.append(f"Time until the promised delivery: {self.hours_to_deadline:.1f} h")
        if self.planned_transit_hours:
            lines.append(f"Remaining transit as planned: {self.planned_transit_hours:.1f} h")
        if (slack := self.slack_hours) is not None:
            lines.append(
                f"Slack: {slack:.1f} h"
                + (" — the deadline cannot be met as things stand" if slack < 0 else "")
            )
        if self.last_position_at:
            age = (datetime.now(UTC) - self.last_position_at).total_seconds() / 3600
            lines.append(f"Last position report: {age:.1f} h ago")

        lines.append("\nOpen problems:")
        for exc in self.exceptions:
            lines.append(
                f"  - [{exc.severity}] {exc.kind}: {exc.summary} "
                f"(raised {exc.age_hours:.1f} h ago by {exc.detected_by})"
            )

        if self.alternatives:
            lines.append("\nOther carriers on this lane:")
            for alt in self.alternatives:
                price = (
                    f"quoted {alt.quoted_minor / 100:,.0f} {alt.currency}"
                    if alt.quoted_minor
                    else "no quote yet"
                )
                on_time = f"{alt.on_time_rate:.0%} on-time" if alt.on_time_rate else "no record"
                lines.append(
                    f"  - {alt.code}: {on_time}, {price}"
                    + ("" if alt.reachable else " (cannot be contacted)")
                )
        else:
            lines.append("\nNo alternative carriers are available on this lane.")

        lines.append(
            f"\nSourcing rounds so far: {self.sourcing_rounds}."
            f" Customer told about this: {'yes' if self.customer_told else 'no'}."
        )
        return "\n".join(lines)


async def build_case(db: Database, shipment_id: UUID) -> CaseFile | None:
    """Assemble everything known about a shipment in trouble."""
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT reference, state, origin, destination, deadline, plan, booking
              FROM shipments WHERE id = %s
            """,
            (shipment_id,),
        )
        row = await cur.fetchone()
        if row is None:
            return None

        cur = await conn.execute(
            """
            SELECT kind, severity, summary, detail, detected_by, created_at
              FROM exceptions
             WHERE shipment_id = %s AND state NOT IN ('RESOLVED', 'ABANDONED')
             ORDER BY array_position(ARRAY['CRITICAL','HIGH','MEDIUM','LOW'], severity)
            """,
            (shipment_id,),
        )
        exception_rows = await cur.fetchall()

        cur = await conn.execute(
            "SELECT occurred_at FROM tracking_events WHERE shipment_id = %s"
            " ORDER BY occurred_at DESC LIMIT 1",
            (shipment_id,),
        )
        last_ping = await cur.fetchone()

        cur = await conn.execute(
            "SELECT COALESCE(MAX(round), 0) AS r FROM quotes WHERE shipment_id = %s",
            (shipment_id,),
        )
        rounds = int((await cur.fetchone())["r"])

        # Carriers that are not the one currently booked, with their last quote
        # on this shipment if they gave one.
        cur = await conn.execute(
            """
            SELECT c.code, c.name, c.integration, c.telegram_chat_id,
                   p.on_time_rate,
                   q.amount_minor, q.currency
              FROM carriers c
              LEFT JOIN carrier_performance p
                     ON p.carrier_id = c.id AND p.mode IS NULL
                    AND p.origin_region IS NULL AND p.destination_region IS NULL
              LEFT JOIN quotes q
                     ON q.carrier_id = c.id AND q.shipment_id = %s
                    AND q.state IN ('RECEIVED', 'REJECTED')
             WHERE c.active AND c.approved AND c.code IS DISTINCT FROM %s
             ORDER BY p.on_time_rate DESC NULLS LAST
             LIMIT 5
            """,
            (shipment_id, (row["booking"] or {}).get("carrier_code")),
        )
        carrier_rows = await cur.fetchall()

        cur = await conn.execute(
            """
            SELECT 1 FROM communications
             WHERE shipment_id = %s AND direction = 'OUTBOUND'
               AND created_at > now() - interval '12 hours'
             LIMIT 1
            """,
            (shipment_id,),
        )
        told = await cur.fetchone() is not None

    plan = row["plan"] or {}
    booking = row["booking"] or {}
    now = datetime.now(UTC)

    deadline = row["deadline"]
    if deadline is not None and deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=UTC)

    return CaseFile(
        reference=row["reference"],
        state=ShipmentState(row["state"]),
        exceptions=[
            OpenException(
                kind=e["kind"],
                severity=e["severity"],
                summary=e["summary"] or "",
                detail=e["detail"] or {},
                detected_by=e["detected_by"],
                age_hours=(now - _aware(e["created_at"])).total_seconds() / 3600,
            )
            for e in exception_rows
        ],
        origin=_place(row["origin"]),
        destination=_place(row["destination"]),
        deadline=deadline,
        hours_to_deadline=(
            (deadline - now).total_seconds() / 3600 if deadline else None
        ),
        planned_transit_hours=_f(plan.get("transit_hours")),
        current_carrier=booking.get("carrier_code"),
        booked_minor=booking.get("amount_minor"),
        currency=booking.get("currency"),
        last_position_at=_aware(last_ping["occurred_at"]) if last_ping else None,
        percent_complete=_f_int(plan.get("percent_complete")),
        alternatives=[
            CarrierOption(
                code=c["code"],
                name=c["name"],
                on_time_rate=_f(c["on_time_rate"]),
                quoted_minor=c["amount_minor"],
                currency=c["currency"],
                reachable=(
                    c["integration"] == "API" or c["telegram_chat_id"] is not None
                ),
            )
            for c in carrier_rows
        ],
        sourcing_rounds=rounds,
        customer_told=told,
    )


def _place(location: dict[str, Any] | None) -> str | None:
    if not location:
        return None
    return location.get("city") or location.get("warehouse") or location.get("address")


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _f(value: Any) -> float | None:
    return None if value is None else float(value)


def _f_int(value: Any) -> int | None:
    return None if value is None else int(value)
