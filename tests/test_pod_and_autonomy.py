"""Unit tests for POD verification, approval routing, state-route completeness,
schema invariants, and autonomous loop readiness."""

from __future__ import annotations

import inspect
from pathlib import Path

from logistics.domain.states import ShipmentState, can_transition
from logistics.handlers import registry
from logistics.handlers.approval import decision_transition, is_standard_booking
from logistics.handlers.base import HandlerRegistry
from logistics.handlers.pod import MIN_POD_CONFIDENCE, assess_pod
from logistics.orchestrator.policy import DEFAULT_POLICY_RULES
from logistics.orchestrator.routing import STATE_ROUTES
from logistics.orchestrator.worker import (
    LLM_REQUIRED_LOOPS,
    RECURRING_LOOPS,
    eligible_recurring_loops,
)
from logistics.routing.cuopt import CuOptClient
from logistics.tracking.detection import DetectionKind


def test_every_state_route_has_a_registered_handler():
    """No shipment state may auto-route to an unregistered handler kind."""
    missing = [
        f"{state} -> {kind}"
        for state, kind in STATE_ROUTES.items()
        if registry.get(kind) is None
    ]
    assert not missing, f"STATE_ROUTES references unregistered handlers: {missing}"


def test_every_autonomous_recurring_loop_is_registered():
    """The worker's autonomous background loops must all resolve to live handlers."""
    for kind, _priority in RECURRING_LOOPS:
        assert registry.get(kind) is not None, f"recurring loop {kind!r} is not registered"


def test_exception_can_transition_to_planned_for_carrier_resourcing():
    assert can_transition(ShipmentState.EXCEPTION, ShipmentState.PLANNED)
    assert can_transition(ShipmentState.AWAITING_APPROVAL, ShipmentState.IN_TRANSIT)


def test_default_policy_rules_cover_required_actions():
    assert DEFAULT_POLICY_RULES["base_currency"] == "NGN"
    actions = DEFAULT_POLICY_RULES["actions"]
    for required in (
        "book_shipment",
        "reroute_vehicle",
        "cancel_shipment",
        "change_delivery_address",
    ):
        assert required in actions


def test_assess_pod_verifies_clean_document():
    res = assess_pod(
        {
            "id": "doc-1",
            "extracted": {"received_quantity": 50, "damaged": False},
            "extraction_confidence": 0.94,
            "verified_at": None,
        },
        expected_quantity=50,
    )
    assert res.verified is True
    assert res.source == "pod_document"
    assert res.discrepancy is None


def test_assess_pod_flags_damage_and_short_delivery():
    damaged = assess_pod(
        {
            "id": "doc-2",
            "extracted": {"damaged": True, "damage_notes": "3 cartons crushed"},
            "extraction_confidence": 0.95,
            "verified_at": None,
        },
        expected_quantity=50,
    )
    assert damaged.verified is False
    assert "crushed" in (damaged.discrepancy or "")

    short = assess_pod(
        {
            "id": "doc-3",
            "extracted": {"received_quantity": 42},
            "extraction_confidence": 0.92,
            "verified_at": None,
        },
        expected_quantity=50,
    )
    assert short.verified is False
    assert "42" in (short.discrepancy or "")


def test_assess_pod_flags_low_confidence_unverified_scan():
    low = assess_pod(
        {
            "id": "doc-4",
            "extracted": {"received_quantity": 50},
            "extraction_confidence": MIN_POD_CONFIDENCE - 0.1,
            "verified_at": None,
        },
        expected_quantity=50,
    )
    assert low.verified is False
    assert "confidence" in (low.discrepancy or "").lower()


def test_assess_pod_falls_back_to_tracking_confirmation_when_clean():
    clean = assess_pod(None, expected_quantity=50, open_exceptions=[])
    assert clean.verified is True
    assert clean.source == "tracking_confirmation"

    blocked = assess_pod(
        None,
        expected_quantity=50,
        open_exceptions=[{"kind": "DAMAGE", "summary": "Forklift puncture"}],
    )
    assert blocked.verified is False
    assert "Forklift" in (blocked.discrepancy or "")


