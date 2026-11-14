"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { recordAudit } from "@/lib/audit";
import { signUp } from "@/lib/auth";

export type SignUpState = { error: string | null };

export async function signUpAction(
  _prev: SignUpState,
  formData: FormData,
): Promise<SignUpState> {
  const companyName = String(formData.get("companyName") ?? "");
  const name = String(formData.get("name") ?? "");
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  // Client-side already checks this, but a form can be submitted without the
  // client-side check running — the server is where this actually matters.
  if (password !== confirm) {
    return { error: "Passwords do not match." };
  }

  const head = await headers();
  const ip =
    head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? head.get("x-real-ip");
  const userAgent = head.get("user-agent");

  let result;
  try {
    result = await signUp({ companyName, name, email, password }, { ip, userAgent });
  } catch {
    return {
      error:
        "The system database is temporarily unreachable. Verify that the database service is running and try again.",
    };
  }

  if (!result.ok) {
    return { error: result.error };
  }

  await recordAudit({
    actor: result.user.email,
    action: "USER_CREATED",
    orgId: result.user.orgId,
    // Distinct from the CLI's SYSTEM actor: this account created itself.
    actorType: "USER",
    entityType: "user",
    entityId: result.user.id,
    after: { email: result.user.email, role: result.user.role, self_service: true },
    ip,
    userAgent,
  });

  redirect("/");
}
