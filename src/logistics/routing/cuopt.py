"""NVIDIA cuOpt Managed Service client & VRP/PDPTW solver integration.

Integrates:
  1. NVIDIA cuOpt (`POST https://optimize.api.nvidia.com/v1/nvidia/cuopt` and
     status polling `GET https://optimize.api.nvidia.com/v1/status/{requestId}`)
     for Capacitated Vehicle Routing & Pickup-and-Delivery with Time Windows
     (CVRPTW / PDPTW).
  2. `nvidia/nemotron-3.5-super-vl-120b-a12b` (`Job.ROUTE_OPTIMIZATION`) for
     corridor risk analysis, waypoint recommendations, and dispatch notes.
  3. A deterministic local VRP fallback over the same road-distance and
     travel-time matrices so shipments never stall when offline.
"""

from __future__ import annotations

import asyncio
import math
import time
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID, uuid4

import httpx
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from logistics.config import Settings, get_settings
from logistics.db import Database
from logistics.llm.base import LLMClient, LLMError, LLMRequest
from logistics.llm.registry import Job
from logistics.obs import get_logger

log = get_logger(__name__)

# Built-in coordinate gazetteer (latitude, longitude) for Nigerian & West African
# logistics hubs, ports, airports, and highway transit towns.
HUB_COORDINATES: dict[str, tuple[float, float]] = {
    "Lagos": (6.5244, 3.3792),
    "Ikeja": (6.6018, 3.3515),
    "Apapa Port": (6.4488, 3.3590),
    "Murtala Muhammed Cargo": (6.5774, 3.3212),
    "Ibadan": (7.3775, 3.9470),
    "Abeokuta": (7.1475, 3.3619),
    "Ilorin": (8.4966, 4.5421),
    "Lokoja": (7.8023, 6.7333),
    "Abuja": (9.0765, 7.3986),
    "Nnamdi Azikiwe Cargo": (9.0068, 7.2632),
    "Kaduna": (10.5105, 7.4165),
    "Kano": (12.0022, 8.5920),
    "Mallam Aminu Kano Cargo": (12.0476, 8.5246),
    "Benin City": (6.3350, 5.6037),
    "Warri": (5.5544, 5.7932),
    "Onitsha": (6.1413, 6.7857),
    "Enugu": (6.4584, 7.5464),
    "Port Harcourt": (4.8156, 7.0498),
    "Onne Port": (4.7238, 7.1516),
    "Port Harcourt Cargo": (5.0155, 6.9496),
    "Calabar": (4.9757, 8.3417),
    "Jos": (9.8965, 8.8583),
    "Maiduguri": (11.8311, 13.1510),
    "Sokoto": (13.0059, 5.2476),
    "Tema": (5.6698, -0.0166),
    "Tema Port": (5.6410, 0.0030),
    "Accra": (5.6037, -0.1870),
    "Kotoka Cargo": (5.6052, -0.1668),
    "Abidjan": (5.3600, -4.0083),
    "Abidjan Port": (5.2760, -4.0170),
    "Rotterdam": (51.9244, 4.4777),
    "Port of Rotterdam": (51.9490, 4.1450),
    "London": (51.5072, -0.1276),
    "Heathrow Cargo": (51.4700, -0.4543),
}

