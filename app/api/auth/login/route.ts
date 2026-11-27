import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { SESSION_COOKIE, signIn } from "@/lib/auth";
import { verifySameOriginMutation } from "@/lib/request-origin";

export async function POST(req: NextRequest) {
  if (!verifySameOriginMutation(req)) {
    return NextResponse.json(
      { ok: false, error: "Invalid request origin." },
      { status: 403 },
    );
  }

  let body: { email?: unknown; password?: unknown; next?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid sign-in payload." },
      { status: 400 },
    );
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const nextRaw = typeof body.next === "string" ? body.next : "/";
  const redirectTo =
    nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "/";

  if (!email || !password) {
    return NextResponse.json(
      { ok: false, error: "Enter your email and password." },
      { status: 400 },
    );
  }

  const head = await headers();
  const ip =
    head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? head.get("x-real-ip");
  const userAgent = head.get("user-agent");

  let result;
  try {
    result = await signIn(email, password, { ip, userAgent });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error:
          "The system database is temporarily unreachable. Verify that the service is running and try again.",
      },
      { status: 503 },
    );
  }

  if (!result.ok) {
    await recordAudit({
      actor: email,
      action: "LOGIN_FAILED",
      orgId: null,
      ip,
      userAgent,
    });
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: 401 },
    );
  }

  await recordAudit({
    actor: result.user.email,
    action: "LOGIN",
    orgId: result.user.orgId,
    entityType: "user",
    entityId: result.user.id,
    ip,
    userAgent,
  });

  const response = NextResponse.json({
    ok: true,
    redirectTo,
    user: {
      email: result.user.email,
      name: result.user.name,
      orgName: result.user.orgName,
      role: result.user.role,
    },
  });

  if (result.cookie) {
    response.cookies.set(
      SESSION_COOKIE,
      result.cookie.token,
      result.cookie.options,
    );
  }

  return response;
}
