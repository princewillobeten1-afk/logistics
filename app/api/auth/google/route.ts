import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import firebaseConfig from "@/firebase-applet-config.json";
import { recordAudit } from "@/lib/audit";
import { SESSION_COOKIE, signInWithGoogle } from "@/lib/auth";
import {
  sanitizeAuthRedirectTarget,
  verifySameOriginMutation,
} from "@/lib/request-origin";

type LookupUser = {
  localId?: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
};

type GoogleTokenInfo = {
  aud?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
};

async function verifyGoogleToken(idToken: string): Promise<{
  email: string;
  name: string | null;
} | null> {
  // 1. Primary path: verify Firebase ID token via Identity Toolkit
  const verifyRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
      cache: "no-store",
    },
  );

  if (verifyRes.ok) {
    const verified = (await verifyRes.json()) as { users?: LookupUser[] };
    const account = verified.users?.[0];
    if (account?.email && account.emailVerified !== false) {
      return {
        email: account.email,
        name: account.displayName ?? null,
      };
    }
    return null;
  }

  // 2. Fallback path: verify direct Google Identity Services ID token against pinned OAuth client ID
  const expectedAud = firebaseConfig.oAuthClientId;
  if (!expectedAud) return null;

  const gisRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    { cache: "no-store" },
  );
  if (!gisRes.ok) return null;

  const info = (await gisRes.json()) as GoogleTokenInfo;
  const emailVerified =
    info.email_verified === true || info.email_verified === "true";
  if (info.aud === expectedAud && info.email && emailVerified) {
    return {
      email: info.email,
      name: info.name ?? null,
    };
  }

  return null;
}

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

  let account: { email: string; name: string | null } | null;
  try {
    account = await verifyGoogleToken(idToken);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Unable to contact Google verification service." },
      { status: 502 },
    );
  }

  if (!account) {
    return NextResponse.json(
      { ok: false, error: "Could not verify Google account email." },
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
        name: account.name,
        companyName: body.companyName ?? null,
      },
      { ip, userAgent },
    );
  } catch (err) {
    console.error("[auth/google] signInWithGoogle failed", err);
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

  const redirectTo = sanitizeAuthRedirectTarget(body.next);

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
