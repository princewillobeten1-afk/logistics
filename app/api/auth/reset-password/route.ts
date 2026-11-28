import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { resetPassword } from "@/lib/auth";
import { verifySameOriginMutation } from "@/lib/request-origin";

export async function POST(req: NextRequest) {
  if (!verifySameOriginMutation(req)) {
    return NextResponse.json(
      { ok: false, error: "Invalid request origin." },
      { status: 403 },
    );
  }

  let body: { token?: unknown; password?: unknown; confirm?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid password reset payload." },
      { status: 400 },
    );
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirm = typeof body.confirm === "string" ? body.confirm : "";

  if (!token) {
    return NextResponse.json(
      { ok: false, error: "This reset link is invalid." },
      { status: 400 },
    );
  }

  if (password !== confirm) {
    return NextResponse.json(
      { ok: false, error: "Passwords do not match." },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await resetPassword(token, password);
  } catch (err) {
    console.error("[auth/reset-password] failed", err);
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
    actor: result.email,
    action: "PASSWORD_RESET",
    orgId: result.orgId,
    entityType: "user",
  });

  return NextResponse.json({
    ok: true,
    redirectTo: "/login?reset=1",
  });
}
