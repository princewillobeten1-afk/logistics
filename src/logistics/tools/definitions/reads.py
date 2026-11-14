"""Tier 0 tools — questions, never changes.

Thin wrappers over repositories that already exist. The point is not to add a
layer of indirection; it is that an agent's access to these is now checked and
logged rather than implied by whatever its handler happened to import.

None of these is policy-gated. A read cannot hurt anyone, and putting a gate in
front of one only teaches operators that gate messages are noise.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field

from logistics.tools.registry import Tier, ToolContext, tool


# ------------------------------------------------------------- shipments


class GetShipment(BaseModel):
    reference: str = Field(description="Shipment reference, e.g. SHP-0042.")


@tool(
    "get_shipment",
    tier=Tier.READ,
    description=(
        "Look up one shipment by its reference: state, origin, destination, "
        "cargo, deadline and current booking."
    ),
    args=GetShipment,
)
async def get_shipment(ctx: ToolContext, args: GetShipment) -> dict[str, Any]:
    from logistics.shipments import ShipmentRepo

    shipment = await ShipmentRepo(ctx.db).get_by_reference(args.reference)
    if shipment is None:
        # Also what another organisation's shipment looks like from here, and
        # deliberately indistinguishable from one that does not exist.
        return {"found": False, "reference": args.reference}

    return {
        "found": True,
        "reference": shipment.reference,
        "state": str(shipment.state),
        "origin": shipment.origin,
        "destination": shipment.destination,
        "cargo": shipment.cargo,
        "deadline": shipment.deadline.isoformat() if shipment.deadline else None,
        "booking": shipment.booking,
        "plan": shipment.plan,
    }


class GetTracking(BaseModel):
    reference: str = Field(description="Shipment reference.")
    limit: int = Field(default=20, ge=1, le=200)


@tool(
    "get_tracking",
    tier=Tier.READ,
    description=(
        "Recent position and status events for a shipment, newest first. Use "
        "this to find out where something is and when it was last seen."
    ),
    args=GetTracking,
)
async def get_tracking(ctx: ToolContext, args: GetTracking) -> dict[str, Any]:
    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT t.occurred_at, t.event_type, t.source, t.latitude, t.longitude,
                   t.speed_kph
              FROM tracking_events t
              JOIN shipments s ON s.id = t.shipment_id
             WHERE upper(s.reference) = upper(%s)
             ORDER BY t.occurred_at DESC
             LIMIT %s
            """,
            (args.reference, args.limit),
        )
        rows = await cur.fetchall()

    return {
        "reference": args.reference,
        "count": len(rows),
        "events": [
            {
                "at": r["occurred_at"].isoformat(),
                "type": r["event_type"],
                "source": r["source"],
                "latitude": float(r["latitude"]) if r["latitude"] is not None else None,
                "longitude": float(r["longitude"]) if r["longitude"] is not None else None,
                "speed_kph": float(r["speed_kph"]) if r["speed_kph"] is not None else None,
            }
            for r in rows
        ],
    }


# ------------------------------------------------------------- inventory


class GetInventory(BaseModel):
    sku: str = Field(description="Stock keeping unit, or DEFAULT.")


@tool(
    "get_inventory",
    tier=Tier.READ,
    description=(
        "Available stock for a SKU across warehouses, with dispatch lead time "
        "and distance to destination where known. Available means on hand "
        "minus what is already reserved."
    ),
    args=GetInventory,
)
async def get_inventory(ctx: ToolContext, args: GetInventory) -> dict[str, Any]:
    from logistics.inventory import PostgresInventory

    lines = await PostgresInventory(ctx.db).availability(args.sku)
    return {
        "sku": args.sku,
        "total_available": sum(line.available for line in lines),
        "warehouses": [
            {
                "warehouse": line.warehouse,
                "available": line.available,
                "dispatch_lead_hours": line.dispatch_lead_hours,
                "distance_km": line.distance_km,
            }
            for line in lines
        ],
    }


class GetWarehouses(BaseModel):
    pass


