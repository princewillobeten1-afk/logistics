"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  MapPin,
  PackageCheck,
  Repeat,
  ScanBarcode,
} from "lucide-react";
import { formatMoneyMajor } from "@/lib/intelligence/engine";
import type {
  ScanCheckpoint,
  TacticsWorkspaceSnapshot,
} from "@/lib/tactics/types";

interface InventoryPanelsProps {
  snapshot: TacticsWorkspaceSnapshot;
  busy: boolean;
  readOnly: boolean;
  onAction: (payload: Record<string, unknown>) => Promise<boolean>;
}

export function PrecisionTrackingPanel({
  snapshot,
  busy,
  readOnly,
  onAction,
}: InventoryPanelsProps) {
  const firstInv = snapshot.availableInventory[0];
  const [barcode, setBarcode] = useState(
    firstInv ? `(01)${firstInv.sku}(10)LOT26` : "(01)SKU-1001(10)LOT26",
  );
  const [warehouseCode, setWarehouseCode] = useState(
    firstInv?.warehouseCode ?? snapshot.postponementCenters[0]?.warehouseCode ?? "WH-MAIN",
  );
  const [checkpoint, setCheckpoint] = useState<ScanCheckpoint>("RECEIVING");
  const [scannedQty, setScannedQty] = useState(String(firstInv?.onHand ?? 50));
  const [gpsLat, setGpsLat] = useState("6.5244");
  const [gpsLon, setGpsLon] = useState("3.3792");
  const [formError, setFormError] = useState<string | null>(null);

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const qty = Number(scannedQty);
    if (!barcode.trim() || !Number.isFinite(qty) || qty < 0) {
      setFormError("Enter a valid GS1/SKU barcode and non-negative unit count.");
      return;
    }
    await onAction({
      action: "record_barcode_scan",
      barcode: barcode.trim(),
      warehouseCode,
      checkpoint,
      scannedQty: qty,
      gpsLat: Number(gpsLat),
      gpsLon: Number(gpsLon),
      locationLabel: `${warehouseCode} · ${checkpoint.replace(/_/g, " ")}`,
    });
  };

  return (
    <div className="tac-split">
      <div className="tac-panel">
        <div className="tac-panel-head">
          <div>
            <h2>03. Precision Inventory Tracking (GPS + Barcode Systems)</h2>
            <p className="tac-sub">
              Unify GS1-128 / SKU barcode scans with live GPS custody coordinates across
              warehouses, cross-docks, and fleet conveyances to eliminate phantom inventory.
            </p>
          </div>
          <span className="tac-meta-line">
            Accuracy: {snapshot.inventoryAccuracyPct}% · {snapshot.gpsTrackedAssetsCount}/
            {snapshot.totalFleetAssetsCount} fleet GPS live
          </span>
        </div>

        {snapshot.barcodeScans.length === 0 ? (
          <div className="tac-empty">
            <strong>No barcode &amp; GPS verification scans recorded yet.</strong>
            <p>
              Scan a GS1-128 or SKU barcode on the right to stamp physical count and GPS custody
              coordinates.
            </p>
          </div>
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Barcode and GPS scan ledger">
            <table className="bi-table">
              <thead>
                <tr>
                  <th scope="col">Barcode / SKU</th>
                  <th scope="col">Checkpoint</th>
                  <th scope="col" className="num">
                    Expected
                  </th>
                  <th scope="col" className="num">
                    Scanned
                  </th>
                  <th scope="col" className="num">
                    Variance
                  </th>
                  <th scope="col">GPS Coordinates</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.barcodeScans.map((scan) => (
                  <tr key={scan.id}>
                    <td>
                      <div className="bi-entity-cell">
                        <strong className="tac-mono">{scan.sku}</strong>
                        <span className="tac-mono">{scan.barcode}</span>
                      </div>
                    </td>
                    <td>
                      <div className="bi-entity-cell">
                        <strong>{scan.checkpoint.replace(/_/g, " ")}</strong>
                        <span>{scan.warehouseCode}</span>
                      </div>
                    </td>
                    <td className="num">{scan.expectedQty}</td>
                    <td className="num bi-num-strong">{scan.scannedQty}</td>
                    <td
                      className={`num ${
                        scan.variance === 0 ? "tac-good" : "tac-warn"
                      }`}
                    >
                      {scan.variance > 0 ? `+${scan.variance}` : scan.variance}
                    </td>
                    <td className="num tac-mono">
                      <span className="tac-gps-cell">
                        <MapPin size={12} aria-hidden="true" />
                        {scan.gpsLat.toFixed(4)}, {scan.gpsLon.toFixed(4)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <form className="tac-panel tac-form" onSubmit={handleScan}>
        <div className="tac-panel-head">
          <div>
            <h3>Verify Barcode &amp; GPS Custody Scan</h3>
            <p className="tac-sub">
              Scan a GS1-128 or SKU barcode to reconcile physical stock and stamp GPS coordinates.
            </p>
          </div>
        </div>

        <label className="tac-field">
          <span>GS1-128 / SKU Barcode</span>
          <input
            type="text"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            placeholder="(01)SKU-ELEC-01(10)LOT44"
            disabled={readOnly || busy}
            required
          />
        </label>

        {snapshot.availableInventory.length > 0 ? (
          <div className="tac-quick-skus">
            <span className="tac-field-hint">Quick-fill from live warehouse SKUs:</span>
            <div className="tac-quick-row">
              {snapshot.availableInventory.slice(0, 4).map((inv) => (
                <button
                  key={`${inv.warehouseCode}-${inv.sku}`}
                  type="button"
                  className="bi-btn-ghost"
                  onClick={() => {
                    setBarcode(`(01)${inv.sku}(10)LOT26`);
                    setWarehouseCode(inv.warehouseCode);
                    setScannedQty(String(inv.onHand));
                  }}
                >
                  {inv.sku}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="tac-form-row">
          <label className="tac-field">
            <span>Site / Hub</span>
            <input
              type="text"
              value={warehouseCode}
              onChange={(e) => setWarehouseCode(e.target.value)}
              disabled={readOnly || busy}
            />
          </label>
          <label className="tac-field">
            <span>Checkpoint</span>
            <select
              value={checkpoint}
              onChange={(e) => setCheckpoint(e.target.value as ScanCheckpoint)}
              disabled={readOnly || busy}
            >
              <option value="RECEIVING">Receiving</option>
              <option value="PUTAWAY">Putaway</option>
              <option value="PICKING">Picking</option>
              <option value="CROSS_DOCK">Cross-Dock</option>
              <option value="IN_TRANSIT">In Transit</option>
              <option value="DELIVERED">Delivered</option>
            </select>
          </label>
        </div>

        <div className="tac-form-row">
          <label className="tac-field">
            <span>Physical Scanned Qty</span>
            <input
              type="number"
              min={0}
              value={scannedQty}
              onChange={(e) => setScannedQty(e.target.value)}
              disabled={readOnly || busy}
              required
            />
          </label>
          <label className="tac-field">
            <span>GPS Lat / Lon</span>
            <div className="tac-gps-inputs">
              <input
                type="number"
                step="0.0001"
                value={gpsLat}
                onChange={(e) => setGpsLat(e.target.value)}
                aria-label="GPS latitude"
                disabled={readOnly || busy}
              />
              <input
                type="number"
                step="0.0001"
                value={gpsLon}
                onChange={(e) => setGpsLon(e.target.value)}
                aria-label="GPS longitude"
                disabled={readOnly || busy}
              />
            </div>
          </label>
        </div>

        {formError ? <p className="tac-error">{formError}</p> : null}

        <button
          type="submit"
          className="tac-btn-primary"
          disabled={readOnly || busy}
        >
          <ScanBarcode size={14} aria-hidden="true" />
          <span>{busy ? "Recording…" : "Record Barcode + GPS Scan"}</span>
        </button>
      </form>
    </div>
  );
}

export function InTransitFlowPanel({
  snapshot,
  busy,
  readOnly,
  onAction,
}: InventoryPanelsProps) {
  const { inTransit, currency } = snapshot;

  return (
    <div className="tac-panel">
      <div className="tac-panel-head">
        <div>
          <h2>04. Keep Inventory in Transit (Flow-Through &amp; Cross-Dock Optimizer)</h2>
          <p className="tac-sub">
            Reduce warehouse carrying costs ({inTransit.annualCarryingCostRatePct}% annual
            holding benchmark) by converting slow-moving static storage SKUs into continuous
            in-transit cross-dock flow-through.
          </p>
        </div>
        <span className="tac-meta-line">
          Rolling In-Transit Share: {inTransit.inTransitRatioPct}% (Target {inTransit.targetRatioPct}%)
        </span>
      </div>

      <div className="tac-kpi-strip">
        <div className="tac-kpi-box">
          <span className="tac-kpi-label">In-Transit Rolling Units</span>
          <strong className="tac-kpi-val">
            {inTransit.inTransitUnits.toLocaleString("en-US")} units
          </strong>
          <span className="tac-kpi-sub">
            Est. value {formatMoneyMajor(inTransit.estimatedInTransitValueMajor, currency)}
          </span>
        </div>
        <div className="tac-kpi-box">
          <span className="tac-kpi-label">Static Warehouse Units</span>
          <strong className="tac-kpi-val">
            {inTransit.warehouseUnits.toLocaleString("en-US")} units
          </strong>
          <span className="tac-kpi-sub">
            Est. value {formatMoneyMajor(inTransit.estimatedWarehouseValueMajor, currency)}
          </span>
        </div>
        <div className="tac-kpi-box">
          <span className="tac-kpi-label">Monthly Carrying Cost Avoided</span>
          <strong className="tac-kpi-val tac-good">
            {formatMoneyMajor(inTransit.monthlyCarryingSavingsMajor, currency)}/mo
          </strong>
          <span className="tac-kpi-sub">
            From moving stock in transit vs. static storage
          </span>
        </div>
        <div className="tac-kpi-box">
          <span className="tac-kpi-label">Cross-Dock Flow SKUs</span>
          <strong className="tac-kpi-val">
            {inTransit.crossDockEnabledSkus} / {inTransit.candidates.length}
          </strong>
          <span className="tac-kpi-sub">SKUs bypassing long-term rack storage</span>
        </div>
      </div>

      {inTransit.candidates.length === 0 ? (
        <div className="tac-empty">
          <strong>No warehouse SKU stock lines loaded yet.</strong>
          <p>
            Add warehouse inventory in{" "}
            <Link href="/warehouses" className="tac-link">
              Warehouses &amp; Inventory
            </Link>{" "}
            to calculate monthly holding costs and convert static storage SKUs into rolling
            cross-dock flow-through.
          </p>
        </div>
      ) : (
        <div className="scroller" tabIndex={0} role="region" aria-label="Flow-through conversion table">
          <table className="bi-table">
            <thead>
              <tr>
                <th scope="col">Warehouse / SKU</th>
                <th scope="col" className="num">
                  On Hand
                </th>
                <th scope="col" className="num">
                  Monthly Storage Cost
                </th>
                <th scope="col" className="num">
                  Projected Savings
                </th>
                <th scope="col">Flow Mode</th>
                <th scope="col" className="num">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {inTransit.candidates.map((row) => (
                <tr key={`${row.warehouseCode}-${row.sku}`}>
                  <td>
                    <div className="bi-entity-cell">
                      <strong className="tac-mono">{row.sku}</strong>
                      <span>{row.warehouseCode}</span>
                    </div>
                  </td>
                  <td className="num">{row.onHand.toLocaleString("en-US")}</td>
                  <td className="num">
                    {formatMoneyMajor(row.monthlyHoldingCostMajor, currency)}/mo
                  </td>
                  <td className="num tac-good">
                    {formatMoneyMajor(row.projectedMonthlySavingsMajor, currency)}/mo
                  </td>
                  <td>
                    <span
                      className={`tac-state ${
                        row.mode === "CROSS_DOCK_FLOW"
                          ? "tac-state-on_track"
                          : "tac-state-due_soon"
                      }`}
                    >
                      {row.mode === "CROSS_DOCK_FLOW"
                        ? "Cross-Dock In-Transit"
                        : "Static Storage"}
                    </span>
                  </td>
                  <td className="num">
                    <button
                      type="button"
                      className={
                        row.mode === "CROSS_DOCK_FLOW"
                          ? "bi-btn-outline"
                          : "tac-btn-primary"
                      }
                      disabled={readOnly || busy}
                      onClick={() =>
                        void onAction({
                          action: "toggle_cross_dock",
                          warehouseCode: row.warehouseCode,
                          sku: row.sku,
                        })
                      }
                    >
                      <Repeat size={13} aria-hidden="true" />
                      <span>
                        {row.mode === "CROSS_DOCK_FLOW"
                          ? "Return to Storage"
                          : "Convert to Cross-Dock"}
                      </span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PostponementCentersPanel({
  snapshot,
  busy,
  readOnly,
  onAction,
}: InventoryPanelsProps) {
  const defaultWh =
    snapshot.postponementCenters.find((c) => c.enabled)?.warehouseCode ??
    snapshot.postponementCenters[0]?.warehouseCode ??
    "WH-MAIN";
  const [warehouseCode, setWarehouseCode] = useState(defaultWh);
  const [customerName, setCustomerName] = useState(
    snapshot.availableCustomers[0] ?? "",
  );
  const [baseSku, setBaseSku] = useState(
    snapshot.availableInventory[0]?.sku ?? "",
  );
  const [finalConfiguration, setFinalConfiguration] = useState("");
  const [quantity, setQuantity] = useState("25");
  const [formError, setFormError] = useState<string | null>(null);

  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!customerName.trim() || !baseSku.trim() || !finalConfiguration.trim()) {
      setFormError("Fill in customer, generic base SKU, and final localization/assembly spec.");
      return;
    }
    const ok = await onAction({
      action: "create_postponement_order",
      warehouseCode,
      customerName: customerName.trim(),
      baseSku: baseSku.trim(),
      finalConfiguration: finalConfiguration.trim(),
      quantity: Number(quantity),
    });
    if (ok) {
      setFinalConfiguration("");
    }
  };

  return (
    <div className="tac-stack">
      <div className="tac-panel">
        <div className="tac-panel-head">
          <div>
            <h2>05. Postponement Centers (Delayed Final Assembly &amp; Kitting)</h2>
            <p className="tac-sub">
              Avoid filling regional warehouses with the wrong SKU mix by holding generic base
              units and delaying final assembly, kitting, or country labeling until customer
              orders commit.
            </p>
          </div>
          <span className="tac-meta-line">
            Avoided wrong-mix stock cost:{" "}
            {formatMoneyMajor(snapshot.totalAvoidedMismatchMajor, snapshot.currency)}
          </span>
        </div>

        {snapshot.postponementCenters.length === 0 ? (
          <div className="tac-empty">
            <strong>No warehouse hubs configured yet.</strong>
            <p>
              Register regional warehouses in{" "}
              <Link href="/warehouses" className="tac-link">
                Warehouses &amp; Inventory
              </Link>{" "}
              to designate dedicated postponement centers, or queue a delayed assembly work order
              below using any hub code.
            </p>
          </div>
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Postponement center designations">
            <table className="bi-table">
              <thead>
                <tr>
                  <th scope="col">Warehouse Hub</th>
                  <th scope="col" className="num">
                    Dispatch Lead
                  </th>
                  <th scope="col" className="num">
                    Generic Base Stock
                  </th>
                  <th scope="col" className="num">
                    Active Assembly Orders
                  </th>
                  <th scope="col">Postponement Capability</th>
                  <th scope="col" className="num">
                    Designate Center
                  </th>
                </tr>
              </thead>
              <tbody>
                {snapshot.postponementCenters.map((center) => (
                  <tr key={center.warehouseCode}>
                    <td>
                      <div className="bi-entity-cell">
                        <strong>
                          {center.warehouseCode} · {center.warehouseName}
                        </strong>
                        <span>
                          {center.city}
                          {center.country ? `, ${center.country}` : ""}
                        </span>
                      </div>
                    </td>
                    <td className="num">{center.dispatchLeadHours}h</td>
                    <td className="num">{center.baseUnitsHeld.toLocaleString("en-US")} units</td>
                    <td className="num">{center.activeWorkOrders}</td>
                    <td>
                      <span
                        className={`tac-state ${
                          center.enabled ? "tac-state-on_track" : "tac-state-due_soon"
                        }`}
                      >
                        {center.enabled ? "Active Postponement Center" : "Standard Storage"}
                      </span>
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className={center.enabled ? "bi-btn-outline" : "tac-btn-primary"}
                        disabled={readOnly || busy}
                        onClick={() =>
                          void onAction({
                            action: "toggle_postponement_center",
                            warehouseCode: center.warehouseCode,
                          })
                        }
                      >
                        {center.enabled ? "Disable Center" : "Enable Postponement"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="tac-split">
        <div className="tac-panel">
          <div className="tac-panel-head">
            <div>
              <h3>Delayed Assembly &amp; Kitting Work Orders</h3>
              <p className="tac-sub">
                Advance postponed base units through final assembly once demand is confirmed.
              </p>
            </div>
          </div>

          {snapshot.postponementOrders.length === 0 ? (
            <div className="tac-empty">
              <strong>No delayed assembly work orders queued yet.</strong>
              <p>
                Schedule a postponement order on the right to hold generic base stock until exact
                customer specifications arrive.
              </p>
            </div>
          ) : (
            <div className="tac-list">
              {snapshot.postponementOrders.map((order) => (
                <article key={order.id} className="tac-row-card">
                  <div className="tac-row-main">
                    <div className="tac-row-title-line">
                      <strong>{order.customerName}</strong>
                      <span className="tac-sep" aria-hidden="true">·</span>
                      <span className="tac-mono">
                        {order.quantity}× {order.baseSku}
                      </span>
                      <span className="tac-sep" aria-hidden="true">·</span>
                      <span className="tac-muted">{order.warehouseCode}</span>
                    </div>
                    <p className="tac-row-desc">{order.finalConfiguration}</p>
                    <div className="tac-meta-line">
                      <span>Stage: {order.stage.replace(/_/g, " ")}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        Avoided wrong-mix cost:{" "}
                        {formatMoneyMajor(order.avoidedMismatchCostMajor, snapshot.currency)}
                      </span>
                    </div>
                  </div>

                  <div className="tac-row-actions">
                    {order.stage !== "READY_TO_SHIP" ? (
                      <button
                        type="button"
                        className="tac-btn-primary"
                        disabled={readOnly || busy}
                        onClick={() =>
                          void onAction({
                            action: "advance_postponement_order",
                            orderId: order.id,
                          })
                        }
                      >
                        <span>
                          Next:{" "}
                          {order.stage === "BASE_STOCK_HELD"
                            ? "Commit Order"
                            : order.stage === "ORDER_COMMITTED"
                              ? "Start Assembly"
                              : "Mark Ready"}
                        </span>
                        <ArrowRight size={13} aria-hidden="true" />
                      </button>
                    ) : (
                      <span className="tac-state tac-state-on_track">
                        <CheckCircle2 size={13} aria-hidden="true" />
                        Ready to Ship
                      </span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <form className="tac-panel tac-form" onSubmit={handleCreateOrder}>
          <div className="tac-panel-head">
            <div>
              <h3>Queue Delayed Assembly Order</h3>
              <p className="tac-sub">
                Hold generic base stock at a postponement hub until exact customer specs arrive.
              </p>
            </div>
          </div>

          <label className="tac-field">
            <span>Postponement Hub</span>
            {snapshot.postponementCenters.length > 0 ? (
              <select
                value={warehouseCode}
                onChange={(e) => setWarehouseCode(e.target.value)}
                disabled={readOnly || busy}
              >
                {snapshot.postponementCenters.map((c) => (
                  <option key={c.warehouseCode} value={c.warehouseCode}>
                    {c.warehouseCode} · {c.warehouseName}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={warehouseCode}
                onChange={(e) => setWarehouseCode(e.target.value)}
                placeholder="e.g. WH-MAIN"
                disabled={readOnly || busy}
                required
              />
            )}
          </label>

          <label className="tac-field">
            <span>Target Customer</span>
            <input
              type="text"
              list="tac-pp-customers"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Customer name"
              disabled={readOnly || busy}
              required
            />
            <datalist id="tac-pp-customers">
              {snapshot.availableCustomers.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>

          <div className="tac-form-row">
            <label className="tac-field">
              <span>Generic Base SKU</span>
              <input
                type="text"
                list="tac-pp-skus"
                value={baseSku}
                onChange={(e) => setBaseSku(e.target.value)}
                placeholder="e.g. SKU-BASE-01"
                disabled={readOnly || busy}
                required
              />
              <datalist id="tac-pp-skus">
                {snapshot.availableInventory.map((i) => (
                  <option key={`${i.warehouseCode}-${i.sku}`} value={i.sku} />
                ))}
              </datalist>
            </label>
            <label className="tac-field">
              <span>Units</span>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                disabled={readOnly || busy}
                required
              />
            </label>
          </div>

          <label className="tac-field">
            <span>Final Assembly / Localization Spec</span>
            <input
              type="text"
              value={finalConfiguration}
              onChange={(e) => setFinalConfiguration(e.target.value)}
              placeholder="e.g. Local language manual + retail bundle kitting"
              disabled={readOnly || busy}
              required
            />
          </label>

          {formError ? <p className="tac-error">{formError}</p> : null}

          <button
            type="submit"
            className="tac-btn-primary"
            disabled={readOnly || busy}
          >
            <PackageCheck size={14} aria-hidden="true" />
            <span>{busy ? "Scheduling…" : "Create Postponement Order"}</span>
          </button>
        </form>
      </div>
    </div>
  );
}