# Standard highway transit waypoints along major Nigerian freight corridors.
CORRIDOR_WAYPOINTS: dict[tuple[str, str], list[str]] = {
    ("Lagos", "Abuja"): ["Lagos", "Ibadan", "Ilorin", "Lokoja", "Abuja"],
    ("Abuja", "Lagos"): ["Abuja", "Lokoja", "Ilorin", "Ibadan", "Lagos"],
    ("Lagos", "Kano"): ["Lagos", "Ibadan", "Ilorin", "Kaduna", "Kano"],
    ("Kano", "Lagos"): ["Kano", "Kaduna", "Ilorin", "Ibadan", "Lagos"],
    ("Lagos", "Port Harcourt"): ["Lagos", "Benin City", "Warri", "Port Harcourt"],
    ("Port Harcourt", "Lagos"): ["Port Harcourt", "Warri", "Benin City", "Lagos"],
    ("Lagos", "Ibadan"): ["Lagos", "Ibadan"],
    ("Ibadan", "Lagos"): ["Ibadan", "Lagos"],
    ("Abuja", "Kano"): ["Abuja", "Kaduna", "Kano"],
    ("Kano", "Abuja"): ["Kano", "Kaduna", "Abuja"],
    ("Abuja", "Port Harcourt"): ["Abuja", "Lokoja", "Enugu", "Port Harcourt"],
    ("Port Harcourt", "Abuja"): ["Port Harcourt", "Enugu", "Lokoja", "Abuja"],
    ("Lagos", "Enugu"): ["Lagos", "Benin City", "Onitsha", "Enugu"],
    ("Enugu", "Lagos"): ["Enugu", "Onitsha", "Benin City", "Lagos"],
}

ROAD_TORTUOSITY = 1.24  # Road network distance vs great-circle distance
AVG_TRUCK_KPH = 62.0    # Realistic average commercial haulage speed in kph


@dataclass(frozen=True, slots=True)
class FleetVehicle:
    vehicle_id: str
    start_location: str
    end_location: str
    capacity_kg: int = 15_000
    earliest_hour: int = 0
    latest_hour: int = 72


@dataclass(frozen=True, slots=True)
class FleetTask:
    task_id: str
    shipment_reference: str
    pickup_location: str
    delivery_location: str
    demand_kg: int
    earliest_hour: int = 0
    latest_hour: int = 72
    service_hours: int = 1


@dataclass(frozen=True, slots=True)
class VehicleAssignment:
    vehicle_id: str
    task_ids: list[str]
    stop_locations: list[str]
    arrival_hours: list[float]
    distance_km: float
    transit_hours: float


@dataclass(frozen=True, slots=True)
class CuOptSolution:
    solver: Literal["nvidia_cuopt", "local_fallback"]
    status: str
    solution_cost: float
    total_distance_km: float
    total_transit_hours: float
    assignments: list[VehicleAssignment] = field(default_factory=list)
    waypoints: list[str] = field(default_factory=list)
    request_id: str | None = None
    latency_ms: int = 0
    raw: dict[str, Any] = field(default_factory=dict)


class RouteAdvisory(BaseModel):
    waypoints: list[str] = Field(
        default_factory=list,
        description="Ordered list of cities/hubs along the recommended route.",
    )
    risk_level: Literal["low", "medium", "high"] = "low"
    corridor_notes: str = Field(
        default="",
        description="Concise operational guidance on road conditions, checkpoints, or consolidation.",
    )
    recommended_vehicle: str | None = None


def resolve_coordinates(
    place: str,
    custom_coords: dict[str, tuple[float, float]] | None = None,
) -> tuple[float, float] | None:
    """Resolve `(lat, lon)` for a city, hub, or free-text address."""
    if not place:
        return None
    lookup = {**(custom_coords or {}), **HUB_COORDINATES}
    if place in lookup:
        return lookup[place]
    lowered = place.lower()
    for name, coords in lookup.items():
        if name.lower() in lowered or lowered in name.lower():
            return coords
    return None


def expand_route_waypoints(stops: list[str]) -> list[str]:
    """Deduplicate consecutive identical stops and expand highway corridor
    waypoints between consecutive distinct stops."""
    deduped: list[str] = []
    for s in stops:
        if s and (not deduped or deduped[-1] != s):
            deduped.append(s)
    if len(deduped) < 2:
        return deduped
    expanded: list[str] = []
    for a, b in zip(deduped, deduped[1:], strict=False):
        seg = corridor_waypoints(a, b)
        for wp in seg:
            if not expanded or expanded[-1] != wp:
                expanded.append(wp)
    return expanded


