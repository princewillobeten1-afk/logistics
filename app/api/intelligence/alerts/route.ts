import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { currentUser } from "@/lib/auth";
import { getBiAccessPolicy, isSameOriginMutation } from "@/lib/intelligence/access";
import {
  detectWorkspaceTampering,
  hasDepartmentAccess,
} from "@/lib/tenant-guard";

export const dynamic = "force-dynamic";

const ALERT_ID_RE = /^[a-zA-Z0-9_-]{3,80}$/;

export async function POST(req: NextRequest) {
  if (!isSameOriginMutation(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const policy = getBiAccessPolicy(user.role);
  if (!policy.canAcknowledgeAlerts || !hasDepartmentAccess(user, "BI")) {
    return NextResponse.json(
      {
        error: `Your role or department scope cannot acknowledge or reopen proactive BI alerts.`,
      },
      { status: 403 },
    );
  }

  let body: { alertId?: unknown; action?: unknown } & Record<string, unknown>;
  try {
    body = (await req.json()) as { alertId?: unknown; action?: unknown } & Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const tamper = detectWorkspaceTampering(req, user.orgId, body);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const alertId = typeof body.alertId === "string" ? body.alertId.trim() : "";
  const action = body.action === "reopen" ? "reopen" : body.action === "acknowledge" ? "acknowledge" : null;

  if (!ALERT_ID_RE.test(alertId)) {
    return NextResponse.json({ error: "Invalid alert identifier." }, { status: 400 });
  }
  if (!action) {
    return NextResponse.json(
      { error: "Action must be 'acknowledge' or 'reopen'." },
      { status: 400 },
    );
  }

  await recordAudit({
    actor: user.email,
    actorType: "USER",
    action: action === "acknowledge" ? "BI_ALERT_ACKNOWLEDGED" : "BI_ALERT_REOPENED",
    orgId: user.orgId,
    entityType: `bi_alert:${alertId}`,
    after: { alertId, action, role: user.role },
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.json({
    ok: true,
    alertId,
    acknowledged: action === "acknowledge",
  });
}
