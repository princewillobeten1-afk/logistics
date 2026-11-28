import { NextRequest, NextResponse } from "next/server";
import {
  classifyGeminiError,
  getAgentById,
  type CoreAgentId,
} from "@/lib/agents/catalog";
import { MissingGeminiKeyError } from "@/lib/agents/gemini-client";
import { executeAgentTask } from "@/lib/agents/orchestrator";
import { currentUser, may } from "@/lib/auth";
import { runWithOrgScope } from "@/lib/db";
import { checkDistributedTenantRateLimit } from "@/lib/distributed-guard";
import {
  departmentForAgent,
  detectWorkspaceTampering,
  hasDepartmentAccess,
} from "@/lib/tenant-guard";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { agentId?: string; task?: string; reference?: string } & Record<string, unknown>;
  try {
    body = (await req.json()) as {
      agentId?: string;
      task?: string;
      reference?: string;
    } & Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const tamper = detectWorkspaceTampering(req, user.orgId, body);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const rawAgentId = (body.agentId ?? "orchestrator").trim();
  const agent = getAgentById(rawAgentId);
  if (!agent) {
    return NextResponse.json(
      { error: `Unknown agent "${rawAgentId}".` },
      { status: 400 },
    );
  }

  const requiredDept = departmentForAgent(agent.id);
  if (!hasDepartmentAccess(user, requiredDept)) {
    return NextResponse.json(
      {
        error: `Your workspace permissions do not grant access to the ${requiredDept} department agent.`,
      },
      { status: 403 },
    );
  }

  if (
    user.role === "VIEWER" &&
    !may(user.role, "EDIT_SHIPMENT") &&
    agent.id !== "logistics-analytics" &&
    agent.id !== "ai-customer-support"
  ) {
    return NextResponse.json(
      { error: "Read-only viewers cannot run operational dispatch or mutation agents." },
      { status: 403 },
    );
  }

  const rate = await checkDistributedTenantRateLimit(user.orgId, "agents:run", 40, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Workspace AI agent rate limit exceeded. Please retry shortly." },
      { status: 429 },
    );
  }

  const task = (body.task ?? "").trim();
  if (task.length > 2000) {
    return NextResponse.json(
      { error: "Task description exceeds 2000 characters." },
      { status: 400 },
    );
  }

  try {
    const execution = await runWithOrgScope(user.orgId, () =>
      executeAgentTask({
        agentId: agent.id as CoreAgentId,
        task: task || agent.quickPrompts[0],
        reference: body.reference?.trim() || undefined,
        actorEmail: user.email,
        userScope: {
          role: user.role,
          departments: user.departments,
          branchCodes: user.branchCodes,
        },
      }),
    );

    return NextResponse.json({
      agent: {
        id: execution.agent.id,
        name: execution.agent.name,
        domainId: execution.agent.domainId,
        targetRoute: execution.agent.targetRoute,
        targetLabel: execution.agent.targetLabel,
      },
      result: execution.result,
      meta: execution.meta,
      resolvedReference: execution.resolvedReference,
    });
  } catch (err) {
    if (err instanceof MissingGeminiKeyError) {
      return NextResponse.json(
        { error: err.message, missingKey: true },
        { status: 503 },
      );
    }

    console.error("[Agents] Execution failed:", err);
    const mapped = classifyGeminiError(err);
    return NextResponse.json(
      { error: mapped.message, quotaExceeded: mapped.quotaExceeded },
      { status: mapped.status },
    );
  }
}
