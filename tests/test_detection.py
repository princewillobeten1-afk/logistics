"""Detection rules — pure, no database, no model."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from logistics.geo import cross_track_km, haversine_km
from logistics.tracking.detection import (
    DetectionKind,
    Severity,
    Thresholds,
    actionable,
    check_dwell,
    check_missed_checkpoint,
    check_signal_lost,
    check_temperature,
    detect_on_event,
    detect_stale,
    worst,
)
from logistics.tracking.eta import effective_speed, estimate_progress

NOW = datetime(2026, 8, 29, 12, 0, tzinfo=UTC)

LAGOS = (6.5244, 3.3792)
IBADAN = (7.3775, 3.9470)
ABUJA = (9.0765, 7.3986)
KANO = (12.0022, 8.5920)

T = Thresholds()


def _progress(position, at=NOW, speeds=None, origin=LAGOS, destination=ABUJA):
    return estimate_progress(
        position=position,
        origin=origin,
        destination=destination,
        at=at,
        observed_speeds=speeds or [],
    )


# --------------------------------------------------------------------- geo


def test_haversine_lagos_to_abuja():
    assert 500 < haversine_km(LAGOS, ABUJA) < 560


def test_cross_track_is_zero_on_the_path():
    # A point on the Lagos→Abuja line has no perpendicular offset.
    mid = ((LAGOS[0] + ABUJA[0]) / 2, (LAGOS[1] + ABUJA[1]) / 2)
    assert cross_track_km(mid, LAGOS, ABUJA) < 15


def test_cross_track_grows_off_the_path():
    assert cross_track_km(KANO, LAGOS, ABUJA) > 200


# --------------------------------------------------------------------- eta


def test_speed_ignores_stationary_pings():
    """A truck parked for an hour has not changed how fast it travels."""
    assert effective_speed([60, 62, 0, 0, 58]) == 60.0


def test_speed_falls_back_when_never_moving():
    assert effective_speed([0, 0, 0], fallback=55) == 55.0


def test_progress_at_origin_is_zero():
    p = _progress(LAGOS)
    assert p.fraction_complete < 0.02
    assert p.distance_remaining_km > 500


def test_progress_near_destination_is_complete():
    p = _progress(ABUJA)
    assert p.fraction_complete > 0.98
    assert p.distance_remaining_km < 5


def test_eta_uses_observed_speed():
    fast = _progress(IBADAN, speeds=[90, 92, 88])
    slow = _progress(IBADAN, speeds=[30, 28, 32])
    assert fast.eta < slow.eta


# ------------------------------------------------------------- eta drift


def test_no_drift_when_on_schedule():
    p = _progress(IBADAN, speeds=[60])
    on_time = p.eta + timedelta(hours=2)
    assert detect_on_event(progress=p, now=NOW, planned_arrival=on_time) == []


def test_drift_detected_when_running_late():
    p = _progress(IBADAN, speeds=[40])
    found = detect_on_event(
        progress=p, now=NOW, planned_arrival=p.eta - timedelta(hours=3)
    )
    kinds = {d.kind for d in found}
    assert DetectionKind.ETA_DRIFT in kinds


def test_drift_severity_scales():
    p = _progress(IBADAN, speeds=[50])
    small = detect_on_event(
        progress=p, now=NOW, planned_arrival=p.eta - timedelta(minutes=45)
    )
    large = detect_on_event(
        progress=p, now=NOW, planned_arrival=p.eta - timedelta(hours=9)
    )
    drift_small = next(d for d in small if d.kind is DetectionKind.ETA_DRIFT)
    drift_large = next(d for d in large if d.kind is DetectionKind.ETA_DRIFT)
    assert drift_small.severity is Severity.MEDIUM
    assert drift_large.severity in (Severity.HIGH, Severity.CRITICAL)


# ------------------------------------------------------------ sla breach


def test_sla_breach_outranks_eta_drift():
    """Both fire; the contracted promise must sort first."""
    p = _progress(IBADAN, speeds=[35])
    found = detect_on_event(
        progress=p,
        now=NOW,
        planned_arrival=p.eta - timedelta(hours=4),
        deadline=p.eta - timedelta(hours=3),
    )
    assert found[0].kind is DetectionKind.SLA_BREACH_RISK
    assert found[0].severity is Severity.CRITICAL


def test_no_sla_breach_when_inside_the_deadline():
    p = _progress(IBADAN, speeds=[70])
    found = detect_on_event(
        progress=p, now=NOW, deadline=p.eta + timedelta(days=1)
    )
    assert all(d.kind is not DetectionKind.SLA_BREACH_RISK for d in found)


def test_sla_breach_carries_the_numbers_an_operator_needs():
    p = _progress(IBADAN, speeds=[35])
    found = detect_on_event(progress=p, now=NOW, deadline=p.eta - timedelta(hours=2))
    breach = found[0]
    assert "deadline" in breach.detail
    assert "projected_arrival" in breach.detail
    assert breach.detail["over_by_minutes"] > 100


# ------------------------------------------------------- route deviation


def test_deviation_detected_far_off_route():
    found = detect_on_event(progress=_progress(KANO), now=NOW)
    deviation = next(d for d in found if d.kind is DetectionKind.ROUTE_DEVIATION)
    assert deviation.severity in (Severity.HIGH, Severity.CRITICAL)


def test_no_deviation_on_the_corridor():
    """Ibadan is ~46 km off the Lagos→Abuja straight line and is on the normal
    road. A corridor tight enough to exclude it would alert on every correctly
    routed truck."""
    assert 40 < cross_track_km(IBADAN, LAGOS, ABUJA) < 60
    found = detect_on_event(progress=_progress(IBADAN), now=NOW)
    assert all(d.kind is not DetectionKind.ROUTE_DEVIATION for d in found)


# ------------------------------------------------------------------ dwell


def test_dwell_ignores_a_short_stop():
    assert check_dwell(NOW - timedelta(minutes=20), NOW, T) is None


def test_dwell_flags_a_long_stop():
    d = check_dwell(NOW - timedelta(hours=3), NOW, T)
    assert d is not None
    assert d.kind is DetectionKind.DWELL
    assert d.severity is Severity.MEDIUM


def test_dwell_escalates_when_very_long():
    d = check_dwell(NOW - timedelta(hours=10), NOW, T)
    assert d.severity in (Severity.HIGH, Severity.CRITICAL)


def test_moving_vehicle_has_no_dwell():
    assert check_dwell(None, NOW, T) is None


# ------------------------------------------------------------ temperature


def test_temperature_within_range_is_fine():
    assert check_temperature(4.0, 2.0, 8.0) is None


def test_temperature_above_range_is_critical():
    d = check_temperature(11.5, 2.0, 8.0)
    assert d.severity is Severity.CRITICAL
    assert d.detail["direction"] == "above"
    assert d.detail["breach_c"] == 3.5


def test_temperature_below_range_is_critical():
    d = check_temperature(-1.0, 2.0, 8.0)
    assert d.detail["direction"] == "below"


def test_temperature_ignored_for_non_reefer_cargo():
    assert check_temperature(40.0, None, None) is None


# ---------------------------------------------------------------- absence


def test_missed_checkpoint_respects_its_grace_period():
    expected = NOW - timedelta(minutes=30)
    assert check_missed_checkpoint(
        name="Ibadan tollgate", expected_at=expected, now=NOW, tolerance_minutes=60
    ) is None


def test_missed_checkpoint_fires_past_tolerance():
    d = check_missed_checkpoint(
        name="Ibadan tollgate",
        expected_at=NOW - timedelta(hours=3),
        now=NOW,
        tolerance_minutes=60,
    )
    assert d.kind is DetectionKind.MISSED_CHECKPOINT
    assert d.detail["late_minutes"] == 120.0


def test_signal_lost_after_the_threshold():
    d = check_signal_lost(last_seen=NOW - timedelta(hours=6), now=NOW, thresholds=T)
    assert d.kind is DetectionKind.SIGNAL_LOST
    assert d.detail["silent_hours"] == 6.0


def test_recent_signal_is_not_lost():
    assert check_signal_lost(
        last_seen=NOW - timedelta(minutes=20), now=NOW, thresholds=T
    ) is None


def test_absence_sweep_combines_both_rules():
    found = detect_stale(
        now=NOW,
        last_seen=NOW - timedelta(hours=20),
        checkpoints=[("Lokoja", NOW - timedelta(hours=5), 60.0)],
        thresholds=T,
    )
    kinds = {d.kind for d in found}
    assert kinds == {DetectionKind.SIGNAL_LOST, DetectionKind.MISSED_CHECKPOINT}


def test_silence_is_only_detectable_by_a_sweep():
    """No event arrives when a truck goes quiet, so the on-event path sees
    nothing. This is why the sweep exists."""
    assert detect_on_event(progress=_progress(IBADAN), now=NOW) == []
    assert detect_stale(now=NOW, last_seen=NOW - timedelta(hours=20)) != []


# ------------------------------------------------------------- escalation


def test_low_severity_does_not_wake_an_agent():
    """The economics rest on escalating ~370 times a day, not a million."""
    low = check_dwell(NOW - timedelta(minutes=95), NOW, T)
    assert low.severity is Severity.MEDIUM  # 95 min is already actionable

    quiet = check_signal_lost(
        last_seen=NOW - timedelta(hours=4.1), now=NOW, thresholds=T
    )
    assert quiet.severity is Severity.MEDIUM
    assert actionable([quiet]) == [quiet]


def test_worst_reports_the_top_severity():
    p = _progress(IBADAN, speeds=[30])
    found = detect_on_event(progress=p, now=NOW, deadline=p.eta - timedelta(hours=5))
    assert worst(found) is Severity.CRITICAL


def test_no_findings_means_no_severity():
    assert worst([]) is None
    assert actionable([]) == []


def test_clean_run_produces_nothing():
    """The overwhelmingly common case: a truck on route, on time, moving.
    It must cost nothing and produce no findings."""
    p = _progress(IBADAN, speeds=[60, 62, 58])
    found = detect_on_event(
        progress=p,
        now=NOW,
        planned_arrival=p.eta + timedelta(hours=1),
        deadline=p.eta + timedelta(days=1),
        stationary_since=None,
        temperature_c=None,
    )
    assert found == []
