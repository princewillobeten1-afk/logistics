"""Tests for NVIDIA cuOpt route optimization and Nemotron 3.5 Super VL route advisory."""

from __future__ import annotations

import json
from uuid import uuid4

import httpx
from pydantic import SecretStr

from logistics.config import Settings
from logistics.domain.models import WorkItem
from logistics.domain.states import ShipmentState
from logistics.handlers.base import StepContext
from logistics.handlers.plan import optimize_fleet, plan
from logistics.llm.registry import Job, spec_for
from logistics.routing.cuopt import (
    CuOptClient,
    FleetTask,
    FleetVehicle,
    ai_route_advisory,
    build_cuopt_payload,
    solve_vrp_locally,
)
from tests.conftest import ScriptedLLM


def test_route_optimization_job_uses_nemotron_3_5_super_vl():
    spec = spec_for(Job.ROUTE_OPTIMIZATION)
    assert spec.model == "nvidia/nemotron-3.5-super-vl-120b-a12b"
    assert spec.reasoning is True
    assert spec.temperature == 0.0


def test_build_cuopt_payload_matches_nvidia_managed_service_schema():
    vehicles = [
        FleetVehicle(
            vehicle_id="TRK-LAG-01",
            start_location="Lagos",
            end_location="Abuja",
            capacity_kg=15_000,
        )
    ]
    tasks = [
        FleetTask(
            task_id="SHP-101",
            shipment_reference="SHP-101",
            pickup_location="Lagos",
            delivery_location="Abuja",
            demand_kg=2_400,
        )
    ]

    payload, locations = build_cuopt_payload(vehicles, tasks, time_limit_s=5.0)

    assert payload["action"] == "cuOpt_OptimizedRouting"
    assert payload["client_version"] == "custom"
    assert locations == ["Lagos", "Abuja"]

    data = payload["data"]
    cost_matrix = data["cost_matrix_data"]["data"]["0"]
    time_matrix = data["travel_time_matrix_data"]["data"]["0"]
    assert len(cost_matrix) == 2 and len(cost_matrix[0]) == 2
    assert cost_matrix[0][0] == 0
    assert cost_matrix[0][1] > 500
    assert time_matrix[0][1] >= 8

    assert data["fleet_data"]["vehicle_ids"] == ["TRK-LAG-01"]
    assert data["fleet_data"]["vehicle_locations"] == [[0, 1]]
    assert data["fleet_data"]["capacities"] == [[15_000]]

    assert data["task_data"]["task_ids"] == ["SHP-101:PICKUP", "SHP-101:DELIVERY"]
    assert data["task_data"]["task_locations"] == [0, 1]
    assert data["task_data"]["demand"] == [[2_400, -2_400]]
    assert data["task_data"]["pickup_and_delivery_pairs"] == [[0, 1]]


async def test_cuopt_client_handles_sync_200_response():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL("https://optimize.api.nvidia.com/v1/nvidia/cuopt")
        assert request.headers["authorization"] == "Bearer nvapi-test-key"
        body = json.loads(request.content.decode())
        assert body["action"] == "cuOpt_OptimizedRouting"
        return httpx.Response(
            200,
            headers={"nvcf-reqid": "req-sync-001"},
            json={
                "response": {
                    "solver_response": {
                        "status": 0,
                        "solution_cost": 652.0,
                        "vehicle_data": {
                            "TRK-LAG-01": {
                                "route": [0, 1],
                                "task_id": ["SHP-101:PICKUP", "SHP-101:DELIVERY"],
                                "arrival_stamp": [0.0, 11.0],
                            }
                        },
                    }
                }
            },
        )

    cfg = Settings(
        nvidia_api_key=SecretStr("nvapi-test-key"),
        _env_file=None,
    )
    client = CuOptClient(cfg, transport=httpx.MockTransport(handler))
    solution = await client.solve(
        [FleetVehicle("TRK-LAG-01", "Lagos", "Abuja", 15_000)],
        [FleetTask("SHP-101", "SHP-101", "Lagos", "Abuja", 2_000)],
    )

    assert solution.solver == "nvidia_cuopt"
    assert solution.status == "OPTIMAL"
    assert solution.request_id == "req-sync-001"
    assert solution.assignments[0].vehicle_id == "TRK-LAG-01"
    assert solution.waypoints == ["Lagos", "Ibadan", "Ilorin", "Lokoja", "Abuja"]


async def test_cuopt_client_polls_status_endpoint_on_202():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url}")
        if request.method == "POST":
            return httpx.Response(
                202,
                headers={"nvcf-reqid": "req-async-777"},
                json={"reqId": "req-async-777", "status": "pending"},
            )
        assert str(request.url) == "https://optimize.api.nvidia.com/v1/status/req-async-777"
        if len(calls) == 2:
            return httpx.Response(202, json={"status": "running"})
        return httpx.Response(
            200,
            json={
                "response": {
                    "solver_response": {
                        "status": 0,
                        "solution_cost": 910.0,
                        "vehicle_data": {
                            "TRK-NORTH-02": {
                                "route": [0, 1],
                                "task_id": ["SHP-202:PICKUP", "SHP-202:DELIVERY"],
                                "arrival_stamp": [0.0, 15.0],
                            }
                        },
                    }
                }
            },
        )

    cfg = Settings(
        nvidia_api_key=SecretStr("nvapi-test-key"),
        _env_file=None,
    )
    client = CuOptClient(cfg, transport=httpx.MockTransport(handler))
    solution = await client.solve(
        [FleetVehicle("TRK-NORTH-02", "Lagos", "Kano", 20_000)],
        [FleetTask("SHP-202", "SHP-202", "Lagos", "Kano", 5_000)],
    )

    assert len(calls) == 3
    assert solution.solver == "nvidia_cuopt"
    assert solution.request_id == "req-async-777"
    assert solution.waypoints == ["Lagos", "Ibadan", "Ilorin", "Kaduna", "Kano"]


