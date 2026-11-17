import { NextRequest, NextResponse } from "next/server";
import {
  classifyGeminiError,
  getAgentById,
  type CoreAgentId,
} from "@/lib/agents/catalog";
import { MissingGeminiKeyError } from "@/lib/agents/gemini-client";
import { executeAgentTask } from "@/lib/agents/orchestrator";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { agentId?: string; task?: string; reference?: string };
  try {
    body = (await req.json()) as {
      agentId?: string;
      task?: string;
      reference?: string;
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const rawAgentId = (body.agentId ?? "orchestrator").trim();
  const agent = getAgentById(rawAgentId);
  if (!agent) {
    return NextResponse.json(
      { error: `Unknown agent "${rawAgentId}".` },
      { status: 400 },
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
    const execution = await executeAgentTask({
      agentId: agent.id as CoreAgentId,
      task: task || agent.quickPrompts[0],
      reference: body.reference?.trim() || undefined,
      actorEmail: user.email,
    });

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