def corridor_waypoints(origin: str, destination: str) -> list[str]:
    """Return ordered highway waypoints between `origin` and `destination`."""
    direct = CORRIDOR_WAYPOINTS.get((origin, destination))
    if direct:
        return list(direct)
    if origin and destination and origin != destination:
        return [origin, destination]
    return [origin or destination or "Unknown"]


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in km between two `(lat, lon)` points."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 6371.0 * 2 * math.asin(min(1.0, math.sqrt(h)))


def road_distance_km(
    origin: str,
    destination: str,
    custom_coords: dict[str, tuple[float, float]] | None = None,
) -> float:
    """Estimated road distance in km between two named locations."""
    if origin == destination:
        return 0.0
    c1 = resolve_coordinates(origin, custom_coords)
    c2 = resolve_coordinates(destination, custom_coords)
    if c1 and c2:
        return round(max(5.0, haversine_km(c1, c2) * ROAD_TORTUOSITY), 1)
    return 450.0  # Conservative fallback when coordinates are unknown


def build_matrices(
    locations: list[str],
    custom_coords: dict[str, tuple[float, float]] | None = None,
) -> tuple[list[list[int]], list[list[int]]]:
    """Build integer `cost_matrix` (km) and `travel_time_matrix` (hours) for cuOpt."""
    cost_matrix: list[list[int]] = []
    time_matrix: list[list[int]] = []
    for src in locations:
        cost_row: list[int] = []
        time_row: list[int] = []
        for dst in locations:
            if src == dst:
                cost_row.append(0)
                time_row.append(0)
            else:
                km = road_distance_km(src, dst, custom_coords)
                hours = max(1, int(round(km / AVG_TRUCK_KPH)))
                cost_row.append(max(1, int(round(km))))
                time_row.append(hours)
        cost_matrix.append(cost_row)
        time_matrix.append(time_row)
    return cost_matrix, time_matrix


def build_cuopt_payload(
    vehicles: list[FleetVehicle],
    tasks: list[FleetTask],
    *,
    custom_coords: dict[str, tuple[float, float]] | None = None,
    time_limit_s: float = 5.0,
) -> tuple[dict[str, Any], list[str]]:
    """Construct the NVIDIA cuOpt `cuOpt_OptimizedRouting` request payload and
    return `(payload, indexed_locations)`."""
    location_index: dict[str, int] = {}
    locations: list[str] = []

    def _idx(place: str) -> int:
        norm = (place or "Lagos").strip()
        if norm not in location_index:
            location_index[norm] = len(locations)
            locations.append(norm)
        return location_index[norm]

    for v in vehicles:
        _idx(v.start_location)
        _idx(v.end_location)
    for t in tasks:
        _idx(t.pickup_location)
        _idx(t.delivery_location)

    cost_matrix, time_matrix = build_matrices(locations, custom_coords)

    vehicle_locations = [
        [_idx(v.start_location), _idx(v.end_location)] for v in vehicles
    ]
    vehicle_ids = [v.vehicle_id for v in vehicles]
    capacities = [[max(1, int(v.capacity_kg)) for v in vehicles]]
    vehicle_time_windows = [
        [int(v.earliest_hour), int(v.latest_hour)] for v in vehicles
    ]

    task_locations: list[int] = []
    task_ids: list[str] = []
    demands: list[int] = []
    pdp_pairs: list[list[int]] = []
    task_time_windows: list[list[int]] = []
    service_times: list[int] = []

    for t in tasks:
        pickup_idx = len(task_locations)
        delivery_idx = pickup_idx + 1
        pdp_pairs.append([pickup_idx, delivery_idx])

        qty = max(1, int(t.demand_kg))
        # Pickup stop
        task_locations.append(_idx(t.pickup_location))
        task_ids.append(f"{t.task_id}:PICKUP")
        demands.append(qty)
        task_time_windows.append([int(t.earliest_hour), int(t.latest_hour)])
        service_times.append(int(t.service_hours))

        # Delivery stop
        task_locations.append(_idx(t.delivery_location))
        task_ids.append(f"{t.task_id}:DELIVERY")
        demands.append(-qty)
        task_time_windows.append([int(t.earliest_hour), int(t.latest_hour)])
        service_times.append(int(t.service_hours))

    payload: dict[str, Any] = {
        "action": "cuOpt_OptimizedRouting",
        "client_version": "custom",
        "data": {
            "cost_matrix_data": {"data": {"0": cost_matrix}},
            "travel_time_matrix_data": {"data": {"0": time_matrix}},
            "fleet_data": {
                "vehicle_locations": vehicle_locations,
                "vehicle_ids": vehicle_ids,
                "capacities": capacities,
                "vehicle_time_windows": vehicle_time_windows,
            },
            "task_data": {
                "task_locations": task_locations,
                "task_ids": task_ids,
                "demand": [demands],
                "pickup_and_delivery_pairs": pdp_pairs,
                "task_time_windows": task_time_windows,
                "service_times": service_times,
            },
            "solver_config": {
                "time_limit": float(time_limit_s),
                "objectives": {"cost": 1.0, "travel_time": 1.0},
            },
        },
    }
    return payload, locations


