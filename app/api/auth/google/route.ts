import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import firebaseConfig from "@/firebase-applet-config.json";
import { recordAudit } from "@/lib/audit";
import { SESSION_COOKIE, signInWithGoogle } from "@/lib/auth";
import { verifySameOriginMutation } from "@/lib/request-origin";

type LookupUser = {
  localId?: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
};

export async function POST(req: NextRequest) {
  if (!verifySameOriginMutation(req)) {
    return NextResponse.json(
      { ok: false, error: "Invalid request origin." },
      { status: 403 },
    );
  }

  const authHeader = req.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";

  let body: { idToken?: string; companyName?: string; next?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // Body is optional if Bearer token was supplied
  }

  const idToken = bearerToken || body.idToken?.trim() || "";
  if (!idToken) {
    return NextResponse.json(
      { ok: false, error: "Missing Google authentication token." },
      { status: 400 },
    );
  }

  // Verify the Firebase ID token via Firebase Auth REST API
  let verifyRes: Response;
  try {
    verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
        cache: "no-store",
      },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "Unable to contact Google verification service." },
      { status: 502 },
    );
  }

  if (!verifyRes.ok) {
    const errText = await verifyRes.text().catch(() => "");
    console.error(
      "[auth/google] accounts:lookup failed",
      verifyRes.status,
      errText,
    );
    return NextResponse.json(
      { ok: false, error: "Could not verify Google sign-in token." },
      { status: 401 },
    );
  }

  const verified = (await verifyRes.json()) as { users?: LookupUser[] };
  const account = verified.users?.[0];
  if (!account?.email) {
    return NextResponse.json(
      { ok: false, error: "Google account has no verified email address." },
      { status: 401 },
    );
  }

  const head = await headers();
  const ip =
    head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? head.get("x-real-ip");
  const userAgent = head.get("user-agent");

  let result;
  try {
    result = await signInWithGoogle(
      {
        email: account.email,
        name: account.displayName ?? null,
        companyName: body.companyName ?? null,
      },
      { ip, userAgent },
    );
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
      actor: account.email,
      action: "LOGIN_FAILED",
      orgId: null,
      ip,
      userAgent,
    });
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: 403 },
    );
  }

  await recordAudit({
    actor: result.user.email,
    action: "LOGIN_GOOGLE",
    orgId: result.user.orgId,
    entityType: "user",
    entityId: result.user.id,
    ip,
    userAgent,
  });

  const next = body.next ?? "/";
  const redirectTo = next.startsWith("/") && !next.startsWith("//") ? next : "/";

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
