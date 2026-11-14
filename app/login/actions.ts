"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { signIn, signOut, currentUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export type LoginState = { error: string | null };

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const head = await headers();
  const ip =
    head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? head.get("x-real-ip");
  const userAgent = head.get("user-agent");

  let result;
  try {
    result = await signIn(email, password, { ip, userAgent });
  } catch {
    return {
      error:
        "The system database is temporarily unreachable. Verify that the database service is running and try again.",
    };
  }

  if (!result.ok) {
    // Audited with the attempted address but no hint as to which part was
    // wrong — the log should show a pattern of failures without becoming a
    // list of valid addresses itself.
    await recordAudit({
      actor: email,
      action: "LOGIN_FAILED",
      orgId: null,
      ip,
      userAgent,
    });
    return { error: result.error };
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

  // Only ever redirect within this site. An open redirect here would turn the
  // sign-in page into a credible phishing hop.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function signOutAction(): Promise<void> {
  const user = await currentUser();
  if (user) {
    await recordAudit({
      actor: user.email,
      action: "LOGOUT",
      orgId: user.orgId,
      entityType: "user",
      entityId: user.id,
    });
  }
  await signOut();
  redirect("/login");
}