def parse_cuopt_response(
    body: dict[str, Any],
    locations: list[str],
    cost_matrix: list[list[int]],
    time_matrix: list[list[int]],
    *,
    request_id: str | None = None,
    latency_ms: int = 0,
) -> CuOptSolution:
    """Parse the NVIDIA cuOpt solver response into a typed `CuOptSolution`."""
    resp_root = body.get("response", body)
    solver_resp = resp_root.get("solver_response", resp_root)
    vehicle_data = solver_resp.get("vehicle_data") or {}

    assignments: list[VehicleAssignment] = []
    total_km = 0.0
    total_hours = 0.0
    all_waypoints: list[str] = []

    for veh_id, vinfo in vehicle_data.items():
        route_indices = [int(i) for i in (vinfo.get("route") or [])]
        task_ids = [str(tid) for tid in (vinfo.get("task_id") or [])]
        arrivals = [float(a) for a in (vinfo.get("arrival_stamp") or [])]

        stop_names = [
            locations[idx] if 0 <= idx < len(locations) else f"loc-{idx}"
            for idx in route_indices
        ]
        veh_km = 0.0
        veh_hours = 0.0
        for a, b in zip(route_indices, route_indices[1:], strict=False):
            if 0 <= a < len(cost_matrix) and 0 <= b < len(cost_matrix[a]):
                veh_km += float(cost_matrix[a][b])
                veh_hours += float(time_matrix[a][b])

        total_km += veh_km
        total_hours += veh_hours
        for s in stop_names:
            if not all_waypoints or all_waypoints[-1] != s:
                all_waypoints.append(s)

        assignments.append(
            VehicleAssignment(
                vehicle_id=str(veh_id),
                task_ids=task_ids,
                stop_locations=stop_names,
                arrival_hours=arrivals,
                distance_km=round(veh_km, 1),
                transit_hours=round(veh_hours, 2),
            )
        )

    raw_cost = solver_resp.get("solution_cost")
    solution_cost = float(raw_cost) if raw_cost is not None else total_km
    return CuOptSolution(
        solver="nvidia_cuopt",
        status="OPTIMAL" if solver_resp.get("status", 0) == 0 else "FEASIBLE",
        solution_cost=round(solution_cost, 2),
        total_distance_km=round(total_km, 1),
        total_transit_hours=round(total_hours, 2),
        assignments=assignments,
        waypoints=expand_route_waypoints(all_waypoints),
        request_id=request_id,
        latency_ms=latency_ms,
        raw=body,
    )