@tool(
    "get_warehouses",
    tier=Tier.READ,
    description="Every warehouse with its code, name, city and dispatch lead time.",
    args=GetWarehouses,
)
async def get_warehouses(ctx: ToolContext, args: GetWarehouses) -> dict[str, Any]:
    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT w.code, w.name, w.dispatch_lead_hours,
                   l.city, l.country, l.latitude, l.longitude
              FROM warehouses w
              LEFT JOIN locations l ON l.id = w.location_id
             ORDER BY w.code
            """
        )
        rows = await cur.fetchall()

    return {
        "count": len(rows),
        "warehouses": [
            {
                "code": r["code"],
                "name": r["name"],
                "city": r["city"],
                "country": r["country"],
                "dispatch_lead_hours": float(r["dispatch_lead_hours"]),
            }
            for r in rows
        ],
    }


# -------------------------------------------------------------- carriers


class GetCarriers(BaseModel):
    mode: str = Field(default="ROAD", description="ROAD, AIR, SEA or RAIL.")
    approved_only: bool = Field(
        default=False,
        description="Only carriers already approved for use without escalation.",
    )


@tool(
    "get_carriers",
    tier=Tier.READ,
    description=(
        "Carriers that can run a mode and can actually be reached. A Telegram "
        "carrier with no chat id is excluded: the bot cannot open a "
        "conversation, so it is not a real option."
    ),
    args=GetCarriers,
)
async def get_carriers(ctx: ToolContext, args: GetCarriers) -> dict[str, Any]:
    from logistics.carriers.repo import CarrierRepo

    repo = CarrierRepo(ctx.db)
    carriers = await repo.eligible(args.mode, approved_only=args.approved_only)
    signals = await repo.signals()

    out = []
    for c in carriers:
        s = signals.get(c.id)
        out.append(
            {
                "code": c.code,
                "name": c.name,
                "integration": c.integration,
                "on_time_rate": round(s.on_time_rate, 3) if s else None,
                "damage_rate": round(s.damage_rate, 3) if s else None,
                "shipments": s.shipments_count if s else 0,
            }
        )
    return {"mode": args.mode, "count": len(out), "carriers": out}


class GetCarrierRates(BaseModel):
    reference: str = Field(description="Shipment reference.")
    round: int | None = Field(
        default=None, description="Quoting round. Defaults to the current one."
    )


@tool(
    "get_carrier_rates",
    tier=Tier.READ,
    description=(
        "Quotes gathered for a shipment: price, transit time and state per "
        "carrier. Prices are in minor units with an explicit currency."
    ),
    args=GetCarrierRates,
)
async def get_carrier_rates(ctx: ToolContext, args: GetCarrierRates) -> dict[str, Any]:
    from logistics.carriers.repo import QuoteRepo
    from logistics.shipments import ShipmentRepo

    shipment = await ShipmentRepo(ctx.db).get_by_reference(args.reference)
    if shipment is None:
        return {"found": False, "reference": args.reference, "quotes": []}

    quotes = QuoteRepo(ctx.db)
    round_no = args.round or await quotes.current_round(shipment.id)
    rows = await quotes.for_round(shipment.id, round_no)

    return {
        "found": True,
        "reference": args.reference,
        "round": round_no,
        "quotes": [
            {
                "carrier": r.get("carrier_code"),
                "state": r.get("state"),
                "amount_minor": r.get("amount_minor"),
                "currency": r.get("currency"),
                "transit_hours": float(r["transit_hours"]) if r.get("transit_hours") else None,
            }
            for r in rows
        ],
    }


# ------------------------------------------------------------------ eta


class CalculateEta(BaseModel):
    reference: str = Field(description="Shipment reference.")


@tool(
    "calculate_eta",
    tier=Tier.READ,
    description=(
        "Estimated arrival from the latest known position, using observed "
        "speed rather than a nominal one. Returns nothing useful until the "
        "shipment has reported a position."
    ),
    args=CalculateEta,
)
async def calculate_eta(ctx: ToolContext, args: CalculateEta) -> dict[str, Any]:
    from logistics.shipments import ShipmentRepo
    from logistics.tracking.eta import estimate_progress

    shipment = await ShipmentRepo(ctx.db).get_by_reference(args.reference)
    if shipment is None:
        return {"found": False, "reference": args.reference}

    origin, destination = shipment.origin or {}, shipment.destination or {}
    if not _has_coords(origin) or not _has_coords(destination):
        return {
            "found": True,
            "eta": None,
            "reason": "origin or destination has no coordinates",
        }

    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT t.latitude, t.longitude, t.speed_kph, t.occurred_at
              FROM tracking_events t
              JOIN shipments s ON s.id = t.shipment_id
             WHERE upper(s.reference) = upper(%s)
               AND t.latitude IS NOT NULL
             ORDER BY t.occurred_at DESC
             LIMIT 20
            """,
            (args.reference,),
        )
        rows = await cur.fetchall()

    if not rows:
        return {"found": True, "eta": None, "reason": "no position reported yet"}

    latest = rows[0]
    # `Coordinates` is an alias for tuple[float, float], not a class — calling
    # it constructs nothing.
    progress = estimate_progress(
        position=(float(latest["latitude"]), float(latest["longitude"])),
        origin=(float(origin["latitude"]), float(origin["longitude"])),
        destination=(float(destination["latitude"]), float(destination["longitude"])),
        observed_speeds=[
            float(r["speed_kph"]) for r in rows if r["speed_kph"] is not None
        ],
    )

    deadline = shipment.deadline
    return {
        "found": True,
        "reference": args.reference,
        "eta": progress.eta.isoformat() if progress.eta else None,
        "hours_remaining": round(progress.hours_remaining, 2),
        "distance_remaining_km": round(progress.distance_remaining_km, 1),
        "fraction_complete": round(progress.fraction_complete, 3),
        "effective_speed_kph": round(progress.effective_speed_kph, 1),
        "off_route_km": round(progress.cross_track_km, 1),
        "last_seen": latest["occurred_at"].isoformat(),
        "deadline": deadline.isoformat() if deadline else None,
        "late": bool(deadline and progress.eta and progress.eta > deadline),
    }


def _has_coords(place: dict[str, Any]) -> bool:
    return place.get("latitude") is not None and place.get("longitude") is not None
