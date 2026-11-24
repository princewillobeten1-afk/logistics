"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Navigation } from "lucide-react";
import { submitPlanningIntakeAction } from "@/app/planning/actions";

export function RoutingRequestForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reference, setReference] = useState("");
  const [originCity, setOriginCity] = useState("");
  const [destinationCity, setDestinationCity] = useState("");
  const [preferredMode, setPreferredMode] = useState("ROAD");
  const [deadlineIso, setDeadlineIso] = useState("");
  const [notes, setNotes] = useState("");
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    message: string;
    shipmentReference?: string | null;
    aiWarning?: string | null;
  } | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    startTransition(async () => {
      const res = await submitPlanningIntakeAction({
        reference,
        originCity,
        destinationCity,
        preferredMode,
        deadlineIso,
        notes,
      });
      setFeedback(res);
      if (res.ok) {
        setReference("");
        setOriginCity("");
        setDestinationCity("");
        setNotes("");
        router.refresh();
      }
    });
  }

  return (
    <form className="intake-form" onSubmit={onSubmit}>
      <div className="intake-grid">
        <label htmlFor="plan-ref">
          <span>Existing shipment ref (optional)</span>
          <input
            id="plan-ref"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="e.g. LG-00001"
          />
        </label>

        <label htmlFor="plan-origin">
          <span>Origin city</span>
          <input
            id="plan-origin"
            value={originCity}
            onChange={(e) => setOriginCity(e.target.value)}
            placeholder="e.g. Lagos"
          />
        </label>

        <label htmlFor="plan-destination">
          <span>Destination city</span>
          <input
            id="plan-destination"
            value={destinationCity}
            onChange={(e) => setDestinationCity(e.target.value)}
            placeholder="e.g. Kano"
          />
        </label>

        <label htmlFor="plan-mode">
          <span>Preferred mode</span>
          <select
            id="plan-mode"
            value={preferredMode}
            onChange={(e) => setPreferredMode(e.target.value)}
          >
            <option value="ROAD">Road freight</option>
            <option value="AIR">Air cargo</option>
            <option value="SEA">Sea freight</option>
            <option value="RAIL">Rail freight</option>
          </select>
        </label>

        <label htmlFor="plan-deadline">
          <span>Target arrival date</span>
          <input
            id="plan-deadline"
            type="date"
            value={deadlineIso}
            onChange={(e) => setDeadlineIso(e.target.value)}
          />
        </label>
      </div>

      <div className="intake-footer">
        <label htmlFor="plan-notes" className="intake-notes-wrap">
          <span className="visually-hidden">Routing instructions</span>
          <input
            id="plan-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Corridor constraints, reroute reason, or customs/border timing notes…"
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          <Navigation size={15} strokeWidth={2} aria-hidden="true" />
          <span>{pending ? "Submitting route request…" : "Plan & route"}</span>
        </button>
      </div>

      {feedback ? (
        <div
          className="intake-status"
          data-tone={feedback.ok ? "ok" : "error"}
          role="status"
        >
          <span>{feedback.message}</span>
          {feedback.shipmentReference ? (
            <Link
              href={`/shipments/${encodeURIComponent(feedback.shipmentReference)}`}
              className="auth-link"
            >
              View {feedback.shipmentReference}
            </Link>
          ) : null}
          {feedback.aiWarning ? (
            <span className="text-muted text-xs">({feedback.aiWarning})</span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
