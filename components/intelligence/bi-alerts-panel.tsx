"use client";

import Link from "next/link";
import { useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Info,
  RotateCcw,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { ProvenanceTag } from "@/components/intelligence/bi-charts";
import type {
  AlertSeverity,
  BiDepartmentId,
  ProactiveAlert,
} from "@/lib/intelligence/types";

type SeverityFilter = "ALL" | AlertSeverity;

function SeverityIcon({ severity }: { severity: AlertSeverity }) {
  if (severity === "CRITICAL") {
    return <AlertOctagon size={16} strokeWidth={2} aria-hidden="true" />;
  }
  if (severity === "HIGH") {
    return <AlertTriangle size={16} strokeWidth={2} aria-hidden="true" />;
  }
  if (severity === "OPPORTUNITY") {
    return <TrendingUp size={16} strokeWidth={2} aria-hidden="true" />;
  }
  return <Info size={16} strokeWidth={2} aria-hidden="true" />;
}

export function BiAlertsPanel({
  alerts,
  canAcknowledge,
  departmentFilter,
  onClearDepartmentFilter,
  onToggleAcknowledge,
  onAskAboutAlert,
}: {
  alerts: ProactiveAlert[];
  canAcknowledge: boolean;
  departmentFilter: BiDepartmentId | null;
  onClearDepartmentFilter: () => void;
  onToggleAcknowledge: (alertId: string, nextAck: boolean) => Promise<void>;
  onAskAboutAlert: (question: string) => void;
}) {
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("ALL");
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [expandedFormulaId, setExpandedFormulaId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const activeCount = alerts.filter((a) => !a.acknowledged).length;
  const criticalCount = alerts.filter(
    (a) => !a.acknowledged && (a.severity === "CRITICAL" || a.severity === "HIGH"),
  ).length;
  const ackedCount = alerts.length - activeCount;

  const filtered = alerts.filter((a) => {
    if (!showAcknowledged && a.acknowledged) return false;
    if (departmentFilter && a.department !== departmentFilter) return false;
    if (severityFilter !== "ALL" && a.severity !== severityFilter) return false;
    return true;
  });

  const handleAck = async (alert: ProactiveAlert) => {
    if (!canAcknowledge || busyId) return;
    setBusyId(alert.id);
    try {
      await onToggleAcknowledge(alert.id, !alert.acknowledged);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="bi-panel bi-alerts-section" aria-labelledby="bi-alerts-heading">
      <div className="bi-panel-head">
        <div className="bi-panel-title-group">
          <div className="bi-title-with-icon">
            <BellRing size={17} strokeWidth={2} className="bi-title-icon" aria-hidden="true" />
            <h2 id="bi-alerts-heading">Proactive Executive Alerts</h2>
          </div>
          <p className="bi-panel-sub">
            Automatically detected across all 9 departments — surfacing cost spikes, revenue dips,
            delays, branch strain, and compliance risks before management has to ask.
          </p>
        </div>

        <div className="bi-alerts-counters">
          <span className="bi-counter-chip bi-counter-urgent">
            {criticalCount} urgent
          </span>
          <span className="bi-counter-chip">{activeCount} open</span>
          {ackedCount > 0 ? (
            <button
              type="button"
              className="bi-text-btn"
              onClick={() => setShowAcknowledged((v) => !v)}
            >
              {showAcknowledged ? "Hide acknowledged" : `Show ${ackedCount} acknowledged`}
            </button>
          ) : null}
        </div>
      </div>

      <div className="bi-alerts-filters">
        <div className="bi-seg-tabs" role="tablist" aria-label="Filter proactive alerts by severity">
          {(["ALL", "CRITICAL", "HIGH", "MEDIUM", "OPPORTUNITY"] as SeverityFilter[]).map(
            (sev) => (
              <button
                key={sev}
                type="button"
                role="tab"
                aria-selected={severityFilter === sev}
                className={`bi-seg-btn${severityFilter === sev ? " is-active" : ""}`}
                onClick={() => setSeverityFilter(sev)}
              >
                {sev === "ALL" ? "All signals" : sev.charAt(0) + sev.slice(1).toLowerCase()}
              </button>
            ),
          )}
        </div>

        {departmentFilter ? (
          <button
            type="button"
            className="bi-filter-clear"
            onClick={onClearDepartmentFilter}
          >
            Department: {departmentFilter} ×
          </button>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <div className="bi-empty-alerts">
          <CheckCircle2 size={20} strokeWidth={1.75} aria-hidden="true" />
          <div>
            <strong>No active alerts match the current filter</strong>
            <p>
              All monitored financial, operational, branch, fleet, and HR thresholds are inside
              healthy operating guardrails.
            </p>
          </div>
        </div>
      ) : (
        <div className={`bi-alert-list${filtered.length === 1 ? " is-single" : ""}`}>
          {filtered.map((alert) => {
            const sevClass = `bi-sev-${alert.severity.toLowerCase()}`;
            const formulaOpen = expandedFormulaId === alert.id;
            return (
              <article
                key={alert.id}
                className={`bi-alert-card ${sevClass}${alert.acknowledged ? " is-acked" : ""}`}
              >
                <div className="bi-alert-top">
                  <div className="bi-alert-meta">
                    <span className={`bi-sev-tag ${sevClass}`}>
                      <SeverityIcon severity={alert.severity} />
                      <span>{alert.severity}</span>
                    </span>
                    <span className="bi-dept-tag">{alert.departmentName}</span>
                    <ProvenanceTag provenance={alert.provenance} />
                    {alert.acknowledged ? (
                      <span className="bi-acked-label">Acknowledged</span>
                    ) : null}
                  </div>
                  <div className="bi-alert-numbers">
                    <span>
                      Observed: <strong>{alert.observedValue}</strong>
                    </span>
                    <span className="bi-muted-sep">vs</span>
                    <span>Baseline: {alert.baselineValue}</span>
                  </div>
                </div>

                <h3 className="bi-alert-title">{alert.title}</h3>
                <p className="bi-alert-summary">{alert.summary}</p>

                <div className="bi-alert-impact-row">
                  <span className="bi-impact-chip">
                    <strong>Impact:</strong> {alert.estimatedImpact}
                  </span>
                  <span className="bi-action-note">
                    <strong>Recommended:</strong> {alert.recommendedAction}
                  </span>
                </div>

                {formulaOpen ? (
                  <div className="bi-formula-box">
                    <strong>Calculation & provenance:</strong> {alert.formula}
                  </div>
                ) : null}

                <div className="bi-alert-actions">
                  <button
                    type="button"
                    className="bi-btn-ghost"
                    onClick={() =>
                      setExpandedFormulaId(formulaOpen ? null : alert.id)
                    }
                  >
                    {formulaOpen ? (
                      <ChevronUp size={14} aria-hidden="true" />
                    ) : (
                      <ChevronDown size={14} aria-hidden="true" />
                    )}
                    <span>{formulaOpen ? "Hide formula" : "How calculated"}</span>
                  </button>

                  <button
                    type="button"
                    className="bi-btn-ghost"
                    onClick={() =>
                      onAskAboutAlert(
                        `Analyze the ${alert.departmentName} alert "${alert.title}" and give a prioritized action plan based on our live data.`,
                      )
                    }
                  >
                    <Sparkles size={14} aria-hidden="true" />
                    <span>Investigate with AI</span>
                  </button>

                  <Link href={alert.deepLink} className="bi-btn-ghost">
                    <span>Open module</span>
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </Link>

                  <button
                    type="button"
                    className="bi-btn-outline"
                    disabled={!canAcknowledge || busyId === alert.id}
                    title={
                      canAcknowledge
                        ? alert.acknowledged
                          ? "Reopen this alert"
                          : "Acknowledge this alert"
                        : "Viewer role is read-only"
                    }
                    onClick={() => handleAck(alert)}
                  >
                    {alert.acknowledged ? (
                      <>
                        <RotateCcw size={13} aria-hidden="true" />
                        <span>{busyId === alert.id ? "Updating…" : "Reopen"}</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={13} aria-hidden="true" />
                        <span>{busyId === alert.id ? "Saving…" : "Acknowledge"}</span>
                      </>
                    )}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
