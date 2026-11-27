"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PlusCircle } from "lucide-react";
import { submitOrderIntakeAction } from "@/app/orders/actions";

export function OrderIntakeForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [customerName, setCustomerName] = useState("");
  const [originCity, setOriginCity] = useState("");
  const [destinationCity, setDestinationCity] = useState("");
  const [cargoDescription, setCargoDescription] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [quantity, setQuantity] = useState("");
  const [deadlineIso, setDeadlineIso] = useState("");
  const [preferredMode, setPreferredMode] = useState("ROAD");
  const [reefer, setReefer] = useState(false);
  const [hazmat, setHazmat] = useState(false);
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
      const res = await submitOrderIntakeAction({
        customerName,
        originCity,
        destinationCity,
        cargoDescription,
        weightKg: Number(weightKg) || 100,
        quantity: Number(quantity) || 1,
        deadlineIso: deadlineIso || undefined,
        preferredMode,
        reefer,
        hazmat,
        notes,
      });
      setFeedback(res);
      if (res.ok) {
        setCustomerName("");
        setOriginCity("");
        setDestinationCity("");
        setCargoDescription("");
        setNotes("");
        router.refresh();
      }
    });
  }

  return (
    <form className="intake-form" onSubmit={onSubmit}>
      <div className="intake-grid">
        <label htmlFor="order-customer">
          <span>Customer / consignee</span>
          <input
            id="order-customer"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="Customer or consignee name"
          />
        </label>

        <label htmlFor="order-origin">
          <span>Origin city *</span>
          <input
            id="order-origin"
            required
            value={originCity}
            onChange={(e) => setOriginCity(e.target.value)}
            placeholder="Origin city"
          />
        </label>

        <label htmlFor="order-destination">
          <span>Destination city *</span>
          <input
            id="order-destination"
            required
            value={destinationCity}
            onChange={(e) => setDestinationCity(e.target.value)}
            placeholder="Destination city"
          />
        </label>

        <label htmlFor="order-cargo">
          <span>Cargo description *</span>
          <input
            id="order-cargo"
            required
            value={cargoDescription}
            onChange={(e) => setCargoDescription(e.target.value)}
            placeholder="Cargo description"
          />
        </label>

        <label htmlFor="order-qty">
          <span>Units / cartons</span>
          <input
            id="order-qty"
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>

        <label htmlFor="order-weight">
          <span>Total weight (kg)</span>
          <input
            id="order-weight"
            type="number"
            min={1}
            step="0.5"
            value={weightKg}
            onChange={(e) => setWeightKg(e.target.value)}
          />
        </label>

        <label htmlFor="order-mode">
          <span>Transport mode</span>
          <select
            id="order-mode"
            value={preferredMode}
            onChange={(e) => setPreferredMode(e.target.value)}
          >
            <option value="ROAD">Road freight</option>
            <option value="AIR">Air cargo</option>
            <option value="SEA">Sea freight</option>
            <option value="RAIL">Rail freight</option>
          </select>
        </label>

        <label htmlFor="order-deadline">
          <span>Required delivery date</span>
          <input
            id="order-deadline"
            type="date"
            value={deadlineIso}
            onChange={(e) => setDeadlineIso(e.target.value)}
          />
        </label>
      </div>

      <div className="intake-options">
        <label className="intake-check" htmlFor="order-reefer">
          <input
            id="order-reefer"
            type="checkbox"
            checked={reefer}
            onChange={(e) => setReefer(e.target.checked)}
          />
          <span>Temperature controlled (reefer)</span>
        </label>
        <label className="intake-check" htmlFor="order-hazmat">
          <input
            id="order-hazmat"
            type="checkbox"
            checked={hazmat}
            onChange={(e) => setHazmat(e.target.checked)}
          />
          <span>Hazardous cargo</span>
        </label>
      </div>

      <div className="intake-footer">
        <label htmlFor="order-notes" className="intake-notes-wrap">
          <span className="visually-hidden">Delivery instructions</span>
          <input
            id="order-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional delivery window or special handling instructions…"
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          <PlusCircle size={15} strokeWidth={2} aria-hidden="true" />
          <span>{pending ? "Submitting order…" : "Submit order"}</span>
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
