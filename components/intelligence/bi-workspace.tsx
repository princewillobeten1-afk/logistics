"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Calendar,
  Download,
  Info,
  Lock,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { ClientWhen } from "@/components/client-time";
import { BiAlertsPanel } from "@/components/intelligence/bi-alerts-panel";
import { ProvenanceTag } from "@/components/intelligence/bi-charts";
import { BiComparisonsPanel } from "@/components/intelligence/bi-comparisons-panel";
import { BiNlqWorkspace } from "@/components/intelligence/bi-nlq-workspace";
import { BiPredictiveForecastPanel } from "@/components/intelligence/bi-predictive-forecast-panel";
import type {
  BiDepartmentId,
  BiPeriodDays,
  BiSnapshot,
} from "@/lib/intelligence/types";

const PERIOD_OPTIONS: { days: BiPeriodDays; label: string }[] = [
  { days: 7, label: "7D vs prior 7D" },
  { days: 14, label: "14D vs prior 14D" },
  { days: 30, label: "30D vs prior 30D" },
];

export function BiWorkspace({ initialSnapshot }: { initialSnapshot: BiSnapshot }) {
  const [snapshot, setSnapshot] = useState<BiSnapshot>(initialSnapshot);
  const [periodDays, setPeriodDays] = useState<BiPeriodDays>(initialSnapshot.periodDays);
  const [refreshing, setRefreshing] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [departmentFilter, setDepartmentFilter] = useState<BiDepartmentId | null>(null);
  const [queuedQuestion, setQueuedQuestion] = useState<string | null>(null);
  const [expandedKpiFormula, setExpandedKpiFormula] = useState<string | null>(null);

  const loadSnapshot = async (nextPeriod: BiPeriodDays) => {
    setRefreshing(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/intelligence/summary?period=${nextPeriod}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as BiSnapshot & { error?: string };
      if (!res.ok) {
        setStatusError(data.error ?? "Failed to refresh Business Intelligence snapshot.");
        return;
      }
      setSnapshot(data);
      setPeriodDays(nextPeriod);
    } catch {
      setStatusError("Network error while refreshing Business Intelligence metrics.");
    } finally {
      setRefreshing(false);
    }
  };

  const handleToggleAlertAck = async (alertId: string, nextAck: boolean) => {
    const res = await fetch("/api/intelligence/alerts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "ControlTowerBI",
      },
      body: JSON.stringify({
        alertId,
        action: nextAck ? "acknowledge" : "reopen",
      }),
    });

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      setStatusError(errBody.error ?? "Unable to update alert status.");
      return;
    }

    setSnapshot((prev) => ({
      ...prev,
      proactiveAlerts: prev.proactiveAlerts.map((a) =>
        a.id === alertId ? { ...a, acknowledged: nextAck } : a,
      ),
    }));
  };

  const handleAskQuestion = (questionText: string) => {
    setQueuedQuestion(questionText);
    const target = document.getElementById("bi-ai-analyst");
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const exportExecutiveReportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      orgName: snapshot.orgName,
      roleScope: snapshot.roleScope.scopeLabel,
      period: `${snapshot.periodLabel} (${snapshot.comparisonLabel})`,
      executiveKpis: snapshot.executiveKpis,
      departments: snapshot.departments,
      proactiveAlerts: snapshot.proactiveAlerts,
      forecastSummary: snapshot.forecastSummary,
      forecast30d: snapshot.forecast30d,
      comparisons: snapshot.comparisons,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${snapshot.orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-executive-bi-${periodDays}d.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bi-shell">
      {/* Executive Header & Period/Access Controls */}
      <header className="bi-header">
        <div className="bi-header-copy">
          <div className="bi-eyebrow-row">
            <span className="bi-eyebrow">Executive Intelligence · 9 Departments</span>
            <span className="bi-role-chip">
              <ShieldCheck size={13} aria-hidden="true" />
              <span>
                {snapshot.roleScope.role} · {snapshot.roleScope.scopeLabel}
              </span>
            </span>
          </div>
          <h1>AI Business Intelligence</h1>
          <p>
            Real-time cross-departmental analytics, proactive anomaly detection, predictive
            forecasts, and natural-language inquiry grounded exclusively in live{" "}
            <strong>{snapshot.orgName}</strong> operational and financial data.
          </p>
        </div>

        <div className="bi-header-controls">
          <div className="bi-period-group" role="group" aria-label="Comparison time window">
            <Calendar size={14} className="bi-period-icon" aria-hidden="true" />
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                className={`bi-seg-btn${periodDays === opt.days ? " is-active" : ""}`}
                disabled={refreshing}
                onClick={() => void loadSnapshot(opt.days)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="bi-header-actions">
            <button
              type="button"
              className="bi-btn-outline"
              disabled={refreshing}
              onClick={() => void loadSnapshot(periodDays)}
            >
              <RefreshCw
                size={14}
                className={refreshing ? "bi-spin" : undefined}
                aria-hidden="true"
              />
              <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
            </button>
            <button
              type="button"
              className="bi-btn-outline"
              onClick={exportExecutiveReportJson}
            >
              <Download size={14} aria-hidden="true" />
              <span>Export Report</span>
            </button>
          </div>
        </div>
      </header>

      {statusError ? (
        <div className="bi-error-banner" role="alert">
          <Info size={16} aria-hidden="true" />
          <span>{statusError}</span>
        </div>
      ) : null}

      {snapshot.roleScope.redactionNotes.length > 0 ? (
        <div className="bi-rbac-banner">
          <Lock size={15} aria-hidden="true" />
          <div>
            <strong>Role-based access controls active ({snapshot.roleScope.role}):</strong>{" "}
            {snapshot.roleScope.redactionNotes.join(" ")}
          </div>
        </div>
      ) : null}

      {/* 1. PROACTIVE ALERTS FIRST — Management sees critical shifts immediately */}
      <BiAlertsPanel
        alerts={snapshot.proactiveAlerts}
        canAcknowledge={snapshot.roleScope.canAcknowledgeAlerts}
        departmentFilter={departmentFilter}
        onClearDepartmentFilter={() => setDepartmentFilter(null)}
        onToggleAcknowledge={handleToggleAlertAck}
        onAskAboutAlert={handleAskQuestion}
      />

      {/* 2. EXECUTIVE KPI STRIP WITH TRANSPARENT PROVENANCE & FORMULAS */}
      <section aria-label="Executive performance indicators" className="bi-kpi-grid">
        {snapshot.executiveKpis.map((kpi) => {
          const isPositiveTrend =
            kpi.deltaPct !== null
              ? kpi.higherIsBetter
                ? kpi.deltaPct >= 0
                : kpi.deltaPct <= 0
              : null;
          const formulaShown = expandedKpiFormula === kpi.id;

          return (
            <article key={kpi.id} className="bi-kpi-card">
              <div className="bi-kpi-top">
                <span className="bi-kpi-label">{kpi.label}</span>
                <ProvenanceTag provenance={kpi.provenance} />
              </div>

              <div className="bi-kpi-val-row">
                <strong className={`bi-kpi-val${kpi.redacted ? " is-redacted" : ""}`}>
                  {kpi.valueFormatted}
                </strong>
                {kpi.deltaPct !== null ? (
                  <span
                    className={`bi-kpi-delta ${
                      isPositiveTrend ? "is-good" : "is-bad"
                    }`}
                  >
                    {kpi.deltaPct >= 0 ? (
                      <ArrowUpRight size={13} aria-hidden="true" />
                    ) : (
                      <ArrowDownRight size={13} aria-hidden="true" />
                    )}
                    {kpi.deltaPct >= 0 ? "+" : ""}
                    {kpi.deltaPct.toFixed(1)}%
                  </span>
                ) : null}
              </div>

              <div className="bi-kpi-foot">
                <span className="bi-kpi-prior">
                  {kpi.priorValueFormatted
                    ? `Prior ${periodDays}d: ${kpi.priorValueFormatted}`
                    : `${snapshot.comparisonLabel}`}
                </span>
                <button
                  type="button"
                  className="bi-formula-toggle"
                  onClick={() =>
                    setExpandedKpiFormula(formulaShown ? null : kpi.id)
                  }
                >
                  {formulaShown ? "Hide" : "Formula"}
                </button>
              </div>

              {formulaShown ? (
                <p className="bi-kpi-formula">{kpi.formula}</p>
              ) : null}
            </article>
          );
        })}
      </section>

      {/* 3. NATURAL-LANGUAGE AI BUSINESS ANALYST */}
      <BiNlqWorkspace
        periodDays={periodDays}
        queuedQuestion={queuedQuestion}
        onClearQueuedQuestion={() => setQueuedQuestion(null)}
      />

      {/* 4. 30-DAY PREDICTIVE FORECAST (RECHARTS VOLUME & CARRIER COST) */}
      <BiPredictiveForecastPanel
        forecast={snapshot.forecast30d}
        currency={snapshot.currency}
        orgName={snapshot.orgName}
        onAskAiForecast={handleAskQuestion}
      />

      {/* 5. ALL 9 DEPARTMENTS LIVE HEALTH MATRIX */}
      <section className="bi-panel" aria-labelledby="bi-depts-heading">
        <div className="bi-panel-head">
          <div className="bi-panel-title-group">
            <h2 id="bi-depts-heading">All 9 Departments Intelligence Matrix</h2>
            <p className="bi-panel-sub">
              Automated live telemetry spanning Finance, Operations, Fleet, Shipments, Dispatch,
              Warehousing, Sales, Customers, and Human Resources.
            </p>
          </div>
          <span className="bi-record-summary">
            {snapshot.recordCounts.shipments} shipments · {snapshot.recordCounts.orders} orders ·{" "}
            {snapshot.recordCounts.vehicles} vehicles · {snapshot.recordCounts.drivers} drivers ·{" "}
            {snapshot.recordCounts.warehouses} hubs · {snapshot.recordCounts.customers} accounts
          </span>
        </div>

        <div className="bi-dept-grid">
          {snapshot.departments.map((dept) => {
            const stClass = `bi-status-${dept.status.toLowerCase()}`;
            return (
              <article key={dept.id} className="bi-dept-card">
                <div className="bi-dept-head">
                  <div>
                    <h3>{dept.name}</h3>
                    <span className={`bi-status-dot ${stClass}`}>
                      {dept.status === "NO_DATA"
                        ? "NO DATA"
                        : `${dept.status.replace("_", " ")} · ${dept.healthScore}/100`}
                    </span>
                  </div>
                  <ProvenanceTag provenance={dept.provenance} />
                </div>

                <div className="bi-dept-headline">
                  <span className="bi-dept-hl-label">{dept.headlineLabel}</span>
                  <strong className="bi-dept-hl-val">{dept.headlineValue}</strong>
                </div>

                <dl className="bi-dept-metrics">
                  {dept.metrics.map((m) => (
                    <div key={m.label} className="bi-dept-metric-row">
                      <dt>{m.label}</dt>
                      <dd>{m.value}</dd>
                    </div>
                  ))}
                </dl>

                <p className="bi-dept-summary">{dept.summary}</p>

                <div className="bi-dept-foot">
                  <button
                    type="button"
                    className="bi-btn-ghost"
                    onClick={() =>
                      handleAskQuestion(
                        `Deep-dive into ${dept.name} performance: explain current metrics, anomalies, and top 3 actions to improve results.`,
                      )
                    }
                  >
                    <Sparkles size={13} aria-hidden="true" />
                    <span>Ask AI</span>
                  </button>

                  {dept.alertCount > 0 ? (
                    <button
                      type="button"
                      className="bi-alert-pill-btn"
                      onClick={() => {
                        setDepartmentFilter(dept.id);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    >
                      {dept.alertCount} alert{dept.alertCount === 1 ? "" : "s"}
                    </button>
                  ) : null}

                  <Link href={dept.deepLink} className="bi-inline-link">
                    <span>Open</span>
                    <ArrowUpRight size={13} aria-hidden="true" />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* 6. MULTI-DIMENSIONAL COMPARISONS (DEPARTMENTS, BRANCHES, VEHICLES, ROUTES, CUSTOMERS) */}
      <BiComparisonsPanel
        comparisons={snapshot.comparisons}
        periodLabel={snapshot.periodLabel}
        orgName={snapshot.orgName}
      />

      {/* 7. DATA TRUTHFULNESS & PROVENANCE DISCLOSURE */}
      <section className="bi-panel bi-methodology-panel" aria-labelledby="bi-method-heading">
        <div className="bi-panel-head">
          <div className="bi-panel-title-group">
            <h2 id="bi-method-heading">Data Provenance & Calculation Transparency</h2>
            <p className="bi-panel-sub">
              Every insight distinguishes verified company database records from transparently
              modeled estimates and statistical forecasts.
            </p>
          </div>
          <span className="bi-timestamp">
            Computed <ClientWhen date={snapshot.generatedAt} />
          </span>
        </div>

        <div className="bi-method-grid">
          {snapshot.methodologyNotes.map((note) => (
            <div key={note.provenance} className="bi-method-card">
              <ProvenanceTag provenance={note.provenance} />
              <h3>{note.title}</h3>
              <p>{note.description}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
