"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Layers, Plus, ShieldCheck } from "lucide-react";
import {
  ALLOWED_BILLING_MODELS,
  type BillingModel,
  type ClientFulfillmentReport,
  type ThirdPartyClientRecord,
} from "@/lib/verticals/freight-and-3pl";

interface Props {
  initialClients: ThirdPartyClientRecord[];
  initialReports: ClientFulfillmentReport[];
  warehouseCodes: string[];
  canEdit: boolean;
}

const BILLING_LABELS: Record<BillingModel, string> = {
  PER_PALLET_MONTH: "Per Pallet / Month",
  PER_ORDER_FULFILLMENT: "Per Order Pick & Pack",
  HYBRID_STORAGE_PICK: "Hybrid Storage + Pick Fee",
  DEDICATED_CONTRACT: "Dedicated Contract",
};

export function ThirdPartyClientsPanel({
  initialClients,
  initialReports,
  warehouseCodes,
  canEdit,
}: Props) {
  const router = useRouter();
  const [clients, setClients] = useState<ThirdPartyClientRecord[]>(initialClients);
  const [reports, setReports] = useState<ClientFulfillmentReport[]>(initialReports);
  const [showForm, setShowForm] = useState(initialClients.length === 0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const [clientCode, setClientCode] = useState("");
  const [clientName, setClientName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [slaHours, setSlaHours] = useState(24);
  const [billingModel, setBillingModel] = useState<BillingModel>("HYBRID_STORAGE_PICK");
  const [selectedWarehouses, setSelectedWarehouses] = useState<string[]>(
    warehouseCodes.slice(0, 1),
  );
  const [skuPrefixes, setSkuPrefixes] = useState("");
  const [monthlyStorageRateUsd, setMonthlyStorageRateUsd] = useState(18.5);
  const [perOrderPickFeeUsd, setPerOrderPickFeeUsd] = useState(3.25);

  function toggleWarehouse(code: string) {
    setSelectedWarehouses((prev) =>
      prev.includes(code) ? prev.filter((w) => w !== code) : [...prev, code],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/third-party-clients", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          clientCode,
          clientName,
          contactEmail: contactEmail.trim() || null,
          slaHours,
          billingModel,
          dedicatedWarehouses: selectedWarehouses,
          skuPrefixes: skuPrefixes
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          monthlyStorageRateUsd,
          perOrderPickFeeUsd,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        clients?: ThirdPartyClientRecord[];
        reports?: ClientFulfillmentReport[];
      };
      if (!res.ok || !data.ok) {
        setNotice({ tone: "err", text: data.error ?? "Failed to save 3PL client account." });
        return;
      }
      if (data.clients) setClients(data.clients);
      if (data.reports) setReports(data.reports);
      setClientCode("");
      setClientName("");
      setContactEmail("");
      setSkuPrefixes("");
      setShowForm(false);
      setNotice({
        tone: "ok",
        text: "3PL client account saved. Inventory segregation and client SLA reporting updated within your workspace.",
      });
      router.refresh();
    } catch {
      setNotice({ tone: "err", text: "Network error saving 3PL client account." });
    } finally {
      setSaving(false);
    }
  }

  const totalClientUnits = reports.reduce((s, r) => s + r.onHandUnits, 0);
  const totalEstRevenue = reports.reduce((s, r) => s + r.estimatedMonthlyRevenueUsd, 0);
  const activeCount = clients.filter((c) => c.active).length;

  return (
    <div className="biz-config">
      {notice ? (
        <div role="status" className="biz-notice" data-tone={notice.tone}>
          {notice.text}
        </div>
      ) : null}

      <div className="biz-kpi-grid">
        <div className="biz-kpi-card">
          <div className="biz-kpi-label">Active 3PL Clients</div>
          <div className="biz-kpi-value mono">{activeCount}</div>
        </div>
        <div className="biz-kpi-card">
          <div className="biz-kpi-label">Segregated Client Units</div>
          <div className="biz-kpi-value mono">{totalClientUnits.toLocaleString("en-US")}</div>
        </div>
        <div className="biz-kpi-card">
          <div className="biz-kpi-label">Est. Monthly 3PL Billing</div>
          <div className="biz-kpi-value mono">
            ${totalEstRevenue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="biz-kpi-card">
          <div className="biz-kpi-label">Tenant Boundary</div>
          <div className="biz-kpi-value">
            <span className="biz-core-badge">
              <ShieldCheck size={14} strokeWidth={2} aria-hidden="true" />
              <span>Workspace Isolated</span>
            </span>
          </div>
        </div>
      </div>

      <div className="biz-card">
        <div className="biz-card-head">
          <div className="biz-card-title">
            <Layers size={16} strokeWidth={1.85} aria-hidden="true" />
            <span>3PL Client Accounts &amp; Segregated Fulfillment Reporting</span>
          </div>
          {canEdit ? (
            <button
              type="button"
              className="search-submit-btn"
              onClick={() => setShowForm((v) => !v)}
            >
              <Plus size={14} strokeWidth={2} aria-hidden="true" />
              <span>{showForm ? "Hide form" : "Add 3PL client"}</span>
            </button>
          ) : null}
        </div>

        {showForm && canEdit ? (
          <form onSubmit={handleSubmit} className="biz-config">
            <div className="biz-form-grid">
              <label className="biz-field">
                <span className="biz-field-label">Client code</span>
                <input
                  required
                  value={clientCode}
                  onChange={(e) => setClientCode(e.target.value)}
                  placeholder="ACME"
                  className="biz-input"
                />
              </label>

              <label className="biz-field biz-field-wide">
                <span className="biz-field-label">Client company name</span>
                <input
                  required
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Acme Consumer Brands"
                  className="biz-input"
                />
              </label>

              <label className="biz-field">
                <span className="biz-field-label">Billing model</span>
                <select
                  value={billingModel}
                  onChange={(e) => setBillingModel(e.target.value as BillingModel)}
                  className="biz-select"
                >
                  {ALLOWED_BILLING_MODELS.map((m) => (
                    <option key={m} value={m}>
                      {BILLING_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="biz-field">
                <span className="biz-field-label">SKU prefixes (comma-separated)</span>
                <input
                  value={skuPrefixes}
                  onChange={(e) => setSkuPrefixes(e.target.value)}
                  placeholder="ACM-, ACME-"
                  className="biz-input"
                />
              </label>

              <label className="biz-field">
                <span className="biz-field-label">SLA target (hours)</span>
                <input
                  type="number"
                  min={4}
                  max={720}
                  value={slaHours}
                  onChange={(e) => setSlaHours(Number(e.target.value) || 24)}
                  className="biz-input"
                />
              </label>

              <label className="biz-field">
                <span className="biz-field-label">Storage rate ($/pallet/mo)</span>
                <input
                  type="number"
                  min={0}
                  step="0.25"
                  value={monthlyStorageRateUsd}
                  onChange={(e) => setMonthlyStorageRateUsd(Number(e.target.value) || 0)}
                  className="biz-input"
                />
              </label>

              <label className="biz-field">
                <span className="biz-field-label">Pick fee ($/order)</span>
                <input
                  type="number"
                  min={0}
                  step="0.25"
                  value={perOrderPickFeeUsd}
                  onChange={(e) => setPerOrderPickFeeUsd(Number(e.target.value) || 0)}
                  className="biz-input"
                />
              </label>

              <label className="biz-field biz-field-wide">
                <span className="biz-field-label">Client operations contact email</span>
                <input
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="supplychain@client.com"
                  className="biz-input"
                />
              </label>
            </div>

            {warehouseCodes.length > 0 ? (
              <div className="biz-check-group">
                <span className="biz-field-label">Assigned warehouse sites</span>
                <div className="biz-check-row">
                  {warehouseCodes.map((code) => (
                    <label key={code} className="biz-check-pill">
                      <input
                        type="checkbox"
                        checked={selectedWarehouses.includes(code)}
                        onChange={() => toggleWarehouse(code)}
                      />
                      <span>{code}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="biz-form-foot">
              <div className="biz-rationale">
                Client accounts segregate shared warehouse inventory, fulfillment SLAs, and
                billing reports strictly within your authorized 3PL workspace.
              </div>
              <button type="submit" disabled={saving} className="biz-btn-primary">
                <Building2 size={14} strokeWidth={2} aria-hidden="true" />
                <span>{saving ? "Saving..." : "Save 3PL Client Account"}</span>
              </button>
            </div>
          </form>
        ) : null}

        {reports.length === 0 ? (
          <p className="biz-card-hint">
            No 3PL client accounts configured yet. Add client accounts above to segregate
            shared warehouse inventory by SKU prefix or site and generate client-specific SLA
            and billing reports.
          </p>
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="3PL client fulfillment report"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Billing model</th>
                  <th scope="col">SLA</th>
                  <th scope="col">Segregated stock</th>
                  <th scope="col">Reserved</th>
                  <th scope="col">Shipments</th>
                  <th scope="col">On-time</th>
                  <th scope="col">Est. monthly</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.clientId}>
                    <td>
                      <div className="biz-feature-name">{r.clientName}</div>
                      <div className="biz-feature-source">{r.clientCode}</div>
                    </td>
                    <td className="text-muted">{BILLING_LABELS[r.billingModel]}</td>
                    <td className="num">{r.slaHours}h</td>
                    <td className="num">{r.onHandUnits.toLocaleString("en-US")}</td>
                    <td className="num">{r.reservedUnits.toLocaleString("en-US")}</td>
                    <td className="num">
                      {r.totalShipments} ({r.openShipments} open)
                    </td>
                    <td className="num">
                      <span
                        className="status-tag"
                        data-tone={
                          r.onTimeRatePct >= 95
                            ? "ok"
                            : r.onTimeRatePct >= 85
                              ? "warn"
                              : "crit"
                        }
                      >
                        {r.onTimeRatePct}%
                      </span>
                    </td>
                    <td className="num">
                      ${r.estimatedMonthlyRevenueUsd.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
