"""planning.plan & planning.optimize_fleet — corridor selection + NVIDIA cuOpt VRP.

Builds the multimodal or domestic itinerary (`build_itinerary`) and optimizes
vehicle routing, stop sequences, waypoints, and fleet dispatch using NVIDIA cuOpt
(`https://optimize.api.nvidia.com/v1/nvidia/cuopt`) and
`nvidia/nemotron-3.5-super-vl-120b-a12b` (`Job.ROUTE_OPTIMIZATION`).
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from typing import Any, Final

from psycopg.types.json import Jsonb

from logistics.domain.events import EventDraft
from logistics.domain.legs import TransportMode, modes_for_cargo
from logistics.domain.models import LegDraft, Shipment, StepResult
from logistics.domain.states import ShipmentState, is_terminal
from logistics.handlers.base import StepContext, handler
from logistics.routing.cuopt import (
    CuOptClient,
    CuOptSolution,
    FleetTask,
    FleetVehicle,
    ai_route_advisory,
    corridor_waypoints,
    expand_route_waypoints,
)

_NAIRA: Final = 100  # kobo per naira

# Domestic road corridors. km, hours, indicative cost in kobo.
LANES: Final[dict[tuple[str, str], dict[str, float]]] = {
    ("Lagos", "Abuja"): {"km": 750, "hours": 11.5, "base_minor": 380_000 * _NAIRA},
    ("Abuja", "Lagos"): {"km": 750, "hours": 11.5, "base_minor": 380_000 * _NAIRA},
    ("Lagos", "Ibadan"): {"km": 130, "hours": 2.5, "base_minor": 95_000 * _NAIRA},
    ("Ibadan", "Lagos"): {"km": 130, "hours": 2.5, "base_minor": 95_000 * _NAIRA},
    ("Lagos", "Kano"): {"km": 1_050, "hours": 16.0, "base_minor": 520_000 * _NAIRA},
    ("Abuja", "Kano"): {"km": 350, "hours": 5.5, "base_minor": 210_000 * _NAIRA},
    ("Lagos", "Port Harcourt"): {"km": 610, "hours": 9.5, "base_minor": 330_000 * _NAIRA},
}

# The gateway each city clears international freight through.
GATEWAYS: Final[dict[str, dict[str, str]]] = {
    "Lagos": {"SEA": "Apapa Port", "AIR": "Murtala Muhammed Cargo"},
    "Abuja": {"AIR": "Nnamdi Azikiwe Cargo"},
    "Port Harcourt": {"SEA": "Onne Port", "AIR": "Port Harcourt Cargo"},
    "Kano": {"AIR": "Mallam Aminu Kano Cargo"},
    "Tema": {"SEA": "Tema Port"},
    "Accra": {"AIR": "Kotoka Cargo", "SEA": "Tema Port"},
    "Abidjan": {"SEA": "Abidjan Port"},
    "Rotterdam": {"SEA": "Port of Rotterdam"},
    "London": {"AIR": "Heathrow Cargo"},
}

# Indicative international corridor legs, by mode.
CORRIDORS: Final[dict[tuple[str, str, str], dict[str, float]]] = {
    ("Apapa Port", "Tema Port", "SEA"): {"km": 480, "hours": 36},
    ("Apapa Port", "Abidjan Port", "SEA"): {"km": 900, "hours": 60},
    ("Apapa Port", "Port of Rotterdam", "SEA"): {"km": 7_100, "hours": 480},
    ("Murtala Muhammed Cargo", "Heathrow Cargo", "AIR"): {"km": 5_000, "hours": 7},
    ("Murtala Muhammed Cargo", "Kotoka Cargo", "AIR"): {"km": 400, "hours": 1.2},
}

# Drayage: the short road hop between a city and its gateway.
DRAYAGE_KM: Final[float] = 35.0
DRAYAGE_HOURS: Final[float] = 3.0
DRAYAGE_MINOR: Final[int] = 45_000 * _NAIRA

# Grams CO2e per tonne-kilometre. Road is far dirtier than sea per tonne-km;
# this is what makes emissions a real objective rather than a slogan.
CO2E_G_PER_TKM: Final[dict[str, float]] = {
    "ROAD": 62.0, "RAIL": 22.0, "SEA": 8.0, "AIR": 500.0,
}

VEHICLE_CLASSES: Final[tuple[tuple[int, str], ...]] = (
    (1_000, "van"),
    (3_500, "3-ton truck"),
    (7_500, "5-ton truck"),
    (15_000, "10-ton truck"),
    (30_000, "articulated"),
)

# Below this share of a truck, consolidating with other freight beats paying
# for a whole vehicle.
FTL_THRESHOLD_KG: Final[float] = 4_000


def vehicle_for(weight_kg: float) -> str:
    for ceiling, name in VEHICLE_CLASSES:
        if weight_kg <= ceiling:
            return name
    return "multiple vehicles"


def load_type_for(mode: str, weight_kg: float) -> str:
    """FTL/LTL for road, FCL/LCL for sea. Same idea, per-mode vocabulary."""
    if mode == "SEA":
        return "FCL" if weight_kg >= 10_000 else "LCL"
    if mode == "ROAD":
        return "FTL" if weight_kg >= FTL_THRESHOLD_KG else "LTL"
    return "BULK" if weight_kg >= 5_000 else "CONSOLIDATED"


def co2e_kg(mode: str, distance_km: float, weight_kg: float) -> float:
    tonnes = max(weight_kg, 1.0) / 1000.0
    grams = CO2E_G_PER_TKM.get(mode, 62.0) * tonnes * distance_km
    return round(grams / 1000.0, 3)


def _city(location: dict) -> str | None:
    return location.get("city") or location.get("warehouse")


def _country(location: dict) -> str | None:
    country = location.get("country")
    return country.upper() if country else None


def _road_leg(
    sequence: int, origin: str, destination: str, weight_kg: float,
    *, km: float | None = None, hours: float | None = None, cost_minor: int | None = None,
) -> LegDraft:
    lane = LANES.get((origin, destination))
    distance = km if km is not None else (lane["km"] if lane else None)
    base = cost_minor if cost_minor is not None else (lane["base_minor"] if lane else None)

    if base is not None:
        # Weight surcharge above a 5-tonne baseline.
        surcharge = max(0.0, (weight_kg - 5_000) / 5_000) * 0.18
        base = int(math.ceil(base * (1 + surcharge)))

    return LegDraft(
        sequence=sequence,
        mode="ROAD",
        origin_name=origin,
        destination_name=destination,
        distance_km=distance,
        cost_minor=base,
        currency="NGN" if base is not None else None,
        load_type=load_type_for("ROAD", weight_kg),
        co2e_kg=co2e_kg("ROAD", distance, weight_kg) if distance else None,
        metadata={
            "vehicle": vehicle_for(weight_kg),
            "transit_hours": hours if hours is not None else (lane["hours"] if lane else None),
            "known_lane": lane is not None or km is not None,
        },
    )


def build_itinerary(
    origin: dict, destination: dict, weight_kg: float, *, hazmat: bool = False
) -> tuple[list[LegDraft], dict]:
    """Return the legs plus a summary. Never raises on an unknown lane — it
    flags low confidence and lets carrier quotes set the price."""
    src, dst = _city(origin), _city(destination)
    src_country, dst_country = _country(origin), _country(destination)
    international = bool(src_country and dst_country and src_country != dst_country)

    allowed = modes_for_cargo(hazmat=hazmat)

    if not international:
        leg = _road_leg(1, src or "?", dst or "?", weight_kg)
        return [leg], {
            "international": False,
            "modes": ["ROAD"],
            "confidence": "medium" if leg.metadata["known_lane"] else "low",
            "note": None if leg.metadata["known_lane"] else
                    "Lane not in the rate table; carrier quotes will set the price.",
        }

    # International: pick a gateway mode both ends support, preferring sea for
    # cost unless hazmat or the pairing has no sea corridor.
    for mode in (TransportMode.SEA, TransportMode.AIR):
        if mode not in allowed:
            continue
        src_gate = GATEWAYS.get(src or "", {}).get(mode.value)
        dst_gate = GATEWAYS.get(dst or "", {}).get(mode.value)
        if not src_gate or not dst_gate:
            continue
        corridor = CORRIDORS.get((src_gate, dst_gate, mode.value))
        if corridor is None:
            continue

        legs = [
            _road_leg(1, src or "?", src_gate, weight_kg,
                      km=DRAYAGE_KM, hours=DRAYAGE_HOURS, cost_minor=DRAYAGE_MINOR),
            LegDraft(
                sequence=2,
                mode=mode.value,
                origin_name=src_gate,
                destination_name=dst_gate,
                distance_km=corridor["km"],
                load_type=load_type_for(mode.value, weight_kg),
                co2e_kg=co2e_kg(mode.value, corridor["km"], weight_kg),
                metadata={
                    "transit_hours": corridor["hours"],
                    "known_lane": True,
                    # Priced by the carrier, not by us — international rates
                    # move too fast for a static table to be honest about.
                    "pricing": "carrier_quote",
                },
            ),
            _road_leg(3, dst_gate, dst or "?", weight_kg,
                      km=DRAYAGE_KM, hours=DRAYAGE_HOURS, cost_minor=None),
        ]
        return legs, {
            "international": True,
            "modes": ["ROAD", mode.value, "ROAD"],
            "gateway_out": src_gate,
            "gateway_in": dst_gate,
            "confidence": "medium",
            "customs_required": True,
        }

    # No corridor found. One leg, flagged, rather than a fabricated itinerary.
    leg = _road_leg(1, src or "?", dst or "?", weight_kg)
    return [leg], {
        "international": True,
        "modes": ["ROAD"],
        "confidence": "low",
        "note": (
            "No international corridor found for this pairing"
            + (" that can carry hazmat" if hazmat else "")
            + "; needs manual planning."
        ),
        "customs_required": True,
    }


@handler("planning.plan")
async def plan(ctx: StepContext) -> StepResult:
    shipment = ctx.require_shipment()
    if is_terminal(shipment.state):
        ctx.log.info("plan.ignored_terminal", state=str(shipment.state))
        return StepResult()

    cargo = shipment.cargo or {}
    weight = float(cargo.get("weight_kg") or 0)
    hazmat = bool(cargo.get("hazmat") or cargo.get("hazmat_class"))

    legs, summary = build_itinerary(
        shipment.origin or {}, shipment.destination or {}, weight, hazmat=hazmat
    )

    # Optimize road routing & vehicle selection via NVIDIA cuOpt + Nemotron 3.5 Super VL
    legs, cuopt_meta = await _optimize_shipment_routing(
        ctx, shipment, legs, weight, hazmat=hazmat
    )
    summary |= cuopt_meta

    total_hours = sum(
        float(leg.metadata.get("transit_hours") or 0) for leg in legs
    )
    known_cost = [leg.cost_minor for leg in legs if leg.cost_minor is not None]

    summary |= {
        "legs": len(legs),
        "vehicle": cuopt_meta.get("recommended_vehicle") or vehicle_for(weight),
        "transit_hours": round(total_hours, 2),
        "distance_km": round(sum(leg.distance_km or 0 for leg in legs), 1),
        "co2e_kg": round(sum(leg.co2e_kg or 0 for leg in legs), 2),
        # Partial: international sea/air legs are priced by carrier quote.
        "estimated_cost_minor": sum(known_cost) if known_cost else None,
        "currency": "NGN",
        "priced_legs": f"{len(known_cost)}/{len(legs)}",
    }

    if total_hours and shipment.deadline:
        # Twelve hours of handling on top of pure transit.
        eta = datetime.now(UTC) + timedelta(hours=total_hours + 12)
        deadline = shipment.deadline
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=UTC)
        summary["projected_delivery"] = eta.isoformat()
        summary["meets_deadline"] = eta <= deadline
        if not summary["meets_deadline"]:
            summary["confidence"] = "at-risk"

    ctx.log.info(
        "plan.built",
        legs=len(legs),
        modes=summary["modes"],
        international=summary["international"],
        routing_solver=summary.get("routing_solver"),
    )

    # Only advance state to PLANNED when entering from ALLOCATED or EXCEPTION;
    # re-planning an already PLANNED/SOURCING/BOOKED/IN_TRANSIT shipment updates
    # the plan metadata without violating the state machine or overwriting committed legs.
    can_advance = shipment.state in (ShipmentState.ALLOCATED, ShipmentState.EXCEPTION)
    legs_committed = shipment.state in (
        ShipmentState.BOOKED,
        ShipmentState.IN_TRANSIT,
        ShipmentState.DELIVERED,
        ShipmentState.POD_VERIFIED,
    )
    if not legs_committed:
        await _write_checkpoints(ctx, legs, total_hours)

    merged_plan = {**(shipment.plan or {}), **summary} if not can_advance else summary

    return StepResult(
        transition=ShipmentState.PLANNED if can_advance else None,
        patch={"plan": merged_plan},
        legs=() if legs_committed else tuple(legs),
        events=(EventDraft(type="planning.estimated", actor="planning", payload=summary),),
    )


@handler("planning.optimize_fleet")
async def optimize_fleet(ctx: StepContext) -> StepResult:
    """Batch-optimize all queued/active shipments across available fleet vehicles
    using NVIDIA cuOpt Pickup & Delivery with Time Windows (PDPTW)."""
    custom_coords = await _load_db_coordinates(ctx)

    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT id, reference, origin, destination, cargo, deadline, plan
              FROM shipments
             WHERE state IN ('ALLOCATED', 'PLANNED', 'SOURCING', 'BOOKED')
             ORDER BY created_at ASC
             LIMIT 40
            """
        )
        rows = await cur.fetchall()

    tasks: list[FleetTask] = []
    by_ref: dict[str, dict[str, Any]] = {}
    now = datetime.now(UTC)

    for row in rows:
        ref = row["reference"]
        by_ref[ref] = row
        src = _city(row["origin"] or {}) or (row["origin"] or {}).get("address") or "Lagos"
        dst = _city(row["destination"] or {}) or (row["destination"] or {}).get("address") or "Abuja"
        weight = max(1, int(float((row["cargo"] or {}).get("weight_kg") or 500)))

        latest_h = 72
        if row["deadline"]:
            dl = row["deadline"]
            if dl.tzinfo is None:
                dl = dl.replace(tzinfo=UTC)
            latest_h = max(4, min(168, int((dl - now).total_seconds() // 3600)))

        tasks.append(
            FleetTask(
                task_id=ref,
                shipment_reference=ref,
                pickup_location=str(src),
                delivery_location=str(dst),
                demand_kg=weight,
                earliest_hour=0,
                latest_hour=latest_h,
            )
        )

    if not tasks:
        return StepResult()

    max_latest_h = max(72, *(t.latest_hour for t in tasks))
    vehicles = await _load_fleet_vehicles(ctx, latest_hour=max_latest_h)

    client = CuOptClient(ctx.settings, db=ctx.db)
    solution = await client.solve(
        vehicles,
        tasks,
        custom_coords=custom_coords,
        work_item_id=ctx.item.id,
    )

    # Persist batch optimization results onto each shipment's plan JSONB and routes
    async with ctx.db.connection() as conn:
        for assignment in solution.assignments:
            assigned_refs = {
                tid.split(":")[0]
                for tid in assignment.task_ids
                if ":" in tid
            }
            for ref in assigned_refs:
                s_row = by_ref.get(ref)
                if not s_row:
                    continue
                existing_plan = dict(s_row["plan"] or {})
                src_city = _city(s_row["origin"] or {}) or (s_row["origin"] or {}).get("address") or "Lagos"
                dst_city = _city(s_row["destination"] or {}) or (s_row["destination"] or {}).get("address") or "Abuja"
                lane_waypoints = corridor_waypoints(str(src_city), str(dst_city))
                if len(lane_waypoints) <= 2 and assignment.stop_locations:
                    lane_waypoints = expand_route_waypoints(assignment.stop_locations)
                existing_plan.update(
                    {
                        "routing_solver": solution.solver,
                        "cuopt_status": solution.status,
                        "cuopt_request_id": solution.request_id,
                        "cuopt_solution_cost": solution.solution_cost,
                        "assigned_vehicle": assignment.vehicle_id,
                        "waypoints": lane_waypoints,
                        "stop_sequence": assignment.task_ids,
                        "optimized_at": datetime.now(UTC).isoformat(),
                    }
                )
                await conn.execute(
                    "UPDATE shipments SET plan = %s WHERE id = %s",
                    (Jsonb(existing_plan), s_row["id"]),
                )

    ctx.log.info(
        "planning.fleet_optimized",
        solver=solution.solver,
        shipments=len(tasks),
        vehicles_used=len(solution.assignments),
        total_km=solution.total_distance_km,
    )
    return StepResult()


async def _optimize_shipment_routing(
    ctx: StepContext,
    shipment: Shipment,
    legs: list[LegDraft],
    weight_kg: float,
    *,
    hazmat: bool = False,
) -> tuple[list[LegDraft], dict[str, Any]]:
    """Run NVIDIA cuOpt (and optional Nemotron 3.5 Super VL route advisory) for a
    single shipment's road routing."""
    src = _city(shipment.origin or {}) or (shipment.origin or {}).get("address") or "Lagos"
    dst = _city(shipment.destination or {}) or (shipment.destination or {}).get("address") or "Abuja"

    custom_coords = await _load_db_coordinates(ctx)
    vehicles = await _load_fleet_vehicles(ctx, origin=str(src), destination=str(dst), weight_kg=weight_kg, hazmat=hazmat)

    task = FleetTask(
        task_id=shipment.reference,
        shipment_reference=shipment.reference,
        pickup_location=str(src),
        delivery_location=str(dst),
        demand_kg=max(1, int(weight_kg or 500)),
    )

    cuopt = CuOptClient(ctx.settings, db=ctx.db)
    solution: CuOptSolution = await cuopt.solve(
        vehicles,
        [task],
        custom_coords=custom_coords,
        shipment_id=shipment.id,
        work_item_id=ctx.item.id,
    )

    waypoints = solution.waypoints or corridor_waypoints(str(src), str(dst))
    assigned_vehicle = (
        solution.assignments[0].vehicle_id
        if solution.assignments
        else vehicle_for(weight_kg)
    )

    # If a domestic road leg was not in the static 5-city table, fill its distance
    # and transit hours from cuOpt while leaving cost_minor=None for carrier quotes.
    updated_legs: list[LegDraft] = []
    for leg in legs:
        if leg.mode == "ROAD" and leg.distance_km is None and solution.total_distance_km > 0:
            km = solution.total_distance_km
            hrs = solution.total_transit_hours
            updated_legs.append(
                LegDraft(
                    sequence=leg.sequence,
                    mode=leg.mode,
                    origin_name=leg.origin_name,
                    destination_name=leg.destination_name,
                    distance_km=km,
                    cost_minor=leg.cost_minor,
                    currency=leg.currency,
                    load_type=leg.load_type,
                    co2e_kg=co2e_kg("ROAD", km, weight_kg),
                    metadata={
                        **leg.metadata,
                        "transit_hours": hrs,
                        "waypoints": waypoints,
                        "cuopt_solver": solution.solver,
                    },
                )
            )
        else:
            updated_legs.append(
                LegDraft(
                    sequence=leg.sequence,
                    mode=leg.mode,
                    origin_name=leg.origin_name,
                    destination_name=leg.destination_name,
                    distance_km=leg.distance_km,
                    cost_minor=leg.cost_minor,
                    currency=leg.currency,
                    load_type=leg.load_type,
                    co2e_kg=leg.co2e_kg,
                    metadata={
                        **leg.metadata,
                        "waypoints": waypoints,
                        "cuopt_solver": solution.solver,
                    },
                )
            )

    meta: dict[str, Any] = {
        "routing_solver": solution.solver,
        "cuopt_status": solution.status,
        "cuopt_solution_cost": solution.solution_cost,
        "waypoints": waypoints,
        "recommended_vehicle": assigned_vehicle,
    }
    if solution.request_id:
        meta["cuopt_request_id"] = solution.request_id

    if ctx.llm is not None:
        advisory = await ai_route_advisory(
            ctx.llm,
            origin=str(src),
            destination=str(dst),
            weight_kg=weight_kg,
            waypoints=waypoints,
            distance_km=updated_legs[0].distance_km or solution.total_distance_km,
            transit_hours=float(updated_legs[0].metadata.get("transit_hours") or solution.total_transit_hours),
            shipment_id=shipment.id,
            work_item_id=ctx.item.id,
        )
        if advisory is not None:
            if advisory.waypoints:
                meta["waypoints"] = advisory.waypoints
            meta["ai_risk_level"] = advisory.risk_level
            meta["ai_route_notes"] = advisory.corridor_notes

    await _persist_route_record(
        ctx,
        origin=str(src),
        destination=str(dst),
        distance_km=updated_legs[0].distance_km or solution.total_distance_km,
        typical_hours=float(updated_legs[0].metadata.get("transit_hours") or solution.total_transit_hours),
        waypoints=meta["waypoints"],
        risk_notes=meta.get("ai_route_notes"),
    )

    return updated_legs, meta


async def _load_db_coordinates(ctx: StepContext) -> dict[str, tuple[float, float]]:
    coords: dict[str, tuple[float, float]] = {}
    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT name, city, code, latitude, longitude
              FROM locations
             WHERE latitude IS NOT NULL AND longitude IS NOT NULL
            """
        )
        for row in await cur.fetchall():
            lat, lon = float(row["latitude"]), float(row["longitude"])
            for key in (row["city"], row["name"], row["code"]):
                if key:
                    coords[str(key)] = (lat, lon)
    return coords


async def _load_fleet_vehicles(
    ctx: StepContext,
    *,
    origin: str = "Lagos",
    destination: str = "Abuja",
    weight_kg: float = 1_000,
    hazmat: bool = False,
    latest_hour: int = 72,
) -> list[FleetVehicle]:
    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT identifiers->>'registration' AS reg,
                   kind,
                   capacity_kg,
                   hazmat_certified
              FROM conveyances
             WHERE active AND mode = 'ROAD'
             ORDER BY capacity_kg DESC NULLS LAST
             LIMIT 20
            """
        )
        rows = await cur.fetchall()

    vehicles: list[FleetVehicle] = []
    for r in rows:
        if hazmat and not r["hazmat_certified"]:
            continue
        cap = int(float(r["capacity_kg"] or 15_000))
        vid = r["reg"] or r["kind"] or "FLEET-TRUCK"
        vehicles.append(
            FleetVehicle(
                vehicle_id=str(vid),
                start_location=origin,
                end_location=destination,
                capacity_kg=cap,
                latest_hour=max(72, latest_hour),
            )
        )

    if not vehicles:
        vehicles.append(
            FleetVehicle(
                vehicle_id=vehicle_for(weight_kg),
                start_location=origin,
                end_location=destination,
                capacity_kg=max(15_000, int(weight_kg or 1_000)),
                latest_hour=max(72, latest_hour),
            )
        )
    return vehicles


async def _persist_route_record(
    ctx: StepContext,
    *,
    origin: str,
    destination: str,
    distance_km: float | None,
    typical_hours: float | None,
    waypoints: list[str],
    risk_notes: str | None = None,
) -> None:
    name = f"{origin} → {destination}"
    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            "SELECT id FROM routes WHERE name = %s AND mode = 'ROAD' LIMIT 1",
            (name,),
        )
        existing = await cur.fetchone()
        if existing:
            await conn.execute(
                """
                UPDATE routes
                   SET distance_km = COALESCE(%s, distance_km),
                       typical_hours = COALESCE(%s, typical_hours),
                       waypoints = %s,
                       risk_notes = COALESCE(%s, risk_notes)
                 WHERE id = %s
                """,
                (distance_km, typical_hours, Jsonb(waypoints), risk_notes, existing["id"]),
            )
        else:
            await conn.execute(
                """
                INSERT INTO routes
                    (name, mode, distance_km, typical_hours, co2e_g_per_tkm, waypoints, risk_notes)
                VALUES (%s, 'ROAD', %s, %s, %s, %s, %s)
                """,
                (
                    name,
                    distance_km,
                    typical_hours,
                    CO2E_G_PER_TKM["ROAD"],
                    Jsonb(waypoints),
                    risk_notes,
                ),
            )


async def _write_checkpoints(ctx: StepContext, legs, total_hours: float) -> None:  # noqa: ANN001
    """One checkpoint per leg boundary, spaced by planned transit.

    Deliberately coarse: these are "should have left by" and "should have
    arrived by" markers, not a GPS trace. Tolerance is generous because
    Nigerian road times vary widely — a tight tolerance would alert constantly.
    """
    shipment = ctx.require_shipment()
    now = datetime.now(UTC)
    elapsed = 0.0

    async with ctx.db.connection() as conn:
        await conn.execute(
            "DELETE FROM checkpoints WHERE shipment_id = %s AND state = 'PENDING'",
            (shipment.id,),
        )
        for leg in legs:
            hours = float(leg.metadata.get("transit_hours") or 0)
            if hours <= 0:
                continue
            elapsed += hours
            await conn.execute(
                """
                INSERT INTO checkpoints
                    (shipment_id, sequence, name, expected_at, tolerance_minutes)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    shipment.id,
                    leg.sequence,
                    f"arrive {leg.destination_name or 'destination'}",
                    now + timedelta(hours=elapsed + 12),
                    max(90, int(hours * 20)),
                ),
            )
