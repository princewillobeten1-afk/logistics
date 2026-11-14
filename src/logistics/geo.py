"""Geospatial arithmetic.

Shared by allocation (which warehouse is nearest) and tracking (how far off
course is this truck). Great-circle rather than road distance: good enough to
choose between warehouses and to flag a deviation, and it needs no routing
provider. Real road distance comes from the routing service at planning time.
"""

from __future__ import annotations

import math

Coordinates = tuple[float, float]

EARTH_RADIUS_KM = 6371.0


def haversine_km(a: Coordinates, b: Coordinates) -> float:
    """Great-circle distance between two lat/lon points."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return EARTH_RADIUS_KM * 2 * math.asin(math.sqrt(h))


def bearing_deg(a: Coordinates, b: Coordinates) -> float:
    """Initial bearing from a to b, in degrees clockwise from north."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def cross_track_km(point: Coordinates, start: Coordinates, end: Coordinates) -> float:
    """Perpendicular distance from `point` to the great circle through
    start→end. This is what "off course" means numerically.

    Returns the absolute distance; sign (which side) is not useful here.
    """
    if start == end:
        return haversine_km(point, start)

    d13 = haversine_km(start, point) / EARTH_RADIUS_KM
    theta13 = math.radians(bearing_deg(start, point))
    theta12 = math.radians(bearing_deg(start, end))
    return abs(math.asin(math.sin(d13) * math.sin(theta13 - theta12)) * EARTH_RADIUS_KM)


def along_track_km(point: Coordinates, start: Coordinates, end: Coordinates) -> float:
    """Distance travelled along the start→end path, projected.

    Can exceed the leg length (overshot) or go negative (behind the origin);
    callers clamp when they need a progress fraction.
    """
    if start == end:
        return 0.0

    d13 = haversine_km(start, point) / EARTH_RADIUS_KM
    theta13 = math.radians(bearing_deg(start, point))
    theta12 = math.radians(bearing_deg(start, end))
    xtd = math.asin(math.sin(d13) * math.sin(theta13 - theta12))

    # Guard the domain: cos(xtd) can drift fractionally past 1 near the path.
    ratio = math.cos(d13) / max(1e-12, math.cos(xtd))
    return math.acos(max(-1.0, min(1.0, ratio))) * EARTH_RADIUS_KM
