"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, PlusCircle, X } from "lucide-react";
import { submitOrderIntakeAction } from "@/app/orders/actions";

export function QuickOrderDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [customerName, setCustomerName] = useState("");
  const [originCity, setOriginCity] = useState("");
  const [destinationCity, setDestinationCity] = useState("");
  const [cargoDescription, setCargoDescription] = useState("");
  const [weightKg, setWeightKg] = useState("250");
  const [quantity, setQuantity] = useState("10");
  const [preferredMode, setPreferredMode] = useState("ROAD");
  const [deadlineIso, setDeadlineIso] = useState("");
  const [notes, setNotes] = useState("");
  const [feedback, setFeedback] = useState<{
    ok: boolean;
    message: string;
    shipmentReference?: string | null;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
        preferredMode,
        deadlineIso: deadlineIso || undefined,
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
    <AnimatePresence>
      {open ? (
        <motion.div
          className="ct-drawer-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={onClose}
        >
          <motion.aside
            className="ct-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="New shipment order"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="ct-drawer-head">
              <div>
                <strong>New Order &amp; Dispatch</strong>
                <span>Autonomous intake validates, allocates &amp; routes automatically</span>
              </div>
              <button
                type="button"
                className="ct-drawer-close"
                onClick={onClose}
                aria-label="Close new order drawer"
              >
                <X size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            </header>

            <form className="ct-drawer-form" onSubmit={onSubmit}>
              <label htmlFor="quick-customer">
                <span>Customer / Consignee</span>
                <input
                  id="quick-customer"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="e.g. Zenith Pharma Group"
                />
              </label>

              <div className="ct-drawer-row-2">
                <label htmlFor="quick-origin">
                  <span>Origin City *</span>
                  <input
                    id="quick-origin"
                    required
                    value={originCity}
                    onChange={(e) => setOriginCity(e.target.value)}
                    placeholder="e.g. Lagos"
                  />
                </label>

                <label htmlFor="quick-destination">
                  <span>Destination City *</span>
                  <input
                    id="quick-destination"
                    required
                    value={destinationCity}
                    onChange={(e) => setDestinationCity(e.target.value)}
                    placeholder="e.g. Kano"
                  />
                </label>
              </div>

              <label htmlFor="quick-cargo">
                <span>Cargo Description *</span>
                <input
                  id="quick-cargo"
                  required
                  value={cargoDescription}
                  onChange={(e) => setCargoDescription(e.target.value)}
                  placeholder="e.g. 40 cartons medical supplies"
                />
              </label>

              <div className="ct-drawer-row-3">
                <label htmlFor="quick-qty">
                  <span>Units</span>
                  <input
                    id="quick-qty"
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                </label>

                <label htmlFor="quick-weight">
                  <span>Weight (kg)</span>
                  <input
                    id="quick-weight"
                    type="number"
                    min={1}
                    step="0.5"
                    value={weightKg}
                    onChange={(e) => setWeightKg(e.target.value)}
                  />
                </label>

                <label htmlFor="quick-mode">
                  <span>Mode</span>
                  <select
                    id="quick-mode"
                    value={preferredMode}
                    onChange={(e) => setPreferredMode(e.target.value)}
                  >
                    <option value="ROAD">Road</option>
                    <option value="AIR">Air</option>
                    <option value="SEA">Sea</option>
                    <option value="RAIL">Rail</option>
                  </select>
                </label>
              </div>

              <label htmlFor="quick-deadline">
                <span>Required Delivery Date</span>
                <input
                  id="quick-deadline"
                  type="date"
                  value={deadlineIso}
                  onChange={(e) => setDeadlineIso(e.target.value)}
                />
              </label>

              <label htmlFor="quick-notes">
                <span>Instructions</span>
                <input
                  id="quick-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional handling or delivery window notes"
                />
              </label>

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
                      onClick={onClose}
                    >
                      Open {feedback.shipmentReference}
                    </Link>
                  ) : null}
                </div>
              ) : null}

              <div className="ct-drawer-actions">
                <Link href="/orders" className="ct-btn-outline" onClick={onClose}>
                  <span>Full intake page</span>
                  <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                </Link>
                <button type="submit" className="ct-btn-dark" disabled={pending}>
                  <PlusCircle size={15} strokeWidth={2} aria-hidden="true" />
                  <span>{pending ? "Submitting…" : "Create Order"}</span>
                </button>
              </div>
            </form>
          </motion.aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