def solve_vrp_locally(
    vehicles: list[FleetVehicle],
    tasks: list[FleetTask],
    *,
    custom_coords: dict[str, tuple[float, float]] | None = None,
) -> CuOptSolution:
    """Deterministic greedy VRP/PDPTW solver over the same cost/time matrix.
    Used when cuOpt cloud credentials are absent or the endpoint is offline."""
    payload, locations = build_cuopt_payload(
        vehicles, tasks, custom_coords=custom_coords
    )
    cost_matrix = payload["data"]["cost_matrix_data"]["data"]["0"]
    time_matrix = payload["data"]["travel_time_matrix_data"]["data"]["0"]
    loc_to_idx = {name: i for i, name in enumerate(locations)}

    assignments: list[VehicleAssignment] = []
    total_km = 0.0
    total_hours = 0.0
    all_waypoints: list[str] = []

    if not vehicles:
        vehicles = [FleetVehicle(vehicle_id="DEFAULT-TRUCK", start_location="Lagos", end_location="Abuja")]

    # Assign tasks across vehicles respecting capacity where possible
    buckets: dict[str, list[FleetTask]] = {v.vehicle_id: [] for v in vehicles}
    remaining_cap = {v.vehicle_id: v.capacity_kg for v in vehicles}

    for task in tasks:
        chosen = next(
            (v.vehicle_id for v in vehicles if remaining_cap[v.vehicle_id] >= task.demand_kg),
            vehicles[0].vehicle_id,
        )
        buckets[chosen].append(task)
        remaining_cap[chosen] = max(0, remaining_cap[chosen] - task.demand_kg)

    for v in vehicles:
        v_tasks = buckets[v.vehicle_id]
        if not v_tasks:
            continue

        stops: list[str] = [v.start_location]
        task_ids: list[str] = ["Depot"]
        arrivals: list[float] = [float(v.earliest_hour)]
        veh_km = 0.0
        veh_hours = 0.0
        elapsed = float(v.earliest_hour)

        for t in v_tasks:
            # Expand corridor waypoints between pickup and delivery
            wps = corridor_waypoints(t.pickup_location, t.delivery_location)
            for i, wp in enumerate(wps):
                prev = stops[-1]
                if prev != wp:
                    a, b = loc_to_idx.get(prev, 0), loc_to_idx.get(wp, 0)
                    step_km = float(cost_matrix[a][b]) if a < len(cost_matrix) and b < len(cost_matrix) else road_distance_km(prev, wp, custom_coords)
                    step_h = float(time_matrix[a][b]) if a < len(time_matrix) and b < len(time_matrix) else round(step_km / AVG_TRUCK_KPH, 2)
                    veh_km += step_km
                    veh_hours += step_h
                    elapsed += step_h
                    stops.append(wp)
                    if i == 0:
                        task_ids.append(f"{t.task_id}:PICKUP")
                    elif i == len(wps) - 1:
                        task_ids.append(f"{t.task_id}:DELIVERY")
                    else:
                        task_ids.append(f"{t.task_id}:WAYPOINT:{wp}")
                    arrivals.append(round(elapsed, 2))
                else:
                    if i == 0:
                        task_ids[-1] = f"{t.task_id}:PICKUP"

        total_km += veh_km
        total_hours += veh_hours
        for s in stops:
            if not all_waypoints or all_waypoints[-1] != s:
                all_waypoints.append(s)

        assignments.append(
            VehicleAssignment(
                vehicle_id=v.vehicle_id,
                task_ids=task_ids,
                stop_locations=stops,
                arrival_hours=arrivals,
                distance_km=round(veh_km, 1),
                transit_hours=round(veh_hours, 2),
            )
        )

    return CuOptSolution(
        solver="local_fallback",
        status="OPTIMAL",
        solution_cost=round(total_km, 2),
        total_distance_km=round(total_km, 1),
        total_transit_hours=round(total_hours, 2),
        assignments=assignments,
        waypoints=all_waypoints,
    )