async def test_cuopt_client_falls_back_cleanly_on_upstream_error():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"detail": "Service unavailable"})

    cfg = Settings(
        nvidia_api_key=SecretStr("nvapi-test-key"),
        _env_file=None,
    )
    client = CuOptClient(cfg, transport=httpx.MockTransport(handler))
    solution = await client.solve(
        [FleetVehicle("TRK-01", "Lagos", "Port Harcourt", 15_000)],
        [FleetTask("SHP-303", "SHP-303", "Lagos", "Port Harcourt", 3_000)],
    )

    assert solution.solver == "local_fallback"
    assert solution.status == "OPTIMAL"
    assert solution.waypoints == ["Lagos", "Benin City", "Warri", "Port Harcourt"]


async def test_ai_route_advisory_parses_structured_output():
    llm = ScriptedLLM(
        json.dumps(
            {
                "waypoints": ["Lagos", "Ibadan", "Ilorin", "Lokoja", "Abuja"],
                "risk_level": "medium",
                "corridor_notes": "Heavy commercial traffic at Lokoja bridge; schedule early departure.",
                "recommended_vehicle": "10-ton truck",
            }
        )
    )
    advisory = await ai_route_advisory(
        llm,
        origin="Lagos",
        destination="Abuja",
        weight_kg=6_000,
        waypoints=["Lagos", "Abuja"],
        distance_km=750,
        transit_hours=11.5,
    )
    assert advisory is not None
    assert advisory.risk_level == "medium"
    assert "Lokoja" in advisory.waypoints
    assert "Lokoja bridge" in advisory.corridor_notes


async def test_plan_handler_persists_route_and_cuopt_metadata(db, settings, repo, reference):
    shipment = await repo.create(
        reference=reference,
        state=ShipmentState.ALLOCATED,
        origin={"city": "Lagos"},
        destination={"city": "Abuja"},
        cargo={"quantity": 40, "weight_kg": 2_500},
    )
    llm = ScriptedLLM(
        json.dumps(
            {
                "waypoints": ["Lagos", "Ibadan", "Ilorin", "Lokoja", "Abuja"],
                "risk_level": "low",
                "corridor_notes": "Standard expressway route via Lokoja.",
                "recommended_vehicle": "3-ton truck",
            }
        )
    )
    ctx = StepContext(
        item=WorkItem(
            id=uuid4(),
            kind="planning.plan",
            payload={},
            attempts=1,
            max_attempts=5,
            shipment_id=shipment.id,
        ),
        shipment=shipment,
        db=db,
        settings=settings,
        llm=llm,
    )

    result = await plan(ctx)
    assert result.transition is ShipmentState.PLANNED
    plan_data = result.patch["plan"]
    assert plan_data["waypoints"] == ["Lagos", "Ibadan", "Ilorin", "Lokoja", "Abuja"]
    assert plan_data["ai_risk_level"] == "low"
    assert "Lokoja" in plan_data["ai_route_notes"]

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT name, waypoints, risk_notes FROM routes WHERE name = 'Lagos → Abuja'"
        )
        route_row = await cur.fetchone()
        assert route_row is not None
        assert "Lokoja" in route_row["waypoints"]


async def test_optimize_fleet_handler_assigns_vehicles_to_queued_shipments(
    db, settings, repo
):
    s1 = await repo.create(
        reference="FLT-001",
        state=ShipmentState.PLANNED,
        origin={"city": "Lagos"},
        destination={"city": "Abuja"},
        cargo={"quantity": 20, "weight_kg": 1_500},
    )
    s2 = await repo.create(
        reference="FLT-002",
        state=ShipmentState.ALLOCATED,
        origin={"city": "Abuja"},
        destination={"city": "Kano"},
        cargo={"quantity": 30, "weight_kg": 2_000},
    )

    ctx = StepContext(
        item=WorkItem(
            id=uuid4(),
            kind="planning.optimize_fleet",
            payload={},
            attempts=1,
            max_attempts=5,
        ),
        shipment=None,
        db=db,
        settings=settings,
    )
    await optimize_fleet(ctx)

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT reference, plan FROM shipments WHERE id IN (%s, %s) ORDER BY reference",
            (s1.id, s2.id),
        )
        rows = await cur.fetchall()

    assert len(rows) == 2
    assert rows[0]["plan"]["assigned_vehicle"]
    assert "Lokoja" in rows[0]["plan"]["waypoints"]
    assert "Kaduna" in rows[1]["plan"]["waypoints"]

