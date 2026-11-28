import { NextRequest, NextResponse } from "next/server";
import { classifyGeminiError } from "@/lib/agents/catalog";
import {
  runBackgroundOperationsSweep,
  type OperationsSweepScope,
} from "@/lib/agents/background";
import { MissingGeminiKeyError } from "@/lib/agents/gemini-client";
import { currentUser, may } from "@/lib/auth";
import { checkDistributedTenantRateLimit } from "@/lib/distributed-guard";
import { detectWorkspaceTampering } from "@/lib/tenant-guard";

export const dynamic = "force-dynamic";

const VALID_SCOPES = new Set<OperationsSweepScope>([
  "full",
  "exceptions",
  "fleet",
  "supply",
  "finance",
  "customer",
]);

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!may(user.role, "EDIT_SHIPMENT") && user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only dispatchers or workspace administrators can run operational sweeps." },
      { status: 403 },
    );
  }

  let body: { scope?: string; reference?: string } & Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.trim()) {
      body = JSON.parse(text) as typeof body;
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const tamper = detectWorkspaceTampering(req, user.orgId, body);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const rate = await checkDistributedTenantRateLimit(user.orgId, "agents:sweep", 12, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Workspace operations sweep rate limit exceeded." },
      { status: 429 },
    );
  }

  const rawScope = (body.scope ?? "exceptions").trim() as OperationsSweepScope;
  const scope: OperationsSweepScope = VALID_SCOPES.has(rawScope)
    ? rawScope
    : "exceptions";

  try {
    const summary = await runBackgroundOperationsSweep({
      orgId: user.orgId,
      actorEmail: user.email,
      scope,
      reference: body.reference?.trim() || undefined,
    });
    return NextResponse.json(summary);
  } catch (err) {
    if (err instanceof MissingGeminiKeyError) {
      return NextResponse.json(
        { error: err.message, missingKey: true },
        { status: 503 },
      );
    }
    const mapped = classifyGeminiError(err);
    return NextResponse.json(
      { error: mapped.message, quotaExceeded: mapped.quotaExceeded },
      { status: mapped.status },
    );
  }
}
