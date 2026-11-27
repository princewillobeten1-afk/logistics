"use client";

import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface AgentDiagnosticRow {
  id: string;
  name: string;
  domain: string;
  thinkingDepth: string;
  workflows: string[];
  status: "READY" | "DEGRADED" | "ERROR" | "KEY_REQUIRED";
  contextOk: boolean;
  contextKeys: number;
  contextError: string | null;
  runs24h: number;
  failures24h: number;
  avgLatencyMs: number | null;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastError: string | null;
}

interface HealthResponse {
  checkedAt: string;
  geminiConfigured: boolean;
  primaryModel: string;
  fallbackModel: string;
  summary: {
    totalAgents: number;
    contextHealthy: number;
    contextErrors: number;
    degraded24h: number;
    mappedWorkflows: number;
  };
  agents: AgentDiagnosticRow[];
  error?: string;
}

interface SweepResponse {
  scope: string;
  executed?: Array<{
    workflow: string;
    agentId: string;
    summary: string;
    latencyMs: number;
  }>;
  failed?: Array<{ workflow: string; error: string }>;
  skippedReason?: string;
  error?: string;
}

const SWEEP_SCOPES = [
  { id: "fleet", label: "Fleet & HOS sweep" },
  { id: "exceptions", label: "Exceptions sweep" },
  { id: "supply", label: "Supply & quotes sweep" },
  { id: "finance", label: "Finance & audit sweep" },
  { id: "customer", label: "Customer comms sweep" },
] as const;

function statusTone(status: AgentDiagnosticRow["status"]): string {
  if (status === "READY") return "ok";
  if (status === "ERROR") return "crit";
  if (status === "DEGRADED" || status === "KEY_REQUIRED") return "warn";
  return "neutral";
}

function statusLabel(status: AgentDiagnosticRow["status"]): string {
  if (status === "READY") return "Ready";
  if (status === "KEY_REQUIRED") return "Key required";
  if (status === "DEGRADED") return "Degraded";
  return "Context error";
}

