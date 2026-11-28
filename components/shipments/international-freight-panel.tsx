"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Globe2, Plus, Ship } from "lucide-react";
import {
  ALLOWED_DIRECTIONS,
  ALLOWED_FREIGHT_MODES,
  ALLOWED_INCOTERMS,
  evaluateCustomsReadiness,
  summarizeInternationalFreight,
  type CustomsClearanceStatus,
  type FreightDirection,
  type FreightMode,
  type IncotermCode,
  type InternationalFreightRecord,
} from "@/lib/verticals/freight-and-3pl";

interface Props {
  initialRecords: InternationalFreightRecord[];
  shipmentReferences: string[];
  canEdit: boolean;
}

const NEXT_STATUS_ACTION: Record<
  CustomsClearanceStatus,
  { next: CustomsClearanceStatus; label: string } | null
> = {
  PENDING_DOCS: { next: "DOCS_VERIFIED", label: "Verify Docs" },
  DOCS_VERIFIED: { next: "SUBMITTED", label: "Submit to Customs" },
  SUBMITTED: { next: "CLEARED", label: "Mark Cleared" },
  HELD: { next: "CLEARED", label: "Release Hold" },
  CLEARED: null,
};

function statusTone(status: CustomsClearanceStatus): "ok" | "warn" | "crit" | "neutral" {
  if (status === "CLEARED") return "ok";
  if (status === "HELD") return "crit";
  if (status === "SUBMITTED" || status === "DOCS_VERIFIED") return "warn";
  return "neutral";
}

