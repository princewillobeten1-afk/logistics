"""NVIDIA cuOpt + Nemotron 3.5 Super VL routing and fleet dispatch optimization."""

from logistics.routing.cuopt import (
    CuOptClient,
    CuOptSolution,
    FleetTask,
    FleetVehicle,
    RouteAdvisory,
    VehicleAssignment,
    ai_route_advisory,
    build_cuopt_payload,
    build_matrices,
    corridor_waypoints,
    resolve_coordinates,
    solve_vrp_locally,
)

__all__ = [
    "CuOptClient",
    "CuOptSolution",
    "FleetTask",
    "FleetVehicle",
    "RouteAdvisory",
    "VehicleAssignment",
    "ai_route_advisory",
    "build_cuopt_payload",
    "build_matrices",
    "corridor_waypoints",
    "resolve_coordinates",
    "solve_vrp_locally",
]