class CuOptClient:
    """Async client for NVIDIA cuOpt Managed Service (`submit` + `status` polling)."""

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        db: Database | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._db = db
        self._transport = transport

    def _headers(self) -> dict[str, str]:
        headers = {
            "accept": "application/json",
            "content-type": "application/json",
        }
        if self._settings.cuopt_key is not None:
            headers["authorization"] = (
                f"Bearer {self._settings.cuopt_key.get_secret_value()}"
            )
        return headers

    async def solve(
        self,
        vehicles: list[FleetVehicle],
        tasks: list[FleetTask],
        *,
        custom_coords: dict[str, tuple[float, float]] | None = None,
        shipment_id: UUID | None = None,
        work_item_id: UUID | None = None,
    ) -> CuOptSolution:
        """Submit the routing problem to NVIDIA cuOpt, poll `/v1/status/{requestId}`
        if `202 Accepted` is returned, and fall back to `solve_vrp_locally` if
        unconfigured or unreachable."""
        if not self._settings.has_cuopt:
            return solve_vrp_locally(vehicles, tasks, custom_coords=custom_coords)

        payload, locations = build_cuopt_payload(
            vehicles,
            tasks,
            custom_coords=custom_coords,
            time_limit_s=self._settings.cuopt_time_limit_s,
        )
        cost_matrix = payload["data"]["cost_matrix_data"]["data"]["0"]
        time_matrix = payload["data"]["travel_time_matrix_data"]["data"]["0"]

        started = time.monotonic()
        request_id: str | None = None

        try:
            async with httpx.AsyncClient(
                timeout=30.0, transport=self._transport
            ) as client:
                resp = await client.post(
                    self._settings.nvidia_cuopt_url,
                    json=payload,
                    headers=self._headers(),
                )
                request_id = (
                    resp.headers.get("nvcf-reqid")
                    or resp.headers.get("x-request-id")
                )

                if resp.status_code == 202:
                    body = resp.json() if resp.content else {}
                    request_id = (
                        request_id
                        or body.get("reqId")
                        or body.get("requestId")
                        or body.get("id")
                    )
                    if not request_id:
                        raise RuntimeError("cuOpt returned 202 without a requestId")
                    body = await self.poll_status(client, str(request_id))
                else:
                    resp.raise_for_status()
                    body = resp.json()
                    if (
                        "solver_response" not in body
                        and "response" not in body
                        and (body.get("reqId") or body.get("requestId"))
                    ):
                        request_id = str(body.get("reqId") or body.get("requestId"))
                        body = await self.poll_status(client, request_id)

            latency_ms = int((time.monotonic() - started) * 1000)
            solution = parse_cuopt_response(
                body,
                locations,
                cost_matrix,
                time_matrix,
                request_id=request_id,
                latency_ms=latency_ms,
            )
            if tasks and not solution.assignments:
                raise RuntimeError(
                    f"cuOpt returned no vehicle assignments (status={solution.status})"
                )
            # Expand corridor waypoints if cuOpt only returned endpoints
            if len(solution.waypoints) == 2 and tasks:
                expanded = corridor_waypoints(
                    tasks[0].pickup_location, tasks[0].delivery_location
                )
                solution = CuOptSolution(
                    solver=solution.solver,
                    status=solution.status,
                    solution_cost=solution.solution_cost,
                    total_distance_km=solution.total_distance_km,
                    total_transit_hours=solution.total_transit_hours,
                    assignments=solution.assignments,
                    waypoints=expanded,
                    request_id=solution.request_id,
                    latency_ms=solution.latency_ms,
                    raw=solution.raw,
                )

            await self._record_tool_call(
                shipment_id=shipment_id,
                work_item_id=work_item_id,
                request={"vehicles": len(vehicles), "tasks": len(tasks), "locations": locations},
                response={
                    "status": solution.status,
                    "solution_cost": solution.solution_cost,
                    "distance_km": solution.total_distance_km,
                    "request_id": request_id,
                    "latency_ms": latency_ms,
                },
                error=None,
            )
            return solution

        except Exception as exc:  # noqa: BLE001
            log.warning("cuopt.fallback_to_local", error=str(exc), request_id=request_id)
            await self._record_tool_call(
                shipment_id=shipment_id,
                work_item_id=work_item_id,
                request={"vehicles": len(vehicles), "tasks": len(tasks), "locations": locations},
                response=None,
                error=str(exc)[:300],
            )
            return solve_vrp_locally(vehicles, tasks, custom_coords=custom_coords)

    async def poll_status(
        self, client: httpx.AsyncClient, request_id: str
    ) -> dict[str, Any]:
        """Poll `GET https://optimize.api.nvidia.com/v1/status/{requestId}` until
        the solver finishes."""
        base = self._settings.nvidia_cuopt_status_url.rstrip("/")
        url = f"{base}/{request_id}"
        deadline = time.monotonic() + self._settings.cuopt_poll_timeout_s
        delay = 0.5

        headers = {"accept": "application/json"}
        if self._settings.cuopt_key is not None:
            headers["authorization"] = (
                f"Bearer {self._settings.cuopt_key.get_secret_value()}"
            )

        while time.monotonic() < deadline:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 202:
                await asyncio.sleep(delay)
                delay = min(delay * 1.5, 3.0)
                continue
            resp.raise_for_status()
            data = resp.json()
            status_str = str(data.get("status") or "").lower()
            if status_str in ("pending", "running", "queued", "in_progress"):
                await asyncio.sleep(delay)
                delay = min(delay * 1.5, 3.0)
                continue
            return data

        raise TimeoutError(f"cuOpt request {request_id} timed out after {self._settings.cuopt_poll_timeout_s}s")

    async def _record_tool_call(
        self,
        *,
        shipment_id: UUID | None,
        work_item_id: UUID | None,
        request: dict[str, Any],
        response: dict[str, Any] | None,
        error: str | None,
    ) -> None:
        if self._db is None:
            return
        idem_key = f"cuopt:{work_item_id or uuid4()}:{int(time.time() * 1000)}"
        payload = {**request, "work_item_id": str(work_item_id) if work_item_id else None}
        try:
            async with self._db.connection() as conn:
                await conn.execute(
                    """
                    INSERT INTO tool_calls
                        (idempotency_key, shipment_id, tool, tier, state,
                         request, response, error, completed_at)
                    VALUES (%s, %s, 'nvidia.cuopt', 0, %s, %s, %s, %s, now())
                    ON CONFLICT (idempotency_key) DO NOTHING
                    """,
                    (
                        idem_key,
                        shipment_id,
                        "FAILED" if error else "RESULT",
                        Jsonb(payload),
                        Jsonb(response) if response is not None else None,
                        error,
                    ),
                )
        except Exception as exc:  # noqa: BLE001
            log.warning("cuopt.audit_log_failed", error=str(exc))


