"""pod.verify — Proof of Delivery verification.

Runs automatically when a shipment enters `DELIVERED` (via `STATE_ROUTES`).
Checks any uploaded POD document for damage, short-delivery, or low extraction
confidence, and ensures no open unresolved exceptions remain before advancing
the shipment to `POD_VERIFIED` (which triggers `shipment.close` and consumes
reserved warehouse inventory).

Discrepancies reopen the shipment as `EXCEPTION` so the Exception Agent can
investigate and escalate claims instead of silently closing a damaged delivery.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from logistics.domain.events import EventDraft
from logistics.domain.models import StepResult
from logistics.domain.states import ShipmentState
from logistics.handlers.base import StepContext, handler

# Below this extraction confidence on an unverified POD scan, hand off as an
# exception rather than auto-closing the shipment on an unreadable document.
MIN_POD_CONFIDENCE = 0.5


@dataclass(frozen=True, slots=True)
class PodAssessment:
    verified: bool
    source: str
    discrepancy: str | None = None
    document_id: str | None = None


def assess_pod(
    document: dict[str, Any] | None,
    *,
    expected_quantity: int | None = None,
    open_exceptions: list[dict[str, Any]] | None = None,
) -> PodAssessment:
    """Pure POD verification rules. Testable without a database."""
    if document is not None:
        doc_id = str(document["id"]) if document.get("id") is not None else None
        extracted = document.get("extracted") or {}

        if extracted.get("damaged") is True:
            return PodAssessment(
                verified=False,
                source="pod_document",
                discrepancy=str(extracted.get("damage_notes") or "POD reports damaged cargo"),
                document_id=doc_id,
            )

        if extracted.get("short_delivery") is True:
            return PodAssessment(
                verified=False,
                source="pod_document",
                discrepancy=str(extracted.get("discrepancy") or "POD reports short delivery"),
                document_id=doc_id,
            )

        if extracted.get("discrepancy"):
            return PodAssessment(
                verified=False,
                source="pod_document",
                discrepancy=str(extracted["discrepancy"]),
                document_id=doc_id,
            )

        received_qty = extracted.get("received_quantity")
        parsed_received: float | None = None
        if isinstance(received_qty, int | float) and not isinstance(received_qty, bool):
            parsed_received = float(received_qty)
        elif isinstance(received_qty, str):
            try:
                parsed_received = float(received_qty.strip())
            except ValueError:
                parsed_received = None

        if (
            expected_quantity is not None
            and parsed_received is not None
            and parsed_received < expected_quantity
        ):
            return PodAssessment(
                verified=False,
                source="pod_document",
                discrepancy=(
                    f"short delivery: received {int(parsed_received)} of "
                    f"{expected_quantity} expected units"
                ),
                document_id=doc_id,
            )

        confidence = document.get("extraction_confidence")
        if (
            document.get("verified_at") is None
            and confidence is not None
            and float(confidence) < MIN_POD_CONFIDENCE
        ):
            return PodAssessment(
                verified=False,
                source="pod_document",
                discrepancy=(
                    f"POD extraction confidence {float(confidence):.2f} is below "
                    f"{MIN_POD_CONFIDENCE:.2f}; manual review required"
                ),
                document_id=doc_id,
            )

        # Even if the POD scan itself looks clean, an unverified scan must not
        # auto-close a shipment that still has open damage/shortage findings.
        if document.get("verified_at") is None:
            critical = _critical_open_exceptions(open_exceptions)
            if critical:
                return PodAssessment(
                    verified=False,
                    source="open_exception",
                    discrepancy=str(
                        critical[0].get("summary")
                        or f"open {critical[0].get('kind')} exception"
                    ),
                    document_id=doc_id,
                )

        return PodAssessment(
            verified=True,
            source="pod_document",
            document_id=doc_id,
        )

    critical = _critical_open_exceptions(open_exceptions)
    if critical:
        return PodAssessment(
            verified=False,
            source="open_exception",
            discrepancy=str(critical[0].get("summary") or f"open {critical[0].get('kind')} exception"),
        )

    return PodAssessment(verified=True, source="tracking_confirmation")


def _critical_open_exceptions(
    open_exceptions: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    return [
        e
        for e in (open_exceptions or [])
        if str(e.get("kind") or "") in ("DAMAGE", "SHORTAGE", "POD_DISCREPANCY")
    ]


@handler("pod.verify")
async def verify_pod(ctx: StepContext) -> StepResult:
    """Verify Proof of Delivery and advance DELIVERED -> POD_VERIFIED (or EXCEPTION)."""
    shipment = ctx.require_shipment()
    if shipment.state is not ShipmentState.DELIVERED:
        ctx.log.info("pod.verify_ignored", state=str(shipment.state))
        return StepResult()

    async with ctx.db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT id, filename, extracted, extraction_confidence, verified_at
              FROM documents
             WHERE shipment_id = %s AND kind = 'POD'
             ORDER BY created_at DESC
             LIMIT 1
            """,
            (shipment.id,),
        )
        doc = await cur.fetchone()

        cur = await conn.execute(
            """
            SELECT id, kind, severity, COALESCE(summary, detail->>'summary') AS summary
              FROM exceptions
             WHERE shipment_id = %s AND state NOT IN ('RESOLVED', 'ABANDONED')
            """,
            (shipment.id,),
        )
        open_exc = await cur.fetchall()

    cargo = shipment.cargo or {}
    expected_qty = cargo.get("quantity")
    parsed_expected = (
        int(expected_qty)
        if isinstance(expected_qty, int | float) and not isinstance(expected_qty, bool)
        else None
    )
    assessment = assess_pod(
        dict(doc) if doc else None,
        expected_quantity=parsed_expected,
        open_exceptions=[dict(r) for r in open_exc],
    )

    if not assessment.verified:
        from logistics.exceptions import ExceptionRepo
        from logistics.tracking.detection import Detection, DetectionKind, Severity

        await ExceptionRepo(ctx.db).raise_detection(
            shipment_id=shipment.id,
            detection=Detection(
                kind=DetectionKind.POD_DISCREPANCY,
                severity=Severity.HIGH,
                summary=assessment.discrepancy or "POD verification discrepancy",
                detail={
                    "source": assessment.source,
                    "document_id": assessment.document_id,
                    "discrepancy": assessment.discrepancy,
                },
            ),
            detected_by="pod.verify",
        )
        ctx.log.warning(
            "pod.discrepancy",
            reference=shipment.reference,
            discrepancy=assessment.discrepancy,
        )
        return StepResult(
            transition=ShipmentState.EXCEPTION,
            events=(
                EventDraft(
                    type="pod.discrepancy_detected",
                    actor="agent:pod",
                    payload={
                        "source": assessment.source,
                        "document_id": assessment.document_id,
                        "discrepancy": assessment.discrepancy,
                    },
                ),
            ),
        )

    if doc is not None and doc["verified_at"] is None:
        async with ctx.db.connection() as conn:
            await conn.execute(
                """
                UPDATE documents
                   SET verified_at = now(), verified_by = 'agent:pod'
                 WHERE id = %s AND verified_at IS NULL
                """,
                (doc["id"],),
            )

    ctx.log.info(
        "pod.verified",
        reference=shipment.reference,
        source=assessment.source,
        document_id=assessment.document_id,
    )
    return StepResult(
        transition=ShipmentState.POD_VERIFIED,
        events=(
            EventDraft(
                type="pod.verified",
                actor="agent:pod",
                payload={
                    "source": assessment.source,
                    "document_id": assessment.document_id,
                },
            ),
        ),
    )
