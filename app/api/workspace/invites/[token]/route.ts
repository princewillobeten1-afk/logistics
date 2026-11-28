import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { isSameOriginMutation } from "@/lib/intelligence/access";
import {
  acceptTeamInvitation,
  inspectTeamInvitation,
} from "@/lib/workspace-admin";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const info = await inspectTeamInvitation(token);
  if (!info) {
    return NextResponse.json(
      { error: "Invitation not found." },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, invitation: info });
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  if (!isSameOriginMutation(req)) {
    return NextResponse.json(
      { error: "Cross-origin request rejected." },
      { status: 403 },
    );
  }

  const { token } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name : "";
  const password = typeof body.password === "string" ? body.password : "";

  const result = await acceptTeamInvitation(
    token,
    { name, password },
    {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true, user: result.user }, { status: 201 });
  if (result.cookie) {
    res.cookies.set(SESSION_COOKIE, result.cookie.token, result.cookie.options);
  }
  return res;
}
