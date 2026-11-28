import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { isSameOriginMutation } from "@/lib/intelligence/access";
import { detectWorkspaceTampering } from "@/lib/tenant-guard";
import {
  getWorkspaceSecurityProfile,
  rotateWorkspaceIntakeKey,
  rotateWorkspaceWebhookToken,
  updateWorkspaceChannelSecrets,
} from "@/lib/workspace-admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Workspace administrator privileges are required." },
      { status: 403 },
    );
  }

  const profile = await getWorkspaceSecurityProfile(user.orgId);
  if (!profile) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, security: profile });
}

export async function POST(req: NextRequest) {
  if (!isSameOriginMutation(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Workspace administrator privileges are required." },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const tamper = detectWorkspaceTampering(req, user.orgId, body);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const action = typeof body.action === "string" ? body.action.trim() : "";

  if (action === "rotate_webhook_token") {
    const { webhookToken } = await rotateWorkspaceWebhookToken(user.orgId, user);
    const security = await getWorkspaceSecurityProfile(user.orgId);
    return NextResponse.json({ ok: true, webhookToken, security });
  }

  if (action === "rotate_intake_key") {
    const { apiKey, prefix } = await rotateWorkspaceIntakeKey(user.orgId, user);
    const security = await getWorkspaceSecurityProfile(user.orgId);
    return NextResponse.json({
      ok: true,
      intakeApiKey: apiKey,
      intakeApiKeyPrefix: prefix,
      security,
    });
  }

  if (action === "update_channel_secrets") {
    const security = await updateWorkspaceChannelSecrets(user.orgId, user, {
      whatsappPhoneNumberId:
        typeof body.whatsappPhoneNumberId === "string"
          ? body.whatsappPhoneNumberId
          : body.whatsappPhoneNumberId === null
            ? null
            : undefined,
      whatsappVerifyToken:
        typeof body.whatsappVerifyToken === "string"
          ? body.whatsappVerifyToken
          : body.whatsappVerifyToken === null
            ? null
            : undefined,
      whatsappAppSecret:
        typeof body.whatsappAppSecret === "string"
          ? body.whatsappAppSecret
          : body.whatsappAppSecret === null
            ? null
            : undefined,
      telegramWebhookSecret:
        typeof body.telegramWebhookSecret === "string"
          ? body.telegramWebhookSecret
          : body.telegramWebhookSecret === null
            ? null
            : undefined,
    });
    return NextResponse.json({ ok: true, security });
  }

  return NextResponse.json({ error: "Unsupported security action." }, { status: 400 });
}
