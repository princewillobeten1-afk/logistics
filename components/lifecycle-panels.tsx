"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Layers, RefreshCw, RotateCcw } from "lucide-react";
import {
  advanceReplenishmentAction,
  runConsolidationAction,
  runReplenishmentSweepAction,
  updateInventoryPolicyAction,
} from "@/app/network-actions";
import { advanceRmaAction, createRmaAction } from "@/app/returns/actions";

export function ReplenishmentSweepButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  function handleRun() {
    setNotice(null);
    startTransition(async () => {
      const res = await runReplenishmentSweepAction();
      setNotice({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="row-center" style={{ gap: 10, flexWrap: "wrap" }}>
      <button type="button" className="btn btn-primary" onClick={handleRun} disabled={pending}>
        <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
        <span>{pending ? "Scanning stock…" : "Check Reorder Points"}</span>
      </button>
      {notice ? (
        <span className={notice.ok ? "text-muted text-xs" : "text-crit text-xs"} role="status">
          {notice.text}
        </span>
      ) : null}
    </div>
  );
}

export function ReplenishmentOrderActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function advance(targetStatus: "APPROVED" | "ORDERED" | "RECEIVED" | "CANCELLED") {
    startTransition(async () => {
      const res = await advanceReplenishmentAction({ id, targetStatus });
      if (res.ok) router.refresh();
    });
  }

  if (status === "RECEIVED" || status === "CANCELLED") {
    return <span className="text-faint text-xs">—</span>;
  }

  return (
    <div className="row-center" style={{ gap: 6, flexWrap: "wrap" }}>
      {status === "PROPOSED" ? (
        <button type="button" className="btn" disabled={pending} onClick={() => advance("APPROVED")}>
          Approve PO
        </button>
      ) : null}
      {status === "APPROVED" ? (
        <button type="button" className="btn" disabled={pending} onClick={() => advance("ORDERED")}>
          Mark Ordered
        </button>
      ) : null}
      {status === "PROPOSED" || status === "APPROVED" || status === "ORDERED" ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={() => advance("RECEIVED")}
        >
          Receive Stock
        </button>
      ) : null}
    </div>
  );
}

export function InventoryPolicyForm({ warehouses }: { warehouses: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [warehouseCode, setWarehouseCode] = useState(warehouses[0] ?? "Lagos");
  const [sku, setSku] = useState("DEFAULT");
  const [safetyStock, setSafetyStock] = useState("20");
  const [reorderPoint, setReorderPoint] = useState("40");
  const [reorderQuantity, setReorderQuantity] = useState("100");
  const [unitCostNaira, setUnitCostNaira] = useState("5000");
  const [annualHoldingRatePct, setAnnualHoldingRatePct] = useState("20");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    startTransition(async () => {
      const res = await updateInventoryPolicyAction({
        warehouseCode,
        sku,
        safetyStock: Number(safetyStock),
        reorderPoint: Number(reorderPoint),
        reorderQuantity: Number(reorderQuantity),
        unitCostNaira: Number(unitCostNaira),
        annualHoldingRatePct: Number(annualHoldingRatePct),
      });
      setNotice({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <form className="intake-form" onSubmit={onSubmit}>
      <div className="intake-grid">
        <label htmlFor="pol-wh">
          <span>Warehouse code *</span>
          <input
            id="pol-wh"
            required
            value={warehouseCode}
            onChange={(e) => setWarehouseCode(e.target.value)}
            placeholder="e.g. Lagos"
          />
        </label>
        <label htmlFor="pol-sku">
          <span>SKU *</span>
          <input
            id="pol-sku"
            required
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="DEFAULT"
          />
        </label>
        <label htmlFor="pol-safety">
          <span>Safety stock (units)</span>
          <input
            id="pol-safety"
            type="number"
            min={0}
            value={safetyStock}
            onChange={(e) => setSafetyStock(e.target.value)}
          />
        </label>
        <label htmlFor="pol-rop">
          <span>Reorder point (units)</span>
          <input
            id="pol-rop"
            type="number"
            min={0}
            value={reorderPoint}
            onChange={(e) => setReorderPoint(e.target.value)}
          />
        </label>
        <label htmlFor="pol-rqty">
          <span>Reorder qty</span>
          <input
            id="pol-rqty"
            type="number"
            min={1}
            value={reorderQuantity}
            onChange={(e) => setReorderQuantity(e.target.value)}
          />
        </label>
        <label htmlFor="pol-cost">
          <span>Unit cost (NGN)</span>
          <input
            id="pol-cost"
            type="number"
            min={0}
            value={unitCostNaira}
            onChange={(e) => setUnitCostNaira(e.target.value)}
          />
        </label>
        <label htmlFor="pol-rate">
          <span>Annual carrying rate (%)</span>
          <input
            id="pol-rate"
            type="number"
            min={0}
            max={200}
            value={annualHoldingRatePct}
            onChange={(e) => setAnnualHoldingRatePct(e.target.value)}
          />
        </label>
      </div>
      <div className="row-center" style={{ gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving thresholds…" : "Save Inventory Thresholds"}
        </button>
        {notice ? (
          <span className={notice.ok ? "text-muted text-xs" : "text-crit text-xs"} role="status">
            {notice.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function RunConsolidationButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  function handleRun() {
    setNotice(null);
    startTransition(async () => {
      const res = await runConsolidationAction();
      setNotice({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="row-center" style={{ gap: 10, flexWrap: "wrap" }}>
      <button type="button" className="btn" onClick={handleRun} disabled={pending}>
        <Layers size={15} strokeWidth={2} aria-hidden="true" />
        <span>{pending ? "Consolidating LTL/LCL…" : "Pool LTL / LCL Shipments"}</span>
      </button>
      {notice ? (
        <span className={notice.ok ? "text-muted text-xs" : "text-crit text-xs"} role="status">
          {notice.text}
        </span>
      ) : null}
    </div>
  );
}

export function CreateRmaForm({ warehouses }: { warehouses: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shipmentReference, setShipmentReference] = useState("");
  const [warehouseCode, setWarehouseCode] = useState(warehouses[0] ?? "");
  const [sku, setSku] = useState("DEFAULT");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("DEFECTIVE");
  const [lotNumber, setLotNumber] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [refundNaira, setRefundNaira] = useState("0");
  const [conditionNotes, setConditionNotes] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    startTransition(async () => {
      const res = await createRmaAction({
        shipmentReference,
        warehouseCode,
        sku,
        quantity: Number(quantity) || 1,
        reason,
        lotNumber,
        serialNumber,
        refundNaira: Number(refundNaira) || 0,
        conditionNotes,
      });
      setNotice({ ok: res.ok, text: res.message });
      if (res.ok) {
        setShipmentReference("");
        setConditionNotes("");
        setLotNumber("");
        setSerialNumber("");
        router.refresh();
      }
    });
  }

  return (
    <form className="intake-form" onSubmit={onSubmit}>
      <div className="intake-grid">
        <label htmlFor="rma-ship">
          <span>Original shipment ref</span>
          <input
            id="rma-ship"
            value={shipmentReference}
            onChange={(e) => setShipmentReference(e.target.value)}
            placeholder="e.g. LG-2026-..."
          />
        </label>
        <label htmlFor="rma-wh">
          <span>Return warehouse</span>
          <input
            id="rma-wh"
            value={warehouseCode}
            onChange={(e) => setWarehouseCode(e.target.value)}
            placeholder={warehouses[0] ?? "Lagos"}
          />
        </label>
        <label htmlFor="rma-sku">
          <span>SKU *</span>
          <input
            id="rma-sku"
            required
            value={sku}
            onChange={(e) => setSku(e.target.value)}
          />
        </label>
        <label htmlFor="rma-qty">
          <span>Quantity *</span>
          <input
            id="rma-qty"
            type="number"
            min={1}
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        <label htmlFor="rma-reason">
          <span>Lifecycle reason *</span>
          <select id="rma-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="DEFECTIVE">Defective / Quality failure</option>
            <option value="DAMAGED">Transit damaged</option>
            <option value="WRONG_ITEM">Wrong item shipped</option>
            <option value="WARRANTY">Warranty repair / replacement</option>
            <option value="RECALL">Safety / Lot recall</option>
            <option value="END_OF_LIFE">End-of-life / recycling</option>
            <option value="CUSTOMER_REMORSE">Unopened customer return</option>
          </select>
        </label>
        <label htmlFor="rma-lot">
          <span>Lot / Batch #</span>
          <input
            id="rma-lot"
            value={lotNumber}
            onChange={(e) => setLotNumber(e.target.value)}
            placeholder="Optional recall trace"
          />
        </label>
        <label htmlFor="rma-serial">
          <span>Serial #</span>
          <input
            id="rma-serial"
            value={serialNumber}
            onChange={(e) => setSerialNumber(e.target.value)}
            placeholder="Optional unit serial"
          />
        </label>
        <label htmlFor="rma-refund">
          <span>Refund / Credit (NGN)</span>
          <input
            id="rma-refund"
            type="number"
            min={0}
            value={refundNaira}
            onChange={(e) => setRefundNaira(e.target.value)}
          />
        </label>
      </div>
      <label htmlFor="rma-notes" style={{ display: "block", marginTop: 10 }}>
        <span>Inspection / condition notes</span>
        <input
          id="rma-notes"
          value={conditionNotes}
          onChange={(e) => setConditionNotes(e.target.value)}
          placeholder="Packaging intact, seal unbroken, water damage, etc."
        />
      </label>
      <div className="row-center" style={{ gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
          <span>{pending ? "Issuing RMA…" : "Issue Return Authorization"}</span>
        </button>
        {notice ? (
          <span className={notice.ok ? "text-muted text-xs" : "text-crit text-xs"} role="status">
            {notice.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function RmaLifecycleActions({ id, state }: { id: string; state: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function move(
    targetState: string,
    disposition?: "RESTOCK" | "REFURBISH" | "SCRAP" | "REPLACE" | "CREDIT",
  ) {
    startTransition(async () => {
      const res = await advanceRmaAction({ id, targetState, disposition });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="row-center" style={{ gap: 6, flexWrap: "wrap" }}>
      {state === "RETURN_REQUESTED" ? (
        <button type="button" className="btn" disabled={pending} onClick={() => move("PICKUP_SCHEDULED")}>
          Schedule Pickup
        </button>
      ) : null}
      {state === "RETURN_REQUESTED" || state === "PICKUP_SCHEDULED" || state === "IN_TRANSIT" ? (
        <button type="button" className="btn" disabled={pending} onClick={() => move("RECEIVED")}>
          Mark Received
        </button>
      ) : null}
      {state === "RECEIVED" ? (
        <button type="button" className="btn" disabled={pending} onClick={() => move("INSPECTED")}>
          Complete Inspection
        </button>
      ) : null}
      {state === "INSPECTED" || state === "REFURBISHED" ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={() => move("RESTOCKED", "RESTOCK")}
        >
          Restock to DC
        </button>
      ) : null}
      {state === "INSPECTED" ? (
        <>
          <button type="button" className="btn" disabled={pending} onClick={() => move("REFURBISHED", "REFURBISH")}>
            Refurbish
          </button>
          <button type="button" className="btn" disabled={pending} onClick={() => move("SCRAPPED", "SCRAP")}>
            Scrap
          </button>
        </>
      ) : null}
      {state === "RECALLED" ? (
        <button type="button" className="btn" disabled={pending} onClick={() => move("SCRAPPED", "SCRAP")}>
          Quarantine &amp; Scrap
        </button>
      ) : null}
      {state === "RESTOCKED" || state === "REFURBISHED" || state === "SCRAPPED" || state === "RECALLED" ? (
        <button type="button" className="btn" disabled={pending} onClick={() => move("CLOSED")}>
          Close RMA
        </button>
      ) : null}
    </div>
  );
}