export function AgentDiagnosticsPanel() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const [sweepingScope, setSweepingScope] = useState<string | null>(null);
  const [sweepNote, setSweepNote] = useState<string | null>(null);
  const [sweepError, setSweepError] = useState<string | null>(null);

  const loadHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/health", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as HealthResponse;
      if (!res.ok) {
        throw new Error(json.error || "Could not load agent diagnostics.");
      }
      setData(json);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not check agent health.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  async function runSweep(scope: string) {
    setSweepingScope(scope);
    setSweepNote(null);
    setSweepError(null);
    try {
      const res = await fetch("/api/agents/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      const json = (await res.json().catch(() => ({}))) as SweepResponse;
      if (!res.ok) {
        throw new Error(json.error || "Sweep failed.");
      }
      if (json.skippedReason) {
        setSweepError(json.skippedReason);
      } else {
        const okCount = json.executed?.length ?? 0;
        const failCount = json.failed?.length ?? 0;
        setSweepNote(
          `Completed ${scope} sweep: ${okCount} workflow${okCount === 1 ? "" : "s"} succeeded${failCount > 0 ? `, ${failCount} failed` : ""}.`,
        );
      }
      await loadHealth();
    } catch (err) {
      setSweepError(err instanceof Error ? err.message : "Sweep request failed.");
    } finally {
      setSweepingScope(null);
    }
  }

  return (
    <section className="panel" aria-label="15-Agent Fleet Health and Sweeps">
      <header>
        <div>
          <h2>Agent Fleet Health &amp; Sweeps</h2>
          <span className="hint">
            Live context verification across all 15 specialist agents and
            on-demand operational sweeps
          </span>
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="btn-ghost-sm"
            onClick={() => setExpanded((v) => !v)}
          >
            <Activity size={13} strokeWidth={2} aria-hidden="true" />
            <span>{expanded ? "Hide 15-agent matrix" : "Inspect all 15 agents"}</span>
          </button>
          <button
            type="button"
            className="panel-refresh-btn"
            onClick={() => void loadHealth()}
            disabled={loading}
          >
            <RefreshCw
              size={13}
              strokeWidth={2}
              className={loading ? "spin" : undefined}
              aria-hidden="true"
            />
            <span>{loading ? "Checking…" : "Re-check"}</span>
          </button>
        </div>
      </header>

      <div className="body stack-md">
        {error ? (
          <div className="panel-inline-error" role="alert">
            <AlertCircle size={14} strokeWidth={2} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        {data ? (
          <dl className="fleet-readiness-strip">
            <div>
              <dt>Context checks passing</dt>
              <dd className="num">
                {data.summary.contextHealthy} / {data.summary.totalAgents}
              </dd>
            </div>
            <div>
              <dt>Mapped workflows</dt>
              <dd className="num">{data.summary.mappedWorkflows}</dd>
            </div>
            <div>
              <dt>Degraded (24h)</dt>
              <dd
                className={`num${data.summary.degraded24h > 0 ? " text-warn" : ""}`}
              >
                {data.summary.degraded24h}
              </dd>
            </div>
            <div>
              <dt>AI Engine</dt>
              <dd className="num">
                {data.geminiConfigured ? (
                  <span className="fleet-compliance-ok">
                    <ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />
                    <span>Configured</span>
                  </span>
                ) : (
                  <span className="fleet-compliance-block">
                    <ShieldAlert size={13} strokeWidth={2} aria-hidden="true" />
                    <span>Key not set</span>
                  </span>
                )}
              </dd>
            </div>
          </dl>
        ) : loading ? (
          <div className="text-sm text-faint row-center">
            <Loader2 size={14} className="spin" aria-hidden="true" />
            <span>Verifying all 15 specialist agents…</span>
          </div>
        ) : null}

        <div className="agent-sweep-bar">
          <span className="font-mono text-xs text-faint">Run sweep:</span>
          {SWEEP_SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              className="btn-ghost-sm"
              disabled={sweepingScope !== null || !data?.geminiConfigured}
              onClick={() => void runSweep(s.id)}
            >
              {sweepingScope === s.id ? (
                <Loader2 size={12} className="spin" aria-hidden="true" />
              ) : (
                <Play size={12} strokeWidth={2} aria-hidden="true" />
              )}
              <span>{s.label}</span>
            </button>
          ))}
        </div>

        {sweepError ? (
          <div className="panel-inline-error" role="alert">
            <AlertCircle size={14} strokeWidth={2} aria-hidden="true" />
            <span>{sweepError}</span>
          </div>
        ) : null}

        {sweepNote ? (
          <div className="banner" data-tone="ok" style={{ marginBottom: 0 }}>
            <CheckCircle2
              size={14}
              strokeWidth={2}
              style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }}
              aria-hidden="true"
            />
            {sweepNote}
          </div>
        ) : null}

        {expanded && data ? (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="15-Agent diagnostics matrix"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Domain</th>
                  <th scope="col">Status</th>
                  <th scope="col">Context data</th>
                  <th scope="col">24h runs</th>
                  <th scope="col">Failures</th>
                  <th scope="col">Avg latency</th>
                </tr>
              </thead>
              <tbody>
                {data.agents.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="font-semibold">{a.name}</div>
                      <div className="font-mono text-xs text-faint">
                        {a.workflows.join(", ") || a.id}
                      </div>
                    </td>
                    <td className="text-muted">{a.domain}</td>
                    <td>
                      <span
                        className="status-tag"
                        data-tone={statusTone(a.status)}
                      >
                        {statusLabel(a.status)}
                      </span>
                    </td>
                    <td className="num text-xs">
                      {a.contextOk ? (
                        <span>{a.contextKeys} signals</span>
                      ) : (
                        <span className="text-crit">
                          {a.contextError ?? "Error"}
                        </span>
                      )}
                    </td>
                    <td className="num">{a.runs24h}</td>
                    <td
                      className={`num${a.failures24h > 0 ? " text-crit font-semibold" : ""}`}
                    >
                      {a.failures24h}
                    </td>
                    <td className="num text-faint">
                      {a.avgLatencyMs !== null ? `${a.avgLatencyMs} ms` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