def test_assess_pod_blocks_unverified_scan_when_critical_exception_is_open():
    """An unverified POD scan must not auto-close a shipment with open damage."""
    blocked = assess_pod(
        {
            "id": "doc-5",
            "extracted": {"received_quantity": 50, "damaged": False},
            "extraction_confidence": 0.96,
            "verified_at": None,
        },
        expected_quantity=50,
        open_exceptions=[{"kind": "DAMAGE", "summary": "Wet pallets reported"}],
    )
    assert blocked.verified is False
    assert blocked.source == "open_exception"
    assert "Wet pallets" in (blocked.discrepancy or "")

    # A human-verified POD overrides open tracking findings.
    verified = assess_pod(
        {
            "id": "doc-5",
            "extracted": {"received_quantity": 50, "damaged": False},
            "extraction_confidence": 0.96,
            "verified_at": "2026-11-22T00:00:00Z",
        },
        expected_quantity=50,
        open_exceptions=[{"kind": "DAMAGE", "summary": "Wet pallets reported"}],
    )
    assert verified.verified is True


def test_assess_pod_handles_boolean_and_string_quantities_safely():
    """Python booleans are int subclasses and must never count as received_quantity."""
    bool_qty = assess_pod(
        {
            "id": "doc-6",
            "extracted": {"received_quantity": True},
            "extraction_confidence": 0.95,
            "verified_at": None,
        },
        expected_quantity=50,
    )
    assert bool_qty.verified is True

    str_short = assess_pod(
        {
            "id": "doc-7",
            "extracted": {"received_quantity": "40"},
            "extraction_confidence": 0.95,
            "verified_at": None,
        },
        expected_quantity=50,
    )
    assert str_short.verified is False
    assert "40" in (str_short.discrepancy or "")


def test_resource_carrier_with_none_replacing_is_not_treated_as_standard_booking():
    """`exception_agent/resolve.py::RESOURCE_CARRIER` passes `replacing: None`
    when no carrier was booked yet; it must route back to PLANNED, not carrier.book."""
    assert is_standard_booking("book_shipment", {"round": 1, "carrier_code": "T-A"}) is True
    assert is_standard_booking("book_shipment", {"replacing": "T-CHEAP"}) is False
    assert is_standard_booking("book_shipment", {"replacing": None}) is False

    assert (
        decision_transition(
            "book_shipment",
            {"replacing": None},
            ShipmentState.AWAITING_APPROVAL,
            approved=True,
            has_booking=False,
        )
        is ShipmentState.PLANNED
    )


def test_rejected_or_expired_exception_approval_returns_to_exception_not_planned():
    """Rejecting an in-transit exception approval must never re-enter PLANNED/carrier.source."""
    for action, params in (
        ("book_shipment", {"replacing": "T-CHEAP"}),
        ("reroute_vehicle", {"carrier_code": "T-SOLID"}),
        ("send_whatsapp", {"message": "Delayed by 2h"}),
    ):
        assert (
            decision_transition(
                action,
                params,
                ShipmentState.AWAITING_APPROVAL,
                approved=False,
                has_booking=True,
            )
            is ShipmentState.EXCEPTION
        ), f"rejected {action} must return to EXCEPTION"

    # Standard booking rejection still re-sources from PLANNED.
    assert (
        decision_transition(
            "book_shipment",
            {"round": 1},
            ShipmentState.AWAITING_APPROVAL,
            approved=False,
            has_booking=False,
        )
        is ShipmentState.PLANNED
    )

    # Customer change request rejection on an in-transit shipment leaves it untouched.
    assert (
        decision_transition(
            "change_delivery_address",
            {"requested_by": "customer"},
            ShipmentState.IN_TRANSIT,
            approved=False,
            has_booking=True,
        )
        is None
    )


def test_eligible_recurring_loops_skips_llm_loops_when_no_llm_configured():
    with_llm = [k for k, _ in eligible_recurring_loops(registry, has_llm=True)]
    without_llm = [k for k, _ in eligible_recurring_loops(registry, has_llm=False)]
    assert "channels.poll" in without_llm
    assert "detection.sweep" in without_llm
    for llm_loop in LLM_REQUIRED_LOOPS:
        assert llm_loop in with_llm
        assert llm_loop not in without_llm
    assert eligible_recurring_loops(HandlerRegistry(), has_llm=True) == []


def test_cuopt_audit_insert_matches_tool_calls_schema():
    """Regression guard: tool_calls has idempotency_key NOT NULL and no work_item_id column."""
    src = inspect.getsource(CuOptClient._record_tool_call)
    assert "idempotency_key" in src
    assert "ON CONFLICT (idempotency_key)" in src
    assert "(shipment_id, work_item_id" not in src

    core_sql = (
        Path(__file__).resolve().parents[1] / "migrations" / "001_core.sql"
    ).read_text(encoding="utf-8")
    assert "idempotency_key  TEXT        NOT NULL UNIQUE" in core_sql


