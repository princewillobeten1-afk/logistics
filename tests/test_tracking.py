"""Tracking ingestion against a real database."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from logistics.domain.states import ShipmentState
from logistics.exceptions import ExceptionRepo
from logistics.tracking.events import TrackingEvent, TrackingEventType, TrackingSource
from logistics.tracking.ingest import TrackingIngestor

LAGOS = (6.5244, 3.3792)
IBADAN = (7.3775, 3.9470)
ABUJA = (9.0765, 7.3986)
KANO = (12.0022, 8.5920)

S = ShipmentState


async def _shipment(repo, reference, *, state=S.IN_TRANSIT, deadline_hours=48):
    return await repo.create(
        reference=reference,
        state=state,
        origin={"city": "Lagos", "warehouse": "Lagos",
                "latitude": LAGOS[0], "longitude": LAGOS[1]},
        destination={"city": "Abuja", "address": "12 Ahmadu Bello Way",
                     "latitude": ABUJA[0], "longitude": ABUJA[1]},
        cargo={"sku": "DEFAULT", "quantity": 100, "weight_kg": 1800},
        deadline=datetime.now(UTC) + timedelta(hours=deadline_hours),
    )


def _ping(shipment_id, position, *, speed=60.0, at=None, **kw):
    return TrackingEvent(
        shipment_id=shipment_id,
        occurred_at=at or datetime.now(UTC),
        source=TrackingSource.GPS,
        latitude=position[0],
        longitude=position[1],
        speed_kph=speed,
        **kw,
    )


# ---------------------------------------------------------------- ingestion


async def test_event_is_recorded(db, queue, repo, reference):
    shipment = await _shipment(repo, reference)
    result = await TrackingIngestor(db, queue).ingest(_ping(shipment.id, IBADAN))

    assert result.event_recorded is True
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM tracking_events WHERE shipment_id = %s",
            (shipment.id,),
        )
        assert (await cur.fetchone())["n"] == 1


async def test_progress_is_computed_from_position(db, queue, repo, reference):
    shipment = await _shipment(repo, reference)
    result = await TrackingIngestor(db, queue).ingest(_ping(shipment.id, IBADAN))

    assert result.progress is not None
    assert 0.1 < result.progress.fraction_complete < 0.35
    assert result.progress.distance_remaining_km > 300


async def test_healthy_journey_raises_nothing(db, queue, repo, reference):
    """The common case must be free: no exceptions, no escalation, no model."""
    shipment = await _shipment(repo, reference)
    result = await TrackingIngestor(db, queue).ingest(_ping(shipment.id, IBADAN))

    assert result.detections == []
    assert result.raised == []
    assert result.escalated is False


async def test_first_ping_uses_its_own_speed_not_the_fallback(db, queue, repo, reference):
    """Context is read before the event is stored, so without this the very
    first ping falls back to a table speed and under-reports the delay."""
    shipment = await _shipment(repo, reference)
    result = await TrackingIngestor(db, queue).ingest(
        _ping(shipment.id, IBADAN, speed=20)
    )
    assert result.progress is not None
    assert result.progress.effective_speed_kph == 20.0


async def test_a_doomed_shipment_is_caught_on_its_first_ping(db, queue, repo, reference):
    """Crawling out of the depot against a tight deadline should not need
    several pings before anyone notices."""
    shipment = await _shipment(repo, reference, deadline_hours=6)
    result = await TrackingIngestor(db, queue).ingest(
        _ping(shipment.id, LAGOS, speed=20, event_type=TrackingEventType.DEPARTED)
    )
    assert "SLA_BREACH_RISK" in result.raised
    breach = next(d for d in result.detections if str(d.kind) == "SLA_BREACH_RISK")
    assert breach.severity.value == "CRITICAL"


async def test_unknown_shipment_is_ignored_not_fatal(db, queue):
    from uuid import uuid4

    result = await TrackingIngestor(db, queue).ingest(_ping(uuid4(), IBADAN))
    assert result.event_recorded is False


async def test_position_free_event_still_records(db, queue, repo, reference):
    """A barcode scan has no coordinates but is still history."""
    shipment = await _shipment(repo, reference)
    event = TrackingEvent(
        shipment_id=shipment.id,
        occurred_at=datetime.now(UTC),
        source=TrackingSource.SCAN,
        event_type=TrackingEventType.CHECKPOINT,
    )
    result = await TrackingIngestor(db, queue).ingest(event)

    assert result.event_recorded is True
    assert result.progress is None
    assert result.detections == []


# ---------------------------------------------------------------- escalation


async def test_deadline_risk_raises_and_escalates(db, queue, repo, reference):
    """Barely moving, a long way out, with a deadline hours away."""
    shipment = await _shipment(repo, reference, deadline_hours=2)
    ingestor = TrackingIngestor(db, queue)
    result = await ingestor.ingest(_ping(shipment.id, IBADAN, speed=25))

    assert "SLA_BREACH_RISK" in result.raised
    assert result.escalated is True

    item = await queue.claim(worker_id="test")
    assert item is not None
    assert item.kind == "tracking.raise_exception"
    assert item.payload["severity"] == "CRITICAL"


async def test_exception_row_carries_the_detail(db, queue, repo, reference):
    shipment = await _shipment(repo, reference, deadline_hours=2)
    await TrackingIngestor(db, queue).ingest(_ping(shipment.id, IBADAN, speed=25))

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT kind, severity, detected_by, summary, detail FROM exceptions"
            " WHERE shipment_id = %s",
            (shipment.id,),
        )
        rows = await cur.fetchall()

    breach = next(r for r in rows if r["kind"] == "SLA_BREACH_RISK")
    assert breach["detected_by"] == "detector"
    assert breach["severity"] == "CRITICAL"
    assert "deadline" in breach["detail"]
    assert "miss the delivery deadline" in breach["summary"]


async def test_repeated_pings_do_not_duplicate_exceptions(db, queue, repo, reference):
    """At a 15-minute poll this would otherwise raise ~96 rows a day for one
    delayed truck, and later burn a model call on each."""
    shipment = await _shipment(repo, reference, deadline_hours=2)
    ingestor = TrackingIngestor(db, queue)

    for i in range(5):
        await ingestor.ingest(
            _ping(shipment.id, IBADAN, speed=25,
                  at=datetime.now(UTC) + timedelta(minutes=i))
        )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM exceptions"
            " WHERE shipment_id = %s AND kind = 'SLA_BREACH_RISK'",
            (shipment.id,),
        )
        assert (await cur.fetchone())["n"] == 1


async def test_repeated_pings_do_not_duplicate_work(db, queue, repo, reference):
    shipment = await _shipment(repo, reference, deadline_hours=2)
    ingestor = TrackingIngestor(db, queue)
    for i in range(4):
        await ingestor.ingest(
            _ping(shipment.id, IBADAN, speed=25,
                  at=datetime.now(UTC) + timedelta(minutes=i))
        )

    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM work_items WHERE kind = 'tracking.raise_exception'"
        )
        assert (await cur.fetchone())["n"] == 1


async def test_off_route_is_detected(db, queue, repo, reference):
    shipment = await _shipment(repo, reference)
    result = await TrackingIngestor(db, queue).ingest(_ping(shipment.id, KANO))
    assert "ROUTE_DEVIATION" in result.raised


async def test_rejoining_the_route_clears_the_finding(db, queue, repo, reference):
    """A truck that comes back on course must not stay flagged forever."""
    shipment = await _shipment(repo, reference)
    ingestor = TrackingIngestor(db, queue)

    await ingestor.ingest(_ping(shipment.id, KANO))
    assert "ROUTE_DEVIATION" in await ExceptionRepo(db).open_kinds(shipment.id)

    result = await ingestor.ingest(_ping(shipment.id, IBADAN))
    assert "ROUTE_DEVIATION" in result.cleared
    assert "ROUTE_DEVIATION" not in await ExceptionRepo(db).open_kinds(shipment.id)


async def test_sla_breach_does_not_self_clear(db, queue, repo, reference):
    """A missed deadline does not un-happen because the next ping looks fine."""
    shipment = await _shipment(repo, reference, deadline_hours=2)
    ingestor = TrackingIngestor(db, queue)

    await ingestor.ingest(_ping(shipment.id, IBADAN, speed=25))
    result = await ingestor.ingest(_ping(shipment.id, ABUJA, speed=80))

    assert "SLA_BREACH_RISK" not in result.cleared
    assert "SLA_BREACH_RISK" in await ExceptionRepo(db).open_kinds(shipment.id)


# ----------------------------------------------------------------- lifecycle


async def test_departure_enqueues_a_transition(db, queue, repo, reference):
    shipment = await _shipment(repo, reference, state=S.BOOKED)
    await TrackingIngestor(db, queue).ingest(
        _ping(shipment.id, LAGOS, event_type=TrackingEventType.DEPARTED)
    )

    kinds = set()
    while item := await queue.claim(worker_id="test"):
        kinds.add(item.kind)
    assert "tracking.mark_in_transit" in kinds


async def test_delivery_enqueues_a_transition(db, queue, repo, reference):
    shipment = await _shipment(repo, reference)
    await TrackingIngestor(db, queue).ingest(
        _ping(shipment.id, ABUJA, speed=0, event_type=TrackingEventType.DELIVERED)
    )

    kinds = set()
    while item := await queue.claim(worker_id="test"):
        kinds.add(item.kind)
    assert "tracking.mark_delivered" in kinds


async def test_closed_shipment_is_not_escalated(db, queue, repo, reference):
    """Detection still records, but a finished shipment is not re-opened."""
    shipment = await _shipment(repo, reference, state=S.DELIVERED, deadline_hours=1)
    result = await TrackingIngestor(db, queue).ingest(
        _ping(shipment.id, IBADAN, speed=20)
    )
    assert result.escalated is False


# -------------------------------------------------------------- no LLM here


def test_tracking_package_never_imports_the_model_layer():
    """The cost thesis, enforced as a test rather than a comment."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1] / "src" / "logistics" / "tracking"
    for path in root.rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        assert "logistics.llm" not in source, f"{path.name} imports the model layer"
        assert "openai" not in source.lower(), f"{path.name} references a model client"
