import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { isHttpsRequest, requestPasswordReset } from "@/lib/auth";
import { resolvePublicOrigin, verifySameOriginMutation } from "@/lib/request-origin";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  if (!verifySameOriginMutation(req)) {
    return NextResponse.json(
      { ok: false, error: "Invalid request origin." },
      { status: 403 },
    );
  }

  let body: { email?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid password reset payload." },
      { status: 400 },
    );
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { ok: false, error: "Enter a valid email address." },
      { status: 400 },
    );
  }

  const head = await headers();
  const ip =
    head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? head.get("x-real-ip");
  const userAgent = head.get("user-agent");
  const origin = resolvePublicOrigin(head, isHttpsRequest(head));

  let result;
  try {
    result = await requestPasswordReset(email, { ip, userAgent, origin });
  } catch (err) {
    console.error("[auth/forgot-password] failed", err);
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
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    delivery: result.delivery,
    ...(result.previewResetUrl ? { previewResetUrl: result.previewResetUrl } : {}),
  });
}
