import { NextResponse } from "next/server";
import {
  BACKEND_WORKFLOW_AGENT_MAP,
  CORE_AGENTS,
  type BackendWorkflow,
} from "@/lib/agents/catalog";
import { gatherOperationalContext } from "@/lib/agents/context";
import {
  AGENT_GEMINI_FALLBACK_MODEL,
  AGENT_GEMINI_MODEL,
  getServerGeminiKey,
} from "@/lib/agents/gemini-client";
import { currentUser } from "@/lib/auth";
import { runWithOrgScope } from "@/lib/db";
import { computeLogisticsReadiness } from "@/lib/driver-dispatch";
import {
  listDocuments,
  listDrivers,
  listShipments,
  recentAgentRuns,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  try {
    return await runWithOrgScope(user.orgId, async () => {
      const geminiConfigured = Boolean(getServerGeminiKey());

      const [runs, drivers, shipments, documents] = await Promise.all([
        recentAgentRuns(60),
        listDrivers(),
        listShipments(),
        listDocuments(),
      ]);

      const workflowsByAgent = new Map<string, BackendWorkflow[]>();
      for (const [wf, agentId] of Object.entries(BACKEND_WORKFLOW_AGENT_MAP) as [
        BackendWorkflow,
        string,
      ][]) {
        const list = workflowsByAgent.get(agentId) ?? [];
        list.push(wf);
        workflowsByAgent.set(agentId, list);
      }

      const nowMs = Date.now();
      const dayAgoMs = nowMs - 86_400_000;

      const agentChecks = await Promise.all(
        CORE_AGENTS.map(async (agent) => {
          let contextOk = true;
          let contextError: string | null = null;
          let contextKeys = 0;

          try {
            const ctx = await gatherOperationalContext(agent.id);
            contextKeys = Object.keys(ctx.snapshot).length;
          } catch (err) {
            contextOk = false;
            contextError =
              err instanceof Error
                ? err.message
                : "Failed to gather operational context.";
          }

          const agentRuns = runs.filter(
            (r) =>
              r.agent === agent.id ||
              r.job === `agent.${agent.id}` ||
              r.job === agent.id ||
              (agent.id === "fleet-management" && r.job === "fleet_optimization"),
          );
          const recent24h = agentRuns.filter(
            (r) => new Date(r.created_at).getTime() >= dayAgoMs,
          );
          const isRunOk = (status: string) =>
            status.toUpperCase() === "OK" || status.toUpperCase() === "SUCCEEDED";
          const failures24h = recent24h.filter((r) => !isRunOk(r.status)).length;
          const latencies = recent24h
            .map((r) => r.latency_ms)
            .filter((v): v is number => typeof v === "number" && v > 0);
          const avgLatencyMs =
            latencies.length > 0
              ? Math.round(
                  latencies.reduce((sum, n) => sum + n, 0) / latencies.length,
                )
              : null;

          const lastRun = agentRuns[0] ?? null;
          const lastRunOk = lastRun ? isRunOk(lastRun.status) : null;

          let status: "READY" | "DEGRADED" | "ERROR" | "KEY_REQUIRED" = "READY";
          if (!contextOk) {
            status = "ERROR";
          } else if (!geminiConfigured) {
            status = "KEY_REQUIRED";
          } else if (failures24h > 0 && lastRun && !lastRunOk) {
            status = "DEGRADED";
          }

          return {
            id: agent.id,
            name: agent.name,
            domain: agent.domainId,
            thinkingDepth: agent.thinkingDepth,
            workflows: workflowsByAgent.get(agent.id) ?? [],
            status,
            contextOk,
            contextKeys,
            contextError,
            runs24h: recent24h.length,
            failures24h,
            avgLatencyMs,
            lastRunAt: lastRun
              ? new Date(lastRun.created_at).toISOString()
              : null,
            lastRunOk,
            lastError:
              lastRun && !lastRunOk
                ? (lastRun.response?.reasoning ?? lastRun.status)
                : null,
          };
        }),
      );

      const readiness = computeLogisticsReadiness({
        drivers,
        shipments,
        documents,
      });

      const healthyCount = agentChecks.filter((a) => a.contextOk).length;
      const errorCount = agentChecks.filter((a) => !a.contextOk).length;
      const degradedCount = agentChecks.filter(
        (a) => a.status === "DEGRADED",
      ).length;

      return NextResponse.json(
        {
          checkedAt: new Date().toISOString(),
          geminiConfigured,
          primaryModel: AGENT_GEMINI_MODEL,
          fallbackModel: AGENT_GEMINI_FALLBACK_MODEL,
          summary: {
            totalAgents: agentChecks.length,
            contextHealthy: healthyCount,
            contextErrors: errorCount,
            degraded24h: degradedCount,
            mappedWorkflows: Object.keys(BACKEND_WORKFLOW_AGENT_MAP).length,
          },
          agents: agentChecks,
          readiness,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Could not execute agent diagnostics.",
      },
      { status: 500 },
    );
  }
}
