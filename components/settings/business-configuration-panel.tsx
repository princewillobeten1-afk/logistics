"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Building2,
  CheckCircle2,
  Layers,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
} from "lucide-react";
import { classifyBusinessProfile } from "@/lib/business-config/classifier";
import type { WorkspaceConfigurationBundle } from "@/lib/business-config/store";
import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  type BusinessArchetype,
  type BusinessOperationalProfile,
  type FeatureKey,
  type TransportMode,
} from "@/lib/business-config/types";

interface Props {
  initialBundle: WorkspaceConfigurationBundle;
  canEdit: boolean;
}

const ARCHETYPE_OPTIONS: { value: BusinessArchetype; label: string }[] = [
  { value: "COURIER", label: "Small / Last-Mile Courier" },
  { value: "REGIONAL_LOGISTICS", label: "Regional / Mid-Sized Logistics" },
  { value: "ENTERPRISE_NETWORK", label: "Large Multi-Branch Enterprise" },
  { value: "INTERNATIONAL_FREIGHT", label: "International Freight Forwarder" },
  { value: "THIRD_PARTY_LOGISTICS", label: "Third-Party Logistics (3PL)" },
];

const TRANSPORT_MODES: { value: TransportMode; label: string }[] = [
  { value: "ROAD", label: "Road" },
  { value: "AIR", label: "Air Freight" },
  { value: "SEA", label: "Sea / Ocean" },
  { value: "RAIL", label: "Rail" },
];