def test_detection_kinds_cover_allocation_sourcing_and_pod():
    for kind in ("POD_DISCREPANCY", "ALLOCATION_SHORT", "NO_CARRIERS", "SOURCING_EXHAUSTED"):
        assert kind in {str(k) for k in DetectionKind}


def test_wpcargo_sync_handler_is_registered_and_payload_maps_international_countries():
    from logistics.support.wpcargo import (
        _infer_country,
        build_wpcargo_payload,
        status_for_shipment_state,
    )

    assert registry.get("wpcargo.sync") is not None

    payload = build_wpcargo_payload(
        {"post_ID": "42", "_wpnonce": "nonce-1"},
        {
            "pickup": "Apapa Port, Lagos",
            "destination": "Port of Rotterdam, Netherlands",
            "description": "Cocoa beans",
            "quantity": 120,
            "weight_kg": 4500,
            "shipper_name": "DHL Exports",
            "status": "In Transit",
        },
        reference="LG-99001",
    )
    assert payload["wpcargo_status"] == "In Transit"
    assert payload["status"] == "In Transit"
    assert payload["wpcargo_origin_field"] == "Nigeria"
    assert payload["wpcargo_destination"] == "Netherlands"
    assert payload["wpcargo_mode_field"] == "Sea Transport"
    assert payload["wpcargo_type_of_shipment"] == "International Shipping"

    assert _infer_country("Tema Port, Accra") == "Ghana"
    assert _infer_country("Jebel Ali, Dubai") == "United Arab Emirates"
    assert _infer_country("Abidjan Port") == "Cote d'Ivoire"
    assert _infer_country("Cotonou Terminal") == "Benin"
    assert _infer_country("Shanghai Pudong") == "China"
    assert _infer_country("Heathrow Cargo, London") == "United Kingdom"

    for state in ShipmentState:
        assert status_for_shipment_state(str(state)) in {
            "Pending",
            "Picked Up",
            "In Transit",
            "On Hold",
            "Delivered",
            "Cancelled",
        }


def test_validate_deterministic_issues_rejects_boolean_weight_and_quantity():
    from types import SimpleNamespace
    from logistics.handlers.validate import _deterministic_issues

    shipment = SimpleNamespace(
        origin={"address": "12 Broad St, Lagos"},
        destination={"address": "44 Aminu Kano Cres, Abuja"},
        cargo={"weight_kg": True, "quantity": False},
        deadline=None,
    )
    issues = _deterministic_issues(shipment)
    fields = {i.field for i in issues if i.severity == "blocking"}
    assert "cargo.weight_kg" in fields
    assert "cargo.quantity" in fields


def test_cuopt_payload_supports_extended_multi_day_time_windows():
    from logistics.routing.cuopt import (
        FleetTask,
        FleetVehicle,
        build_cuopt_payload,
        solve_vrp_locally,
    )

    vehicles = [
        FleetVehicle("TRK-01", "Lagos", "Kano", capacity_kg=20_000, latest_hour=168)
    ]
    tasks = [
        FleetTask("LG-88001", "LG-88001", "Lagos", "Kano", demand_kg=6_000, latest_hour=144)
    ]
    payload, locations = build_cuopt_payload(vehicles, tasks)
    assert locations == ["Lagos", "Kano"]
    assert payload["data"]["fleet_data"]["vehicle_time_windows"] == [[0, 168]]
    assert payload["data"]["task_data"]["task_time_windows"] == [[0, 144], [0, 144]]

    sol = solve_vrp_locally(vehicles, tasks)
    assert sol.solver == "local_fallback"
    assert sol.assignments and sol.assignments[0].vehicle_id == "TRK-01"
    assert "Kaduna" in sol.waypoints


def test_analytics_json_safe_row_converts_decimal_to_float():
    import json
    from decimal import Decimal
    from logistics.analytics import _json_safe_row

    row = _json_safe_row({
        "code": "CARRIER-A",
        "shipments": 4,
        "share_pct": Decimal("67"),
        "on_time_rate": Decimal("0.94"),
    })
    assert isinstance(row["share_pct"], float)
    assert isinstance(row["on_time_rate"], float)
    assert json.dumps(row)


async def test_ensure_tracking_partitions_works_under_app_role(db):
    """Regression guard: `detection.sweep` calls `ensure_tracking_partitions(3)`
    as `logistics_app` (non-owner); migration 022 makes it SECURITY DEFINER."""
    async with db.connection() as conn:
        cur = await conn.execute("SELECT ensure_tracking_partitions(3) AS count")
        row = await cur.fetchone()
    assert row["count"] == 4