export function InternationalFreightPanel({
  initialRecords,
  shipmentReferences,
  canEdit,
}: Props) {
  const router = useRouter();
  const [records, setRecords] = useState<InternationalFreightRecord[]>(initialRecords);
  const [showForm, setShowForm] = useState(initialRecords.length === 0);
  const [saving, setSaving] = useState(false);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const [shipmentReference, setShipmentReference] = useState(
    shipmentReferences[0] ?? "",
  );
  const [direction, setDirection] = useState<FreightDirection>("EXPORT");
  const [transportMode, setTransportMode] = useState<FreightMode>("SEA");
  const [incoterm, setIncoterm] = useState<IncotermCode>("FOB");
  const [containerOrWaybill, setContainerOrWaybill] = useState("");
  const [originCountry, setOriginCountry] = useState("NL");
  const [destinationCountry, setDestinationCountry] = useState("US");
  const [portOfLoading, setPortOfLoading] = useState("");
  const [portOfDischarge, setPortOfDischarge] = useState("");
  const [hsCodes, setHsCodes] = useState("8471.30");
  const [declaredValueUsd, setDeclaredValueUsd] = useState(45000);
  const [customsBroker, setCustomsBroker] = useState("");
  const [commercialInvoiceReady, setCommercialInvoiceReady] = useState(true);
  const [packingListReady, setPackingListReady] = useState(true);
  const [certificateOfOriginReady, setCertificateOfOriginReady] = useState(false);

  const summary = summarizeInternationalFreight(records);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/international-freight", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          shipmentReference,
          direction,
          transportMode,
          incoterm,
          containerOrWaybill,
          originCountry,
          destinationCountry,
          portOfLoading: portOfLoading.trim() || null,
          portOfDischarge: portOfDischarge.trim() || null,
          hsCodes,
          declaredValueUsd,
          customsBroker: customsBroker.trim() || null,
          commercialInvoiceReady,
          packingListReady,
          certificateOfOriginReady,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        records?: InternationalFreightRecord[];
      };
      if (!res.ok || !data.ok) {
        setNotice({
          tone: "err",
          text: data.error ?? "Failed to file international customs record.",
        });
        return;
      }
      if (data.records) setRecords(data.records);
      setContainerOrWaybill("");
      setShowForm(false);
      setNotice({
        tone: "ok",
        text: `International freight filing saved for ${shipmentReference.toUpperCase()}.`,
      });
      router.refresh();
    } catch {
      setNotice({ tone: "err", text: "Network error filing international customs record." });
    } finally {
      setSaving(false);
    }
  }

  async function handleAdvanceStatus(ref: string, nextStatus: CustomsClearanceStatus) {
    if (!canEdit) return;
    setBusyRef(ref);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/international-freight", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          shipmentReference: ref,
          clearanceStatus: nextStatus,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        records?: InternationalFreightRecord[];
      };
      if (!res.ok || !data.ok) {
        setNotice({ tone: "err", text: data.error ?? "Could not update customs status." });
        return;
      }
      if (data.records) setRecords(data.records);
      setNotice({
        tone: "ok",
        text: `${ref} customs clearance advanced to ${nextStatus.replace(/_/g, " ")}.`,
      });
      router.refresh();
    } catch {
      setNotice({ tone: "err", text: "Network error updating customs status." });
    } finally {
      setBusyRef(null);
    }
  }

  return (
    <div className="biz-config">
      {notice ? (
        <div role="status" className="biz-notice" data-tone={notice.tone}>
          {notice.text}
        </div>
      ) : null}

      <div className="biz-kpi-grid">
        <div className="biz-kpi-card">
          <div className="biz-kpi-label">International Filings</div>
          <div className="biz-kpi-value mono">{summary.total}</div>
        </div>
        <div className="biz-kpi-card">
          <div className="biz-kpi-label">Modal Split</div>
          <div className="biz-kpi-metrics">
            {summary.seaCount} sea · {summary.airCount} air · {summary.roadRailCount} road/rail
          </div>
        </div>
        <div className="biz-kpi-card">
          <div className="biz-kpi-label">Customs Status</div>
          <div className="biz-kpi-metrics">
            {summary.clearedCount} cleared · {summary.heldCount} held
          </div>
        </div>
        <div className="biz-kpi-card">
          <div className="biz-kpi-label">Declared Cargo Value</div>
          <div className="biz-kpi-value mono">
            ${summary.totalDeclaredUsd.toLocaleString("en-US", {
              maximumFractionDigits: 0,
            })}
          </div>
        </div>
      </div>

      <div className="biz-card">
        <div className="biz-card-head">
          <div className="biz-card-title">
            <Globe2 size={16} strokeWidth={1.85} aria-hidden="true" />
            <span>International Freight, Customs &amp; Container Tracking</span>
          </div>
          {canEdit ? (
            <button
              type="button"
              className="search-submit-btn"
              onClick={() => setShowForm((v) => !v)}
            >
              <Plus size={14} strokeWidth={2} aria-hidden="true" />
              <span>{showForm ? "Hide filing form" : "New customs filing"}</span>
            </button>
          ) : null}
        </div>

        {showForm && canEdit ? (
          <form onSubmit={handleSubmit} className="biz-config">
            <div className="biz-form-grid">
              <label className="biz-field">
                <span className="biz-field-label">Shipment reference</span>
                <input
                  required
                  list="intl-shipment-refs"
                  value={shipmentReference}
                  onChange={(e) => setShipmentReference(e.target.value)}
                  placeholder="LG-10421"
                  className="biz-input"
                />
                <datalist id="intl-shipment-refs">
                  {shipmentReferences.map((ref) => (
                    <option key={ref} value={ref} />
                  ))}
                </datalist>
              </label>

              <label className="biz-field">
                <span className="biz-field-label">Direction</span>
                <select
                  value={direction}
                  onChange={(e) => setDirection(e.target.value as FreightDirection)}
                  className="biz-select"
                >
                  {ALLOWED_DIRECTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </label>

              <label className="biz-field">
                <span className="biz-field-label">Mode</span>
                <select
                  value={transportMode}
                  onChange={(e) => setTransportMode(e.target.value as FreightMode)}
                  className="biz-select"
                >
                  {ALLOWED_FREIGHT_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>

              <label className="biz-field">
                <span className="biz-field-label">Incoterm</span>
                <select
                  value={incoterm}
                  onChange={(e) => setIncoterm(e.target.value as IncotermCode)}
                  className="biz-select"
                >
                  {ALLOWED_INCOTERMS.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </label>

              <label className="biz-field biz-field-wide">
                <span className="biz-field-label">
                  {transportMode === "AIR"
                    ? "IATA Air Waybill (e.g., 176-12345678)"
                    : transportMode === "SEA"
                      ? "ISO Container or Bill of Lading (e.g., MSKU9070323)"
                      : "CMR / Rail Consignment Reference"}
                </span>
                <input
                  required
                  value={containerOrWaybill}
                  onChange={(e) => setContainerOrWaybill(e.target.value)}
                  placeholder={transportMode === "AIR" ? "176-12345678" : "MSKU9070323"}
                  className="biz-input"
                />
              </label>

              <label className="biz-field">
                <span className="biz-field-label">Origin country</span>
                <input
                  required
                  value={originCountry}
                  onChange={(e) => setOriginCountry(e.target.value)}
                  placeholder="NL"
                  className="biz-input"
                />
              </label>

              <label className="biz-field">
                <span className="biz-field-label">Destination country</span>
                <input
                  required
                  value={destinationCountry}
                  onChange={(e) => setDestinationCountry(e.target.value)}
                  placeholder="US"
                  className="biz-input"
                />
              </label>

              <label className="biz-field">
                <span className="biz-field-label">Port / airport of loading</span>
                <input
                  value={portOfLoading}
                  onChange={(e) => setPortOfLoading(e.target.value)}
                  placeholder="NLRTM · Rotterdam"
                  className="biz-input"
                />
              </label>

              <label className="biz-field">
                <span className="biz-field-label">Port / airport of discharge</span>
                <input
                  value={portOfDischarge}
                  onChange={(e) => setPortOfDischarge(e.target.value)}
                  placeholder="USLAX · Los Angeles"
                  className="biz-input"
                />
              </label>

              <label className="biz-field">
                <span className="biz-field-label">HS tariff codes (6–10 digits)</span>
                <input
                  required
                  value={hsCodes}
                  onChange={(e) => setHsCodes(e.target.value)}
                  placeholder="8471.30, 8504.40"
                  className="biz-input"
                />
              </label>

              <label className="biz-field">
                <span className="biz-field-label">Declared value (USD)</span>
                <input
                  type="number"
                  min={0}
                  step="100"
                  value={declaredValueUsd}
                  onChange={(e) => setDeclaredValueUsd(Number(e.target.value) || 0)}
                  className="biz-input"
                />
              </label>

              <label className="biz-field biz-field-wide">
                <span className="biz-field-label">Customs broker</span>
                <input
                  value={customsBroker}
                  onChange={(e) => setCustomsBroker(e.target.value)}
                  placeholder="Kuehne+Nagel Customs Brokerage"
                  className="biz-input"
                />
              </label>
            </div>

            <div className="biz-check-group">
              <span className="biz-field-label">Border clearance document packet</span>
              <div className="biz-check-row">
                <label className="biz-check-inline">
                  <input
                    type="checkbox"
                    checked={commercialInvoiceReady}
                    onChange={(e) => setCommercialInvoiceReady(e.target.checked)}
                  />
                  <span>Commercial Invoice verified</span>
                </label>
                <label className="biz-check-inline">
                  <input
                    type="checkbox"
                    checked={packingListReady}
                    onChange={(e) => setPackingListReady(e.target.checked)}
                  />
                  <span>Packing List verified</span>
                </label>
                <label className="biz-check-inline">
                  <input
                    type="checkbox"
                    checked={certificateOfOriginReady}
                    onChange={(e) => setCertificateOfOriginReady(e.target.checked)}
                  />
                  <span>Certificate of Origin attached</span>
                </label>
              </div>
            </div>

            <div className="biz-form-foot">
              <div className="biz-rationale">
                Validates HS tariff codes, ISO container / IATA Air Waybill references, and
                Incoterms before border submission.
              </div>
              <button type="submit" disabled={saving} className="biz-btn-primary">
                <Ship size={14} strokeWidth={2} aria-hidden="true" />
                <span>{saving ? "Filing..." : "Save Customs Filing"}</span>
              </button>
            </div>
          </form>
        ) : null}

        {records.length === 0 ? (
          <p className="biz-card-hint">
            No international customs filings recorded yet. Use the form above to track Air
            Waybills, ISO ocean containers, HS tariff codes, and border clearance milestones.
          </p>
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="International freight and customs records"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Shipment / Container</th>
                  <th scope="col">Mode &amp; Incoterm</th>
                  <th scope="col">Corridor</th>
                  <th scope="col">HS Codes</th>
                  <th scope="col">Clearance</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {records.map((rec) => {
                  const readiness = evaluateCustomsReadiness(rec);
                  const nextAction = NEXT_STATUS_ACTION[rec.clearanceStatus];
                  const isBusy = busyRef === rec.shipmentReference;
                  return (
                    <tr key={rec.id}>
                      <td>
                        <div className="ref">{rec.shipmentReference}</div>
                        <div className="biz-feature-source">{rec.containerOrWaybill}</div>
                      </td>
                      <td>
                        <div className="num">
                          {rec.transportMode} · {rec.incoterm}
                        </div>
                        <div className="biz-feature-source">{rec.direction}</div>
                      </td>
                      <td>
                        <div>
                          {rec.originCountry} → {rec.destinationCountry}
                        </div>
                        {rec.portOfLoading || rec.portOfDischarge ? (
                          <div className="biz-feature-source">
                            {rec.portOfLoading ?? "—"} → {rec.portOfDischarge ?? "—"}
                          </div>
                        ) : null}
                      </td>
                      <td className="num">{rec.hsCodes.join(", ")}</td>
                      <td>
                        <span
                          className="status-tag"
                          data-tone={statusTone(rec.clearanceStatus)}
                        >
                          {rec.clearanceStatus.replace(/_/g, " ")}
                        </span>
                        <div className="biz-feature-source">
                          {readiness.score}% ready
                        </div>
                      </td>
                      <td>
                        {canEdit && nextAction ? (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              handleAdvanceStatus(rec.shipmentReference, nextAction.next)
                            }
                            className="search-submit-btn"
                          >
                            {isBusy ? "Updating..." : nextAction.label}
                          </button>
                        ) : (
                          <span className="biz-feature-source">
                            {rec.clearanceStatus === "CLEARED" ? "Complete" : "Read only"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
