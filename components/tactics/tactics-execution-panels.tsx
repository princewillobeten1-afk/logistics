"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Plane,
  Plus,
  ShieldCheck,
  Ship,
  Trash2,
} from "lucide-react";
import { formatMoneyMajor } from "@/lib/intelligence/engine";
import { EQUIPMENT_LIMITS, evaluateMixedShipmentLoad } from "@/lib/tactics/engine";
import type {
  MixedLoadSkuLine,
  MixedShipmentPlan,
  TacticsWorkspaceSnapshot,
} from "@/lib/tactics/types";

interface ExecutionPanelsProps {
  snapshot: TacticsWorkspaceSnapshot;
  busy: boolean;
  readOnly: boolean;
  onAction: (payload: Record<string, unknown>) => Promise<boolean>;
}

export function MixedShipmentsPanel({
  snapshot,
  busy,
  readOnly,
  onAction,
}: ExecutionPanelsProps) {
  const [customerName, setCustomerName] = useState(
    snapshot.availableCustomers[0] ?? "Acme Distribution",
  );
  const [destinationCity, setDestinationCity] = useState(
    snapshot.postponementCenters[0]?.city ?? "Lagos",
  );
  const [equipmentType, setEquipmentType] =
    useState<MixedShipmentPlan["equipmentType"]>("DRY_VAN_53");

  const initialLines: MixedLoadSkuLine[] = useMemo(() => {
    if (snapshot.availableInventory.length >= 2) {
      return [
        {
          sku: snapshot.availableInventory[0].sku,
          warehouseCode: snapshot.availableInventory[0].warehouseCode,
          quantity: 15,
          unitWeightKg: 12,
          unitVolumeCbm: 0.11,
          reefer: false,
          hazmat: false,
        },
        {
          sku: snapshot.availableInventory[1].sku,
          warehouseCode: snapshot.availableInventory[1].warehouseCode,
          quantity: 10,
          unitWeightKg: 9,
          unitVolumeCbm: 0.08,
          reefer: false,
          hazmat: false,
        },
      ];
    }
    return [
      {
        sku: "SKU-MIX-A",
        warehouseCode: "WH-MAIN",
        quantity: 20,
        unitWeightKg: 12,
        unitVolumeCbm: 0.1,
      },
      {
        sku: "SKU-MIX-B",
        warehouseCode: "WH-MAIN",
        quantity: 12,
        unitWeightKg: 8,
        unitVolumeCbm: 0.09,
      },
    ];
  }, [snapshot.availableInventory]);

  const [lines, setLines] = useState<MixedLoadSkuLine[]>(initialLines);
  const [formError, setFormError] = useState<string | null>(null);

  const liveEval = useMemo(
    () => evaluateMixedShipmentLoad(lines, equipmentType),
    [lines, equipmentType],
  );

  const updateLine = (idx: number, patch: Partial<MixedLoadSkuLine>) => {
    setLines((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    );
  };

  const addLine = () => {
    const nextInv =
      snapshot.availableInventory[lines.length % Math.max(1, snapshot.availableInventory.length)];
    setLines((prev) => [
      ...prev,
      {
        sku: nextInv?.sku ?? `SKU-CUSTOM-${prev.length + 1}`,
        warehouseCode: nextInv?.warehouseCode ?? "WH-MAIN",
        quantity: 10,
        unitWeightKg: 10,
        unitVolumeCbm: 0.08,
      },
    ]);
  };

  const removeLine = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleDispatch = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!customerName.trim() || !destinationCity.trim()) {
      setFormError("Customer name and destination city are required.");
      return;
    }
    if (!liveEval.compatible) {
      setFormError(liveEval.warnings[0] ?? "Resolve load compatibility issues first.");
      return;
    }
    await onAction({
      action: "create_mixed_shipment",
      customerName: customerName.trim(),
      destinationCity: destinationCity.trim(),
      equipmentType,
      lines,
    });
  };

  return (
    <div className="tac-split">
      <div className="tac-panel">
        <div className="tac-panel-head">
          <div>
            <h2>06. Mix Shipments to Match Customer Needs (Multi-SKU Consolidation)</h2>
            <p className="tac-sub">
              Consolidate multiple SKUs into tailored customer deliveries with automatic
              payload weight, cube utilization, and cold-chain/hazmat compatibility checks.
            </p>
          </div>
          <span className="tac-meta-line">
            {snapshot.mixedShipments.length} consolidated load
            {snapshot.mixedShipments.length === 1 ? "" : "s"} ·{" "}
            {(() => {
              const trips = snapshot.mixedShipments.reduce(
                (s, m) => s + m.deliveriesConsolidated,
                0,
              );
              return `${trips} single-SKU trip${trips === 1 ? "" : "s"} eliminated`;
            })()}
          </span>
        </div>

        {snapshot.mixedShipments.length === 0 ? (
          <div className="tac-empty">
            <strong>No mixed-SKU consolidated loads dispatched yet.</strong>
            <p>
              Combine two or more SKUs on the right to validate trailer weight, cube utilization,
              and cold-chain compatibility in one tailored delivery.
            </p>
          </div>
        ) : (
          <div className="tac-list">
            {snapshot.mixedShipments.map((plan) => (
              <article key={plan.id} className="tac-row-card">
                <div className="tac-row-main">
                  <div className="tac-row-title-line">
                    <strong className="tac-mono">{plan.reference}</strong>
                    <span className="tac-sep" aria-hidden="true">·</span>
                    <strong>{plan.customerName}</strong>
                    <span className="tac-sep" aria-hidden="true">·</span>
                    <span className="tac-muted">{plan.destinationCity}</span>
                  </div>
                  <p className="tac-row-desc">
                    {plan.lines
                      .map((l) => `${l.quantity}× ${l.sku}`)
                      .join(" + ")}{" "}
                    on {EQUIPMENT_LIMITS[plan.equipmentType].label}
                  </p>
                  <div className="tac-meta-line">
                    <span>{plan.totalUnits} total units</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Weight {plan.totalWeightKg.toLocaleString("en-US")} kg ({plan.weightFillPct}%)
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Cube {plan.totalVolumeCbm} cbm ({plan.volumeFillPct}%)
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {plan.deliveriesConsolidated} extra trip
                      {plan.deliveriesConsolidated === 1 ? "" : "s"} avoided
                    </span>
                  </div>
                </div>
                <div className="tac-row-actions">
                  <span className="tac-state tac-state-on_track">{plan.status}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <form className="tac-panel tac-form" onSubmit={handleDispatch}>
        <div className="tac-panel-head">
          <div>
            <h3>Build Mixed-SKU Consolidated Load</h3>
            <p className="tac-sub">
              Combine exact SKU quantities for one customer delivery.
            </p>
          </div>
        </div>

        <div className="tac-form-row">
          <label className="tac-field">
            <span>Customer</span>
            <input
              type="text"
              list="tac-mix-customers"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              disabled={readOnly || busy}
              required
            />
            <datalist id="tac-mix-customers">
              {snapshot.availableCustomers.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="tac-field">
            <span>Destination City</span>
            <input
              type="text"
              value={destinationCity}
              onChange={(e) => setDestinationCity(e.target.value)}
              disabled={readOnly || busy}
              required
            />
          </label>
        </div>

        <label className="tac-field">
          <span>Vehicle / Container Equipment</span>
          <select
            value={equipmentType}
            onChange={(e) =>
              setEquipmentType(e.target.value as MixedShipmentPlan["equipmentType"])
            }
            disabled={readOnly || busy}
          >
            {(
              Object.entries(EQUIPMENT_LIMITS) as [
                MixedShipmentPlan["equipmentType"],
                (typeof EQUIPMENT_LIMITS)["DRY_VAN_53"],
              ][]
            ).map(([key, info]) => (
              <option key={key} value={key}>
                {info.label} (max {info.maxWeightKg.toLocaleString("en-US")} kg / {info.maxVolumeCbm} cbm)
              </option>
            ))}
          </select>
        </label>

        <div className="tac-mix-lines">
          <div className="tac-mix-lines-head">
            <span>SKU Mix Lines ({lines.length})</span>
            <button
              type="button"
              className="bi-btn-ghost"
              onClick={addLine}
              disabled={readOnly || busy}
            >
              <Plus size={13} aria-hidden="true" />
              <span>Add SKU</span>
            </button>
          </div>

          {lines.map((line, idx) => (
            <div key={idx} className="tac-mix-line-row">
              <input
                type="text"
                aria-label={`SKU ${idx + 1}`}
                list="tac-mix-skus"
                value={line.sku}
                onChange={(e) => updateLine(idx, { sku: e.target.value })}
                placeholder="SKU code"
                disabled={readOnly || busy}
              />
              <input
                type="number"
                aria-label={`Quantity ${idx + 1}`}
                min={1}
                value={line.quantity}
                onChange={(e) =>
                  updateLine(idx, { quantity: Math.max(0, Number(e.target.value)) })
                }
                disabled={readOnly || busy}
              />
              <label className="tac-inline-check">
                <input
                  type="checkbox"
                  checked={Boolean(line.reefer)}
                  onChange={(e) => updateLine(idx, { reefer: e.target.checked })}
                  disabled={readOnly || busy}
                />
                <span>Cold</span>
              </label>
              <button
                type="button"
                className="bi-btn-ghost"
                aria-label={`Remove SKU line ${idx + 1}`}
                onClick={() => removeLine(idx)}
                disabled={lines.length <= 1 || readOnly || busy}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </div>
          ))}
          <datalist id="tac-mix-skus">
            {snapshot.availableInventory.map((i) => (
              <option key={`${i.warehouseCode}-${i.sku}`} value={i.sku} />
            ))}
          </datalist>
        </div>

        <div className="tac-eval-summary">
          <div>
            <span>Weight Fill</span>
            <strong>
              {liveEval.totalWeightKg.toLocaleString("en-US")} kg ({liveEval.weightFillPct}%)
            </strong>
          </div>
          <div>
            <span>Cube Fill</span>
            <strong>
              {liveEval.totalVolumeCbm} cbm ({liveEval.volumeFillPct}%)
            </strong>
          </div>
          <div>
            <span>Consolidation</span>
            <strong className="tac-good">
              {liveEval.consolidatedDeliveriesSaved} drop(s) saved
            </strong>
          </div>
        </div>

        {liveEval.warnings.length > 0 ? (
          <div className="tac-warning-box" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{liveEval.warnings.join(" ")}</span>
          </div>
        ) : null}

        {formError ? <p className="tac-error">{formError}</p> : null}

        <button
          type="submit"
          className="tac-btn-primary"
          disabled={readOnly || busy || !liveEval.compatible}
        >
          <Boxes size={14} aria-hidden="true" />
          <span>{busy ? "Dispatching…" : "Dispatch Mixed-SKU Load"}</span>
        </button>
      </form>
    </div>
  );
}

export function PreArrivalCustomsPanel({
  snapshot,
  busy,
  readOnly,
  onAction,
}: ExecutionPanelsProps) {
  return (
    <div className="tac-panel">
      <div className="tac-panel-head">
        <div>
          <h2>07. Don&apos;t Wait in Line at Customs (On-Water &amp; Wheels-Up Clearance)</h2>
          <p className="tac-sub">
            Submit electronic ISF, Air-AMS, Commercial Invoices, and HS-code declarations while
            sea vessels are still on the water or aircraft are in the air — eliminating port
            queue dwell and demurrage fees.
          </p>
        </div>
        <span className="tac-meta-line">
          {snapshot.totalPortHoursSaved}h queue time avoided ·{" "}
          {formatMoneyMajor(snapshot.totalDemurrageSavedMajor, snapshot.currency)} demurrage saved
        </span>
      </div>

      <div className="tac-kpi-strip">
        <div className="tac-kpi-box">
          <span className="tac-kpi-label">Active Sea &amp; Air Clearances</span>
          <strong className="tac-kpi-val">{snapshot.preArrivalFilings.length}</strong>
          <span className="tac-kpi-sub">Tracked on-water and wheels-up corridors</span>
        </div>
        <div className="tac-kpi-box">
          <span className="tac-kpi-label">Pre-Cleared Before Arrival</span>
          <strong className="tac-kpi-val tac-good">
            {
              snapshot.preArrivalFilings.filter(
                (f) => f.stage === "PRE_CLEARED_WHEELS_UP",
              ).length
            }
          </strong>
          <span className="tac-kpi-sub">Immediate port/tarmac release authorized</span>
        </div>
        <div className="tac-kpi-box">
          <span className="tac-kpi-label">Port &amp; Tarmac Hours Saved</span>
          <strong className="tac-kpi-val">{snapshot.totalPortHoursSaved}h</strong>
          <span className="tac-kpi-sub">Compared to post-arrival customs queue</span>
        </div>
        <div className="tac-kpi-box">
          <span className="tac-kpi-label">Avoided Demurrage Exposure</span>
          <strong className="tac-kpi-val tac-good">
            {formatMoneyMajor(snapshot.totalDemurrageSavedMajor, snapshot.currency)}
          </strong>
          <span className="tac-kpi-sub">Storage &amp; port detention avoided</span>
        </div>
      </div>

      <div className="scroller" tabIndex={0} role="region" aria-label="Pre-arrival customs filings">
        <table className="bi-table">
          <thead>
            <tr>
              <th scope="col">Shipment &amp; Corridor</th>
              <th scope="col">Transit Phase</th>
              <th scope="col">Docs &amp; HS Codes</th>
              <th scope="col" className="num">
                ETA Left
              </th>
              <th scope="col">Clearance Stage</th>
              <th scope="col" className="num">
                Hours Saved
              </th>
              <th scope="col" className="num">
                Pre-Arrival Action
              </th>
            </tr>
          </thead>
          <tbody>
            {snapshot.preArrivalFilings.map((filing) => (
              <tr key={filing.id}>
                <td>
                  <div className="bi-entity-cell">
                    <strong className="tac-mono">{filing.shipmentRef}</strong>
                    <span>{filing.corridor}</span>
                  </div>
                </td>
                <td>
                  <span className="tac-phase">
                    {filing.mode === "SEA" ? (
                      <Ship size={13} aria-hidden="true" />
                    ) : (
                      <Plane size={13} aria-hidden="true" />
                    )}
                    <span>
                      {filing.transitPhase === "ON_WATER" ? "On Water (SEA)" : "In Air (AIR)"}
                    </span>
                  </span>
                </td>
                <td>
                  <div className="bi-entity-cell">
                    <span>
                      {filing.readinessPct}% ready · HS {filing.hsCodes.join(", ")}
                    </span>
                    <span>Broker: {filing.broker}</span>
                  </div>
                </td>
                <td className="num">{filing.etaHoursRemaining}h</td>
                <td>
                  <span
                    className={`tac-state ${
                      filing.stage === "PRE_CLEARED_WHEELS_UP"
                        ? "tac-state-on_track"
                        : filing.stage === "PRE_FILED_IN_TRANSIT"
                          ? "tac-state-due_soon"
                          : "tac-state-overdue"
                    }`}
                  >
                    {filing.stage === "PRE_CLEARED_WHEELS_UP"
                      ? "Pre-Cleared (Wheels-Up)"
                      : filing.stage === "PRE_FILED_IN_TRANSIT"
                        ? "Pre-Filed In Transit"
                        : filing.stage === "HELD"
                          ? "Customs Hold"
                          : "Not Filed Yet"}
                  </span>
                </td>
                <td className="num bi-num-strong">{filing.portHoursSaved}h</td>
                <td className="num">
                  {filing.stage === "PRE_CLEARED_WHEELS_UP" ? (
                    <span className="tac-state tac-state-on_track">
                      <CheckCircle2 size={13} aria-hidden="true" />
                      Release Ready
                    </span>
                  ) : filing.stage === "PRE_FILED_IN_TRANSIT" ? (
                    <button
                      type="button"
                      className="tac-btn-primary"
                      disabled={readOnly || busy}
                      onClick={() =>
                        void onAction({
                          action: "update_pre_arrival_customs",
                          shipmentRef: filing.shipmentRef,
                          stage: "PRE_CLEARED_WHEELS_UP",
                        })
                      }
                    >
                      <ShieldCheck size={13} aria-hidden="true" />
                      <span>Confirm Wheels-Up Release</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="tac-btn-primary"
                      disabled={readOnly || busy}
                      onClick={() =>
                        void onAction({
                          action: "update_pre_arrival_customs",
                          shipmentRef: filing.shipmentRef,
                          stage: "PRE_FILED_IN_TRANSIT",
                        })
                      }
                    >
                      <ShieldCheck size={13} aria-hidden="true" />
                      <span>File Pre-Arrival Clearance</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