async def ai_route_advisory(
    llm: LLMClient,
    *,
    origin: str,
    destination: str,
    weight_kg: float,
    waypoints: list[str],
    distance_km: float,
    transit_hours: float,
    shipment_id: UUID | None = None,
    work_item_id: UUID | None = None,
) -> RouteAdvisory | None:
    """Ask `nvidia/nemotron-3.5-super-vl-120b-a12b` (`Job.ROUTE_OPTIMIZATION`)
    for route waypoint refinement and dispatch risk notes."""
    prompt = (
        f"Origin: {origin}\n"
        f"Destination: {destination}\n"
        f"Cargo weight: {weight_kg} kg\n"
        f"cuOpt planned waypoints: {' -> '.join(waypoints)}\n"
        f"Estimated distance: {distance_km} km ({transit_hours} hours)\n\n"
        "Provide an operational route advisory for this haulage corridor, "
        "including ordered waypoints, risk_level (low/medium/high), and concise "
        "corridor_notes (checkpoints, terrain, or consolidation advice)."
    )
    try:
        result = await llm.structured(
            LLMRequest(
                job=Job.ROUTE_OPTIMIZATION,
                system=(
                    "You are an enterprise logistics route planner working alongside "
                    "NVIDIA cuOpt. Return a JSON object matching the RouteAdvisory schema."
                ),
                messages=[{"role": "user", "content": prompt}],
                agent="planning",
                shipment_id=shipment_id,
                work_item_id=work_item_id,
                prompt_version="routing.advisory/v1",
            ),
            RouteAdvisory,
        )
        return result.value
    except LLMError as exc:
        log.warning("routing.ai_advisory_failed", error=str(exc))
        return None

