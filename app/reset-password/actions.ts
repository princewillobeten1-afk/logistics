"use server";

import { redirect } from "next/navigation";

import { recordAudit } from "@/lib/audit";
import { resetPassword } from "@/lib/auth";

export type ResetState = { error: string | null };

export async function resetPasswordAction(
  _prev: ResetState,
  formData: FormData,
): Promise<ResetState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password !== confirm) {
    return { error: "Passwords do not match." };
  }

  let result;
  try {
    result = await resetPassword(token, password);
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
    actor: result.email,
    action: "PASSWORD_RESET",
    orgId: result.orgId,
    entityType: "user",
  });

  redirect("/login?reset=1");
}
