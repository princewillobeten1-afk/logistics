import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { SESSION_COOKIE, signUp } from "@/lib/auth";
import { verifySameOriginMutation } from "@/lib/request-origin";

export async function POST(req: NextRequest) {
  if (!verifySameOriginMutation(req)) {
    return NextResponse.json(
      { ok: false, error: "Invalid request origin." },
      { status: 403 },
    );
  }

  let body: {
    companyName?: unknown;
    name?: unknown;
    email?: unknown;
    password?: unknown;
    confirm?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid workspace creation payload." },
      { status: 400 },
    );
  }

  const companyName =
    typeof body.companyName === "string" ? body.companyName : "";
  const name = typeof body.name === "string" ? body.name : "";
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirm = typeof body.confirm === "string" ? body.confirm : "";

  if (password !== confirm) {
    return NextResponse.json(
      { ok: false, error: "Passwords do not match." },
      { status: 400 },
    );
  }

  const head = await headers();
  const ip =
    head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? head.get("x-real-ip");
  const userAgent = head.get("user-agent");

  let result;
  try {
    result = await signUp(
      { companyName, name, email, password },
      { ip, userAgent },
    );
  } catch (err) {
    console.error("[auth/signup] signUp failed", err);
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
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: 400 },
    );
  }

  await recordAudit({
    actor: result.user.email,
    action: "USER_CREATED",
    orgId: result.user.orgId,
    actorType: "USER",
    entityType: "user",
    entityId: result.user.id,
    after: {
      email: result.user.email,
      role: result.user.role,
      self_service: true,
    },
    ip,
    userAgent,
  });

  const response = NextResponse.json({
    ok: true,
    redirectTo: "/",
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
