import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import {
  handleFrontendLogisticsAction,
  SUPPORTED_FRONTEND_INTENTS,
  type FrontendActionIntent,
  type FrontendLogisticsRequest,
} from "@/lib/controllers/action-controller";
import type { IntakeSourceChannel } from "@/lib/agents/autonomous";
import { detectWorkspaceTampering } from "@/lib/tenant-guard";

export const dynamic = "force-dynamic";

const INTENT_SET = new Set<string>(SUPPORTED_FRONTEND_INTENTS);

function revalidateAffectedRoutes(intent: string) {
  revalidatePath("/");
  revalidatePath("/orders");
  revalidatePath("/shipments");
  revalidatePath("/planning");
  revalidatePath("/exceptions");
  revalidatePath("/approvals");
  revalidatePath("/support");
  revalidatePath("/queue");
  revalidatePath("/activity");
  if (intent === "FLEET_OPTIMIZE" || intent === "PLANNING_ROUTING") {
    revalidatePath("/fleet");
  }
}

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }
  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ ok: false, error: tamper }, { status: 403 });
  }

  return NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      orgId: user.orgId,
      orgName: user.orgName,
      departments: user.departments,
      branchCodes: user.branchCodes,
    },
    supportedIntents: SUPPORTED_FRONTEND_INTENTS,
  });
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON request body." },
      { status: 400 },
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json(
      { ok: false, error: "Request body must be a JSON object." },
      { status: 400 },
    );
  }

  const tamper = detectWorkspaceTampering(req, user.orgId, raw);
  if (tamper) {
    return NextResponse.json({ ok: false, error: tamper }, { status: 403 });
  }

  const rawIntent = String(raw.intent ?? "AUTO")
    .trim()
    .toUpperCase();

  if (!INTENT_SET.has(rawIntent)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Unsupported intent "${rawIntent}". Allowed intents: ${SUPPORTED_FRONTEND_INTENTS.join(", ")}.`,
      },
      { status: 400 },
    );
  }

  const intent = rawIntent as FrontendActionIntent;
  const sourceChannel =
    typeof raw.sourceChannel === "string"
      ? (raw.sourceChannel.trim().toUpperCase() as IntakeSourceChannel)
      : undefined;

  const payloadObj =
    raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : raw;

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    null;
  const userAgent = req.headers.get("user-agent") ?? null;

  const requestObj: FrontendLogisticsRequest =
    intent === "APPROVAL_DECISION"
      ? {
          intent: "APPROVAL_DECISION",
          sourceChannel,
          payload: {
            token: String(payloadObj.token ?? ""),
            decision:
              String(payloadObj.decision ?? "").toLowerCase() === "approve"
                ? "approve"
                : "reject",
            ip,
            userAgent,
          },
        }
      : ({
          intent,
          sourceChannel,
          payload: payloadObj,
        } as FrontendLogisticsRequest);

  const result = await handleFrontendLogisticsAction(requestObj);

  if (result.ok) {
    revalidateAffectedRoutes(result.intent);
  }

  return NextResponse.json(result, { status: result.status });
}