export function BusinessConfigurationPanel({ initialBundle, canEdit }: Props) {
  const router = useRouter();
  const [bundle, setBundle] = useState<WorkspaceConfigurationBundle>(initialBundle);
  const [draftProfile, setDraftProfile] = useState<BusinessOperationalProfile>(
    initialBundle.configuration.profile,
  );
  const [saving, setSaving] = useState(false);
  const [togglingKey, setTogglingKey] = useState<FeatureKey | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const previewClassification = useMemo(
    () => classifyBusinessProfile(draftProfile),
    [draftProfile],
  );

  const { configuration, observedMetrics, growthReassessment } = bundle;

  function toggleMode(mode: TransportMode) {
    setDraftProfile((prev) => {
      const exists = prev.transportModes.includes(mode);
      const next = exists
        ? prev.transportModes.filter((m) => m !== mode)
        : [...prev.transportModes, mode];
      return {
        ...prev,
        transportModes: next.length > 0 ? next : ["ROAD"],
      };
    });
  }

  async function saveProfileAndApprove(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/configuration", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          profile: draftProfile,
          approve: true,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        configuration?: WorkspaceConfigurationBundle["configuration"];
        observedMetrics?: WorkspaceConfigurationBundle["observedMetrics"];
        growthReassessment?: WorkspaceConfigurationBundle["growthReassessment"];
      };
      if (!res.ok || !data.ok || !data.configuration) {
        setNotice({ tone: "err", text: data.error ?? "Failed to save business configuration." });
        return;
      }
      const nextBundle: WorkspaceConfigurationBundle = {
        configuration: data.configuration,
        observedMetrics: data.observedMetrics ?? observedMetrics,
        growthReassessment: data.growthReassessment ?? growthReassessment,
      };
      setBundle(nextBundle);
      setDraftProfile(data.configuration.profile);
      setNotice({
        tone: "ok",
        text: `Business classification approved as ${data.configuration.classification.tier} (${data.configuration.classification.archetype.replace(/_/g, " ")}). All existing workspace records were preserved.`,
      });
      router.refresh();
    } catch {
      setNotice({ tone: "err", text: "Network error saving business configuration." });
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleFeature(key: FeatureKey) {
    if (!canEdit || FEATURE_CATALOG[key].coreRequired) return;
    setTogglingKey(key);
    setNotice(null);
    const nextEnabled = !configuration.entitlements[key]?.enabled;
    try {
      const res = await fetch("/api/workspace/configuration", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          entitlementOverrides: { [key]: nextEnabled },
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        configuration?: WorkspaceConfigurationBundle["configuration"];
        observedMetrics?: WorkspaceConfigurationBundle["observedMetrics"];
        growthReassessment?: WorkspaceConfigurationBundle["growthReassessment"];
      };
      if (!res.ok || !data.ok || !data.configuration) {
        setNotice({ tone: "err", text: data.error ?? "Could not update feature entitlement." });
        return;
      }
      setBundle({
        configuration: data.configuration,
        observedMetrics: data.observedMetrics ?? observedMetrics,
        growthReassessment: data.growthReassessment ?? growthReassessment,
      });
      setNotice({
        tone: "ok",
        text: `${FEATURE_CATALOG[key].label} ${nextEnabled ? "enabled" : "disabled"} independently of business tier (${data.configuration.classification.tier}).`,
      });
      router.refresh();
    } catch {
      setNotice({ tone: "err", text: "Network error updating feature entitlement." });
    } finally {
      setTogglingKey(null);
    }
  }

  async function handleApplyGrowthReassessment() {
    if (!canEdit) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/configuration", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          applyGrowthReassessment: true,
          preserveAdminOverrides: true,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        configuration?: WorkspaceConfigurationBundle["configuration"];
        observedMetrics?: WorkspaceConfigurationBundle["observedMetrics"];
        growthReassessment?: WorkspaceConfigurationBundle["growthReassessment"];
      };
      if (!res.ok || !data.ok || !data.configuration) {
        setNotice({ tone: "err", text: data.error ?? "Could not apply growth reassessment." });
        return;
      }
      setBundle({
        configuration: data.configuration,
        observedMetrics: data.observedMetrics ?? observedMetrics,
        growthReassessment: data.growthReassessment ?? growthReassessment,
      });
      setDraftProfile(data.configuration.profile);
      setNotice({
        tone: "ok",
        text: `Growth reassessment applied (${data.configuration.classification.tier} tier). Workspace ID, historical orders, shipments, and admin entitlement overrides preserved.`,
      });
      router.refresh();
    } catch {
      setNotice({ tone: "err", text: "Network error applying growth reassessment." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="biz-config">
      {notice ? (
        <div role="status" className="biz-notice" data-tone={notice.tone}>
          {notice.text}
        </div>
      ) : null}

      {/* Classification Readout Strip */}
      <div className="biz-kpi-grid">
        <div className="biz-kpi-card">
          <div className="biz-kpi-label">Classification Tier</div>
          <div className="biz-kpi-value mono">
            <span>{configuration.classification.tier}</span>
            <span className="biz-kpi-sub">· {configuration.approvedConfig.status}</span>
          </div>
        </div>

        <div className="biz-kpi-card">
          <div className="biz-kpi-label">Operational Archetype</div>
          <div className="biz-kpi-value">
            {configuration.classification.archetype.replace(/_/g, " ")}
          </div>
        </div>

        <div className="biz-kpi-card">
          <div className="biz-kpi-label">Complexity Index</div>
          <div className="biz-kpi-value mono">
            <span>{configuration.classification.complexityScore} / 100</span>
            <span className="biz-kpi-sub">
              ({configuration.classification.complexityBand.replace(/_/g, " ")})
            </span>
          </div>
        </div>

        <div className="biz-kpi-card">
          <div className="biz-kpi-label">Live Workspace Volume</div>
          <div className="biz-kpi-metrics">
            {observedMetrics.activeUsers} staff · {observedMetrics.vehicles} fleet ·{" "}
            {observedMetrics.warehouses} wh · {observedMetrics.shipments} shipments
          </div>
        </div>
      </div>

      {/* Growth Reassessment Banner */}
      {growthReassessment.needsReassessment ? (
        <div className="biz-growth-banner">
          <div className="biz-growth-head">
            <div className="biz-growth-title">
              <TrendingUp size={16} strokeWidth={2} aria-hidden="true" />
              <span>
                Growth Reassessment Recommended ({growthReassessment.currentTier} →{" "}
                {growthReassessment.projectedTier})
              </span>
            </div>
            {canEdit ? (
              <button
                type="button"
                disabled={saving}
                onClick={handleApplyGrowthReassessment}
                className="biz-btn-primary"
              >
                <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                <span>Apply Non-Destructive Upgrade</span>
              </button>
            ) : null}
          </div>
          <ul className="biz-growth-reasons">
            {growthReassessment.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Operational Profile Form */}
      <form onSubmit={saveProfileAndApprove} className="biz-card">
        <div className="biz-card-head">
          <div className="biz-card-title">
            <Building2 size={16} strokeWidth={1.85} aria-hidden="true" />
            <span>Business Operational Profile &amp; Classification</span>
          </div>
          <span className="biz-card-meta">
            Live preview: {previewClassification.tier} · Complexity{" "}
            {previewClassification.complexityScore}/100 · SLA{" "}
            {previewClassification.recommendedConfig.defaultSlaHours}h
          </span>
        </div>

        <div className="biz-form-grid">
          <label className="biz-field biz-field-wide">
            <span className="biz-field-label">Business model</span>
            <select
              disabled={!canEdit}
              value={draftProfile.businessModel}
              onChange={(e) =>
                setDraftProfile((prev) => ({
                  ...prev,
                  businessModel: e.target.value as BusinessArchetype,
                  operatesInternationally:
                    e.target.value === "INTERNATIONAL_FREIGHT"
                      ? true
                      : prev.operatesInternationally,
                  requiresCustomsClearance:
                    e.target.value === "INTERNATIONAL_FREIGHT"
                      ? true
                      : prev.requiresCustomsClearance,
                  managesThirdPartyClients:
                    e.target.value === "THIRD_PARTY_LOGISTICS"
                      ? true
                      : prev.managesThirdPartyClients,
                }))
              }
              className="biz-select"
            >
              {ARCHETYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="biz-field">
            <span className="biz-field-label">Employees</span>
            <input
              type="number"
              min={1}
              max={250000}
              disabled={!canEdit}
              value={draftProfile.employeeCount}
              onChange={(e) =>
                setDraftProfile((prev) => ({
                  ...prev,
                  employeeCount: Math.max(0, Number(e.target.value) || 0),
                }))
              }
              className="biz-input"
            />
          </label>

          <label className="biz-field">
            <span className="biz-field-label">Fleet vehicles</span>
            <input
              type="number"
              min={0}
              max={100000}
              disabled={!canEdit}
              value={draftProfile.vehicleCount}
              onChange={(e) =>
                setDraftProfile((prev) => ({
                  ...prev,
                  vehicleCount: Math.max(0, Number(e.target.value) || 0),
                }))
              }
              className="biz-input"
            />
          </label>

          <label className="biz-field">
            <span className="biz-field-label">Warehouses</span>
            <input
              type="number"
              min={0}
              max={5000}
              disabled={!canEdit}
              value={draftProfile.warehouseCount}
              onChange={(e) =>
                setDraftProfile((prev) => ({
                  ...prev,
                  warehouseCount: Math.max(0, Number(e.target.value) || 0),
                }))
              }
              className="biz-input"
            />
          </label>

          <label className="biz-field">
            <span className="biz-field-label">Branches</span>
            <input
              type="number"
              min={1}
              max={5000}
              disabled={!canEdit}
              value={draftProfile.branchCount}
              onChange={(e) =>
                setDraftProfile((prev) => ({
                  ...prev,
                  branchCount: Math.max(1, Number(e.target.value) || 1),
                }))
              }
              className="biz-input"
            />
          </label>

          <label className="biz-field">
            <span className="biz-field-label">Monthly shipments</span>
            <input
              type="number"
              min={0}
              max={50000000}
              disabled={!canEdit}
              value={draftProfile.monthlyShipments}
              onChange={(e) =>
                setDraftProfile((prev) => ({
                  ...prev,
                  monthlyShipments: Math.max(0, Number(e.target.value) || 0),
                }))
              }
              className="biz-input"
            />
          </label>

          <label className="biz-field">
            <span className="biz-field-label">Active carriers</span>
            <input
              type="number"
              min={0}
              max={50000}
              disabled={!canEdit}
              value={draftProfile.carrierCount}
              onChange={(e) =>
                setDraftProfile((prev) => ({
                  ...prev,
                  carrierCount: Math.max(0, Number(e.target.value) || 0),
                }))
              }
              className="biz-input"
            />
          </label>
        </div>

        <div className="biz-check-grid">
          <div className="biz-check-group">
            <span className="biz-field-label">Transport modes</span>
            <div className="biz-check-row">
              {TRANSPORT_MODES.map((m) => {
                const checked = draftProfile.transportModes.includes(m.value);
                return (
                  <label key={m.value} className="biz-check-pill">
                    <input
                      type="checkbox"
                      disabled={!canEdit}
                      checked={checked}
                      onChange={() => toggleMode(m.value)}
                    />
                    <span>{m.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="biz-check-group">
            <span className="biz-field-label">Operational capabilities</span>
            <div className="biz-check-row">
              <label className="biz-check-inline">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={draftProfile.operatesInternationally}
                  onChange={(e) =>
                    setDraftProfile((prev) => ({
                      ...prev,
                      operatesInternationally: e.target.checked,
                    }))
                  }
                />
                <span>International lanes</span>
              </label>

              <label className="biz-check-inline">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={draftProfile.requiresCustomsClearance}
                  onChange={(e) =>
                    setDraftProfile((prev) => ({
                      ...prev,
                      requiresCustomsClearance: e.target.checked,
                    }))
                  }
                />
                <span>Customs clearance</span>
              </label>

              <label className="biz-check-inline">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={draftProfile.managesThirdPartyClients}
                  onChange={(e) =>
                    setDraftProfile((prev) => ({
                      ...prev,
                      managesThirdPartyClients: e.target.checked,
                    }))
                  }
                />
                <span>Multi-client 3PL operations</span>
              </label>
            </div>
          </div>
        </div>

        <div className="biz-form-foot">
          <div className="biz-rationale">
            {previewClassification.rationale[0]}
          </div>
          {canEdit ? (
            <button type="submit" disabled={saving} className="biz-btn-primary">
              <CheckCircle2 size={14} strokeWidth={2} aria-hidden="true" />
              <span>{saving ? "Saving..." : "Save & Approve Configuration"}</span>
            </button>
          ) : null}
        </div>
      </form>

      {/* Independent Feature Entitlements Matrix */}
      <div className="biz-card">
        <div className="biz-card-head">
          <div className="biz-card-title">
            <SlidersHorizontal size={16} strokeWidth={1.85} aria-hidden="true" />
            <span>Independent Feature Entitlements</span>
          </div>
          <span className="biz-card-hint">
            Toggles operate independently of business tier · Sidebar adapts automatically
          </span>
        </div>

        <div className="scroller" tabIndex={0} role="region" aria-label="Feature entitlements">
          <table>
            <thead>
              <tr>
                <th scope="col">Feature</th>
                <th scope="col">Capability</th>
                <th scope="col">Source</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {FEATURE_KEYS.map((key) => {
                const def = FEATURE_CATALOG[key];
                const ent = configuration.entitlements[key];
                const enabled = Boolean(ent?.enabled);
                const busy = togglingKey === key;
                return (
                  <tr key={key}>
                    <td className="biz-feature-name">{def.label}</td>
                    <td className="text-muted">{def.description}</td>
                    <td className="biz-feature-source">
                      {def.coreRequired
                        ? "CORE"
                        : ent?.source === "ADMIN_OVERRIDE"
                          ? "ADMIN OVERRIDE"
                          : "RECOMMENDED"}
                    </td>
                    <td>
                      {def.coreRequired ? (
                        <span className="biz-core-badge">
                          <ShieldCheck size={14} strokeWidth={2} aria-hidden="true" />
                          <span>Required</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={enabled}
                          aria-label={`Toggle ${def.label}`}
                          disabled={!canEdit || busy}
                          onClick={() => handleToggleFeature(key)}
                          className="biz-switch"
                        >
                          {busy ? "Updating..." : enabled ? "Enabled" : "Disabled"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Growth & Classification History */}
      {configuration.growthHistory.length > 0 ? (
        <div className="biz-card">
          <div className="biz-history-head">
            <Layers size={14} strokeWidth={2} aria-hidden="true" />
            <span>Classification &amp; Growth Reassessment History</span>
          </div>
          <ul className="biz-history-list">
            {configuration.growthHistory.slice(0, 5).map((entry, idx) => (
              <li key={`${entry.timestamp}-${idx}`} className="biz-history-item">
                <span>
                  <strong className="biz-history-tier">
                    {entry.fromTier} → {entry.toTier}
                  </strong>{" "}
                  · {entry.note}
                </span>
                <span className="biz-history-actor">{entry.actor}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
