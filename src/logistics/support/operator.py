"""The operator's view of a shipment — everything, deliberately.

The mirror image of `CustomerView`, and a separate module for a reason. That
one is an allowlist: a field reaches a customer only by being named there, and
carrier cost, quote comparisons, scores, policy decisions and internal states
are absent by construction. Widening it to serve operators would have turned
the allowlist into a redaction list, where forgetting to hide something leaks
it. `view.py` is untouched by this file and its tests do not change.

Here the default is the opposite: an operator is inside the company, is
authenticated, and is asking about their own organisation's shipment. Row-level
security already limits which shipments that can be. So this assembles the full
picture — including the things the customer view exists to withhold.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from logistics.db import Database
from logistics.obs import get_logger

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class QuoteLine:
    carrier: str
    state: str
    amount_minor: int | None
    currency: str | None
    transit_hours: float | None
    score: float | None

    def render(self) -> str:
        price = (
            f"{self.amount_minor / 100:,.0f} {self.currency}"
            if self.amount_minor is not None and self.currency
            else "no price"
        )
        bits = [f"{self.carrier}: {price}", self.state]
        if self.transit_hours:
            bits.append(f"{self.transit_hours:.0f}h transit")
        if self.score is not None:
            bits.append(f"score {self.score:.3f}")
        return " · ".join(bits)


@dataclass(frozen=True, slots=True)
class OperatorView:
    reference: str
    state: str
    origin: str | None = None
    destination: str | None = None
    deadline: datetime | None = None
    cargo: dict[str, Any] = field(default_factory=dict)
    carrier: str | None = None
    booking: dict[str, Any] | None = None

    quotes: list[QuoteLine] = field(default_factory=list)
    exceptions: list[dict[str, Any]] = field(default_factory=list)
    gates: list[dict[str, Any]] = field(default_factory=list)
    approvals: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    messages: list[dict[str, Any]] = field(default_factory=list)
    queued: list[dict[str, Any]] = field(default_factory=list)
    eta: dict[str, Any] | None = None

    def as_prompt(self) -> str:
        """The whole case, as text. Written for reading rather than parsing:
        the model's job here is explanation, and a JSON dump prompts it to
        describe fields rather than answer the question."""
        def when(v: datetime | None) -> str:
            return v.strftime("%a %d %b %H:%M") if v else "not set"

        lines = [
            f"Reference: {self.reference}",
            f"Internal state: {self.state}",
            f"Route: {self.origin or '?'} to {self.destination or '?'}",
            f"Deadline: {when(self.deadline)}",
        ]
        if self.cargo:
            lines.append(f"Cargo: {self.cargo}")
        lines.append(f"Carrier: {self.carrier or 'none booked'}")

        if self.eta:
            late = " — LATE against the deadline" if self.eta.get("late") else ""
            lines.append(
                f"Live position: {self.eta['fraction_complete']:.0%} complete, "
                f"{self.eta['distance_remaining_km']:.0f} km remaining, "
                f"ETA {self.eta['eta']}{late}. "
                f"Observed speed {self.eta['effective_speed_kph']:.0f} kph, "
                f"{self.eta['off_route_km']:.0f} km off the direct path."
            )
        else:
            lines.append("Live position: no usable tracking data.")

        if self.exceptions:
            lines.append("\nOpen exceptions:")
            lines += [
                f"  - {e['kind']} ({e['severity']}, {e['state']}): {e['summary']}"
                for e in self.exceptions
            ]
        else:
            lines.append("\nOpen exceptions: none.")

        if self.quotes:
            lines.append("\nQuotes (internal — never repeat prices to a customer):")
            lines += [f"  - {q.render()}" for q in self.quotes]
        else:
            lines.append("\nQuotes: none gathered.")

        if self.gates:
            lines.append("\nPolicy decisions:")
            lines += [
                f"  - {g['action']} at tier {g['tier']}: {g['policy_decision']}"
                f" ({g['policy_reason']}) — now {g['state']}"
                for g in self.gates
            ]

        if self.approvals:
            lines.append("\nApprovals:")
            lines += [
                f"  - {a['state']}: {a['summary']}"
                + (f" — decided by {a['decided_by']}" if a["decided_by"] else "")
                for a in self.approvals
            ]

        if self.queued:
            lines.append("\nWork queued or stuck:")
            lines += [
                f"  - {w['kind']}: {w['state']}"
                + (f" ({w['attempts']} attempts, last error: {w['last_error']})"
                   if w["last_error"] else "")
                for w in self.queued
            ]

        if self.messages:
            lines.append("\nCustomer communications:")
            lines += [
                f"  - {m['direction']} via {m['channel']} "
                f"{m['created_at']:%d %b %H:%M}: {(m['body'] or '')[:120]}"
                for m in self.messages
            ]
        else:
            lines.append("\nCustomer communications: none — nobody has been told anything.")

        if self.events:
            lines.append("\nRecent history:")
            lines += [
                f"  - {e['created_at']:%d %b %H:%M} {e['actor']}: {e['type']}"
                + (f" ({e['from_state']} to {e['to_state']})" if e["to_state"] else "")
                for e in self.events
            ]

        return "\n".join(lines)


async def build_operator_view(db: Database, reference: str) -> OperatorView | None:
    """Assemble everything known about one shipment.

    Row-level security scopes every query below to the signed-in user's
    organisation, so "everything known" means everything *their* organisation
    knows. No filter here does that work; the connection does.
    """
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id, reference, state, origin, destination, cargo, deadline,"
            "       plan, booking FROM shipments WHERE upper(reference) = upper(%s)",
            (reference,),
        )
        row = await cur.fetchone()
        if row is None:
            return None
        sid = row["id"]

        cur = await conn.execute(
            "SELECT c.code AS carrier, q.state, q.amount_minor, q.currency,"
            "       q.transit_hours, q.score"
            "  FROM quotes q JOIN carriers c ON c.id = q.carrier_id"
            " WHERE q.shipment_id = %s"
            " ORDER BY q.round DESC, q.score DESC NULLS LAST",
            (sid,),
        )
        quotes = [
            QuoteLine(
                carrier=q["carrier"], state=q["state"],
                amount_minor=q["amount_minor"], currency=q["currency"],
                transit_hours=float(q["transit_hours"]) if q["transit_hours"] else None,
                score=float(q["score"]) if q["score"] is not None else None,
            )
            for q in await cur.fetchall()
        ]

        cur = await conn.execute(
            "SELECT kind, severity, state, summary, detail, created_at"
            "  FROM exceptions WHERE shipment_id = %s"
            "   AND state NOT IN ('RESOLVED', 'ABANDONED') ORDER BY created_at DESC",
            (sid,),
        )
        exceptions = list(await cur.fetchall())

        cur = await conn.execute(
            "SELECT action, tier, policy_decision, policy_reason, state, created_at"
            "  FROM proposed_actions WHERE shipment_id = %s"
            " ORDER BY created_at DESC LIMIT 10",
            (sid,),
        )
        gates = list(await cur.fetchall())

        cur = await conn.execute(
            "SELECT state, summary, decided_by, decided_at, expires_at"
            "  FROM approvals WHERE shipment_id = %s"
            " ORDER BY requested_at DESC LIMIT 5",
            (sid,),
        )
        approvals = list(await cur.fetchall())

        cur = await conn.execute(
            "SELECT type, actor, from_state, to_state, created_at"
            "  FROM shipment_events WHERE shipment_id = %s ORDER BY seq DESC LIMIT 15",
            (sid,),
        )
        events = list(reversed(await cur.fetchall()))

        cur = await conn.execute(
            "SELECT channel, direction, body, created_at"
            "  FROM communications WHERE shipment_id = %s"
            " ORDER BY created_at DESC LIMIT 10",
            (sid,),
        )
        messages = list(reversed(await cur.fetchall()))

        # Work that has not finished. A DEAD item is usually the actual answer
        # to "why is this stuck", and it appears nowhere in the customer view.
        cur = await conn.execute(
            "SELECT kind, state, attempts, last_error FROM work_items"
            " WHERE shipment_id = %s AND state <> 'DONE' ORDER BY created_at DESC",
            (sid,),
        )
        queued = list(await cur.fetchall())

    return OperatorView(
        reference=row["reference"],
        state=row["state"],
        origin=_place(row["origin"]),
        destination=_place(row["destination"]),
        deadline=row["deadline"],
        cargo=row["cargo"] or {},
        carrier=(row["booking"] or {}).get("carrier_code"),
        booking=row["booking"],
        quotes=quotes,
        exceptions=exceptions,
        gates=gates,
        approvals=approvals,
        events=events,
        messages=messages,
        queued=queued,
        eta=await _eta(db, reference),
    )


async def _eta(db: Database, reference: str) -> dict[str, Any] | None:
    """Reuses the tool rather than recomputing. One ETA implementation, and the
    number an operator is shown is the one the detectors act on."""
    from logistics.tools.definitions.reads import CalculateEta, calculate_eta
    from logistics.tools.registry import ToolContext

    result = await calculate_eta(
        ToolContext(db=db, agent="support"), CalculateEta(reference=reference)
    )
    return result if result.get("eta") else None


def _place(location: dict[str, Any] | None) -> str | None:
    if not location:
        return None
    return location.get("city") or location.get("address") or location.get("name")
