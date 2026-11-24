import {
  getAgentForBackendWorkflow,
  type BackendWorkflow,
  type CoreAgentId,
} from "./catalog";
import { getServerGeminiKey } from "./gemini-client";
import { executeAgentTask, type ExecuteAgentTaskOutput } from "./orchestrator";
import { query, runWithOrgScope } from "@/lib/db";

const globalForBg = globalThis as unknown as {
  agentBgCooldowns?: Map<string, { lastRunAt: number; inFlight?: Promise<unknown> }>;
};

const cooldownStore =
  globalForBg.agentBgCooldowns ??
  (globalForBg.agentBgCooldowns = new Map());

export interface BackgroundDispatchInput {
  workflow: BackendWorkflow;
  orgId: string | null;
  reference?: string;
  task?: string;
  actorEmail?: string | null;
  dedupeKey?: string;
  cooldownMs?: number;
  workKind?: string;
}

/**
 * Executes a single backend agent workflow inside the caller's tenant org scope
 * and records completion in `work_items` without exposing any UI surface.
 */
export async function runBackendAgentWorkflow({
  workflow,
  orgId,
  reference,
  task,
  actorEmail,
  workKind,
}: BackgroundDispatchInput): Promise<ExecuteAgentTaskOutput | null> {
  if (!getServerGeminiKey()) {
    return null;
  }

  const agent = getAgentForBackendWorkflow(workflow);
  const resolvedTask = task?.trim() || agent.quickPrompts[0];

  return runWithOrgScope(orgId, async () => {
    const out = await executeAgentTask({
      agentId: agent.id as CoreAgentId,
      task: resolvedTask,
      reference,
      actorEmail: actorEmail ?? "system@background",
    });

    if (workKind) {
      const dedupe = `bg:${workflow}:${reference ?? "all"}:${Math.floor(Date.now() / 15000)}`;
      try {
        await query(
          `INSERT INTO work_items (kind, state, payload, priority, dedupe_key)
           VALUES ($1, 'DONE', $2::jsonb, 15, $3)
           ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
          [
            workKind,
            JSON.stringify({
              workflow,
              agent: agent.id,
              reference: out.resolvedReference,
              confidence: out.result.confidence,
              requiresHumanApproval: out.result.requiresHumanApproval,
            }),
            dedupe,
          ],
        );
      } catch {
        // Non-fatal work item logging
      }
    }

    return out;
  });
}

/**
 * Schedules a non-blocking background agent run with per-workflow+reference
 * deduplication and cooldown so repeated UI interactions never stampede Gemini.
 */
export function scheduleBackgroundAgent(
  input: BackgroundDispatchInput,
): void {
  if (!getServerGeminiKey()) return;

  const cooldownMs = input.cooldownMs ?? 90_000;
  const key =
    input.dedupeKey ??
    `${input.orgId ?? "global"}:${input.workflow}:${input.reference ?? "all"}`;
  const existing = cooldownStore.get(key);
  const now = Date.now();

  if (existing) {
    if (existing.inFlight) return;
    if (now - existing.lastRunAt < cooldownMs) return;
  }

  const job = runBackendAgentWorkflow(input)
    .catch((err) => {
      console.warn(
        `[BackgroundAgents] Workflow "${input.workflow}" failed silently:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    })
    .finally(() => {
      const entry = cooldownStore.get(key);
      if (entry) {
        entry.inFlight = undefined;
        entry.lastRunAt = Date.now();
      }
    });

  cooldownStore.set(key, { lastRunAt: now, inFlight: job });
}

export type OperationsSweepScope =
  | "full"
  | "exceptions"
  | "supply"
  | "finance"
  | "customer";

const SWEEP_WORKFLOWS: Record<OperationsSweepScope, BackendWorkflow[]> = {
  full: [
    "background.orchestrate",
    "exceptions.triage",
    "tracking.monitor",
    "warehouses.inventory_balance",
    "finance.cost_audit",
    "automation.email_document_sync",
  ],
  exceptions: [
    "background.orchestrate",
    "exceptions.triage",
    "approvals.escalation_gate",
  ],
  supply: [
    "orders.validate_intake",
    "warehouses.inventory_balance",
    "carriers.evaluate_quotes",
  ],
  finance: ["finance.cost_audit", "analytics.executive_digest"],
  customer: ["communications.proactive_outreach", "support.customer_reply"],
};

/**
 * Runs a coordinated background operational sweep across specialist agents.
 * Invoked by internal backend automation or `/api/agents/sweep`.
 */
export async function runBackgroundOperationsSweep({
  orgId,
  actorEmail,
  scope = "full",
  reference,
}: {
  orgId: string | null;
  actorEmail?: string | null;
  scope?: OperationsSweepScope;
  reference?: string;
}): Promise<{
  scope: OperationsSweepScope;
  executed: Array<{
    workflow: BackendWorkflow;
    agentId: string;
    summary: string;
    requiresHumanApproval: boolean;
    latencyMs: number;
  }>;
  failed?: Array<{
    workflow: BackendWorkflow;
    error: string;
  }>;
  skippedReason?: string;
}> {
  if (!getServerGeminiKey()) {
    return {
      scope,
      executed: [],
      skippedReason: "GEMINI_API_KEY is not configured.",
    };
  }

  const workflows = SWEEP_WORKFLOWS[scope] ?? SWEEP_WORKFLOWS.full;
  const executed: Array<{
    workflow: BackendWorkflow;
    agentId: string;
    summary: string;
    requiresHumanApproval: boolean;
    latencyMs: number;
  }> = [];
  const failed: Array<{ workflow: BackendWorkflow; error: string }> = [];

  for (let i = 0; i < workflows.length; i += 1) {
    const wf = workflows[i];
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    try {
      const out = await runBackendAgentWorkflow({
        workflow: wf,
        orgId,
        reference,
        actorEmail,
        workKind: `sweep.${wf}`,
      });
      if (out) {
        executed.push({
          workflow: wf,
          agentId: out.agent.id,
          summary: out.result.summary,
          requiresHumanApproval: out.result.requiresHumanApproval,
          latencyMs: out.meta.latencyMs,
        });
      }
    } catch (err) {
      failed.push({
        workflow: wf,
        error: err instanceof Error ? err.message : String(err ?? "Sweep workflow failed"),
      });
    }
  }

  return {
    scope,
    executed,
    ...(failed.length > 0 ? { failed } : {}),
  };
}
