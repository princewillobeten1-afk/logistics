"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, PhoneCall, Send } from "lucide-react";
import type {
  CommunicationCadence,
  TacticsWorkspaceSnapshot,
} from "@/lib/tactics/types";

interface SupplierPanelsProps {
  snapshot: TacticsWorkspaceSnapshot;
  busy: boolean;
  readOnly: boolean;
  onAction: (payload: Record<string, unknown>) => Promise<boolean>;
}

export function SupplierCommunicationsPanel({
  snapshot,
  busy,
  readOnly,
  onAction,
}: SupplierPanelsProps) {
  const defaultSupplier = snapshot.availableSuppliers[0]?.name ?? "";
  const [supplierName, setSupplierName] = useState(defaultSupplier);
  const [contactName, setContactName] = useState("");
  const [cadence, setCadence] = useState<CommunicationCadence>("WEEKLY");
  const [channel, setChannel] = useState<"VIDEO_CALL" | "EMAIL" | "EDI_PORTAL" | "PHONE">(
    "VIDEO_CALL",
  );
  const [topic, setTopic] = useState("");
  const [demandPlanSummary, setDemandPlanSummary] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!supplierName.trim() || !topic.trim()) {
      setFormError("Enter both a supplier name and the planning discussion topic.");
      return;
    }
    const ok = await onAction({
      action: "log_supplier_sync",
      supplierName: supplierName.trim(),
      contactName: contactName.trim() || "Supplier Ops Desk",
      cadence,
      channel,
      topic: topic.trim(),
      demandPlanSummary: demandPlanSummary.trim(),
    });
    if (ok) {
      setTopic("");
      setDemandPlanSummary("");
      setContactName("");
    }
  };

  return (
    <div className="tac-split">
      <div className="tac-panel">
        <div className="tac-panel-head">
          <div>
            <h2>01. Supplier Communications &amp; Rolling Plan Cadence</h2>
            <p className="tac-sub">
              Maintain regular planning discussions with carriers and suppliers so capacity,
              lead times, and rolling demand schedules stay aligned before bottlenecks emerge.
            </p>
          </div>
          <span className="tac-meta-line">
            {snapshot.supplierSyncs.length} tracked supplier
            {snapshot.supplierSyncs.length === 1 ? "" : "s"} ·{" "}
            {snapshot.supplierSyncs.filter((s) => s.status === "OVERDUE").length} overdue
          </span>
        </div>

        {snapshot.supplierSyncs.length === 0 ? (
          <div className="tac-empty">
            <strong>No supplier planning syncs recorded yet.</strong>
            <p>
              Use the form on the right to log your first weekly, bi-weekly, or monthly supplier
              alignment call and start tracking cadence health.
            </p>
          </div>
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Supplier planning cadence">
            <table className="bi-table">
              <thead>
                <tr>
                  <th scope="col">Supplier</th>
                  <th scope="col">Cadence</th>
                  <th scope="col">Latest Plan Discussion</th>
                  <th scope="col">Next Sync Due</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.supplierSyncs.map((sync) => (
                  <tr key={sync.id}>
                    <td>
                      <div className="bi-entity-cell">
                        <strong>{sync.supplierName}</strong>
                        <span>
                          {sync.contactName} · {sync.channel.replace(/_/g, " ")}
                        </span>
                      </div>
                    </td>
                    <td className="num">{sync.cadence}</td>
                    <td>
                      <div className="bi-entity-cell">
                        <strong>{sync.topic}</strong>
                        <span>{sync.demandPlanSummary}</span>
                      </div>
                    </td>
                    <td className="num">
                      {new Date(sync.nextSyncDueAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      })}
                    </td>
                    <td>
                      <span className={`tac-state tac-state-${sync.status.toLowerCase()}`}>
                        {sync.status.replace(/_/g, " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <form className="tac-panel tac-form" onSubmit={handleSubmit}>
        <div className="tac-panel-head">
          <div>
            <h3>Log Supplier Planning Sync</h3>
            <p className="tac-sub">
              Record a supplier call or shared capacity plan to reset their cadence clock.
            </p>
          </div>
        </div>

        <label className="tac-field">
          <span>Supplier / Partner</span>
          <input
            type="text"
            list="tac-supplier-options"
            value={supplierName}
            onChange={(e) => setSupplierName(e.target.value)}
            placeholder="e.g. Maersk Line or regional vendor"
            disabled={readOnly || busy}
            required
          />
          <datalist id="tac-supplier-options">
            {snapshot.availableSuppliers.map((s) => (
              <option key={s.code} value={s.name} />
            ))}
          </datalist>
        </label>

        <div className="tac-form-row">
          <label className="tac-field">
            <span>Cadence</span>
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value as CommunicationCadence)}
              disabled={readOnly || busy}
            >
              <option value="WEEKLY">Weekly (7d)</option>
              <option value="BIWEEKLY">Bi-weekly (14d)</option>
              <option value="MONTHLY">Monthly (30d)</option>
            </select>
          </label>

          <label className="tac-field">
            <span>Channel</span>
            <select
              value={channel}
              onChange={(e) =>
                setChannel(
                  e.target.value as "VIDEO_CALL" | "EMAIL" | "EDI_PORTAL" | "PHONE",
                )
              }
              disabled={readOnly || busy}
            >
              <option value="VIDEO_CALL">Video Call</option>
              <option value="PHONE">Phone Call</option>
              <option value="EMAIL">Email Brief</option>
              <option value="EDI_PORTAL">EDI / Portal</option>
            </select>
          </label>
        </div>

        <label className="tac-field">
          <span>Supplier Contact</span>
          <input
            type="text"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            placeholder="Contact name or planning desk"
            disabled={readOnly || busy}
          />
        </label>

        <label className="tac-field">
          <span>Planning Topic</span>
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. Q4 peak capacity & lead-time alignment"
            disabled={readOnly || busy}
            required
          />
        </label>

        <label className="tac-field">
          <span>Shared Demand Plan Summary</span>
          <textarea
            rows={3}
            value={demandPlanSummary}
            onChange={(e) => setDemandPlanSummary(e.target.value)}
            placeholder="Summarize agreed shipment volumes, dock slots, or buffer commitments."
            disabled={readOnly || busy}
          />
        </label>

        {formError ? <p className="tac-error">{formError}</p> : null}

        <button
          type="submit"
          className="tac-btn-primary"
          disabled={readOnly || busy}
        >
          <PhoneCall size={14} aria-hidden="true" />
          <span>{busy ? "Saving…" : "Record Supplier Sync"}</span>
        </button>
      </form>
    </div>
  );
}

export function SupplierCollaborationPanel({
  snapshot,
  busy,
  readOnly,
  onAction,
}: SupplierPanelsProps) {
  const defaultSupplier = snapshot.availableSuppliers[0]?.name ?? "";
  const [supplierName, setSupplierName] = useState(defaultSupplier);
  const [metricTracked, setMetricTracked] = useState("On-Time Delivery %");
  const [baselineValue, setBaselineValue] = useState("91.5%");
  const [targetValue, setTargetValue] = useState("97.0%");
  const [trendObservation, setTrendObservation] = useState("");
  const [sharedWithSupplier, setSharedWithSupplier] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!supplierName.trim() || !trendObservation.trim()) {
      setFormError("Provide a supplier and the observed operational trend.");
      return;
    }
    const ok = await onAction({
      action: "create_initiative",
      supplierName: supplierName.trim(),
      metricTracked: metricTracked.trim(),
      baselineValue: baselineValue.trim(),
      targetValue: targetValue.trim(),
      trendObservation: trendObservation.trim(),
      sharedWithSupplier,
    });
    if (ok) {
      setTrendObservation("");
    }
  };

  return (
    <div className="tac-split">
      <div className="tac-panel">
        <div className="tac-panel-head">
          <div>
            <h2>02. Supplier Collaboration &amp; Continuous Improvement (PDCA)</h2>
            <p className="tac-sub">
              Turn live operational trends into shared Plan-Do-Check-Act improvement loops
              with suppliers to systematically eliminate delays, damage, and cost drift.
            </p>
          </div>
          <span className="tac-meta-line">
            {snapshot.initiatives.length} active loop
            {snapshot.initiatives.length === 1 ? "" : "s"} ·{" "}
            {snapshot.initiatives.filter((i) => i.sharedWithSupplier).length} shared with partners
          </span>
        </div>

        {snapshot.initiatives.length === 0 ? (
          <div className="tac-empty">
            <strong>No PDCA continuous improvement loops active yet.</strong>
            <p>
              Launch your first Plan-Do-Check-Act initiative on the right to share operational
              trend observations with a supplier and track target gains.
            </p>
          </div>
        ) : (
          <div className="tac-list">
            {snapshot.initiatives.map((item) => (
              <article key={item.id} className="tac-row-card">
                <div className="tac-row-main">
                  <div className="tac-row-title-line">
                    <strong>{item.supplierName}</strong>
                    <span className="tac-sep" aria-hidden="true">·</span>
                    <span className="tac-muted">{item.metricTracked}</span>
                    <span className="tac-sep" aria-hidden="true">·</span>
                    <span className="tac-mono">
                      {item.baselineValue} → {item.targetValue}
                    </span>
                  </div>
                  <p className="tac-row-desc">{item.trendObservation}</p>
                  <div className="tac-meta-line">
                    <span>PDCA Stage: {item.stage}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {item.sharedWithSupplier
                        ? "Shared with supplier"
                        : "Internal draft"}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>Owner: {item.owner}</span>
                  </div>
                </div>

                <div className="tac-row-actions">
                  {!item.sharedWithSupplier ? (
                    <button
                      type="button"
                      className="bi-btn-outline"
                      disabled={readOnly || busy}
                      onClick={() =>
                        void onAction({
                          action: "share_initiative",
                          initiativeId: item.id,
                        })
                      }
                    >
                      <Send size={13} aria-hidden="true" />
                      <span>Share Trend</span>
                    </button>
                  ) : null}

                  {item.stage !== "ACT" ? (
                    <button
                      type="button"
                      className="tac-btn-primary"
                      disabled={readOnly || busy}
                      onClick={() =>
                        void onAction({
                          action: "advance_initiative",
                          initiativeId: item.id,
                        })
                      }
                    >
                      <span>Advance to {item.stage === "PLAN" ? "DO" : item.stage === "DO" ? "CHECK" : "ACT"}</span>
                      <ArrowRight size={13} aria-hidden="true" />
                    </button>
                  ) : (
                    <span className="tac-state tac-state-on_track">
                      <CheckCircle2 size={13} aria-hidden="true" />
                      Standardized (ACT)
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <form className="tac-panel tac-form" onSubmit={handleCreate}>
        <div className="tac-panel-head">
          <div>
            <h3>Launch PDCA Trend Initiative</h3>
            <p className="tac-sub">
              Share a trend observation with a supplier and track measurable improvement.
            </p>
          </div>
        </div>

        <label className="tac-field">
          <span>Supplier / Carrier</span>
          <input
            type="text"
            list="tac-supplier-pdca-list"
            value={supplierName}
            onChange={(e) => setSupplierName(e.target.value)}
            placeholder="Select or type supplier"
            disabled={readOnly || busy}
            required
          />
          <datalist id="tac-supplier-pdca-list">
            {snapshot.availableSuppliers.map((s) => (
              <option key={s.code} value={s.name} />
            ))}
          </datalist>
        </label>

        <label className="tac-field">
          <span>Metric Tracked</span>
          <select
            value={metricTracked}
            onChange={(e) => setMetricTracked(e.target.value)}
            disabled={readOnly || busy}
          >
            <option value="On-Time Delivery %">On-Time Delivery %</option>
            <option value="Damage / Defect Rate %">Damage / Defect Rate %</option>
            <option value="Lead-Time Variance (hrs)">Lead-Time Variance (hrs)</option>
            <option value="Order Fill Rate %">Order Fill Rate %</option>
            <option value="Dock Dwell Time (hrs)">Dock Dwell Time (hrs)</option>
          </select>
        </label>

        <div className="tac-form-row">
          <label className="tac-field">
            <span>Baseline</span>
            <input
              type="text"
              value={baselineValue}
              onChange={(e) => setBaselineValue(e.target.value)}
              disabled={readOnly || busy}
            />
          </label>
          <label className="tac-field">
            <span>Target</span>
            <input
              type="text"
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
              disabled={readOnly || busy}
            />
          </label>
        </div>

        <label className="tac-field">
          <span>Trend Observation &amp; Proposed Root-Cause Fix</span>
          <textarea
            rows={3}
            value={trendObservation}
            onChange={(e) => setTrendObservation(e.target.value)}
            placeholder="e.g. Friday afternoon dispatch cutoffs slipped 14% over 3 weeks; pre-staging pallets by 11:00 fixes turnaround."
            disabled={readOnly || busy}
            required
          />
        </label>

        <label className="tac-checkbox">
          <input
            type="checkbox"
            checked={sharedWithSupplier}
            onChange={(e) => setSharedWithSupplier(e.target.checked)}
            disabled={readOnly || busy}
          />
          <span>Share trend observation brief directly with supplier</span>
        </label>

        {formError ? <p className="tac-error">{formError}</p> : null}

        <button
          type="submit"
          className="tac-btn-primary"
          disabled={readOnly || busy}
        >
          <span>{busy ? "Creating…" : "Create PDCA Initiative"}</span>
        </button>
      </form>
    </div>
  );
}
