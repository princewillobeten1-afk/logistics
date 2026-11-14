"use server";

import { headers } from "next/headers";

import { requestPasswordReset } from "@/lib/auth";

export type ForgotState = { submitted: boolean; error?: string | null };

export async function requestResetAction(
  _prev: ForgotState,
  formData: FormData,
): Promise<ForgotState> {
  const email = String(formData.get("email") ?? "");

  const head = await headers();
  const ip =
    head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? head.get("x-real-ip");
  const userAgent = head.get("user-agent");

  // No error branch reaches the visitor here on purpose — see lib/auth.ts.
  // Whether or not the address has an account, the page says the same thing.
  try {
    await requestPasswordReset(email, { ip, userAgent });
  } catch {
    return {
      submitted: false,
      error:
        "The system database is temporarily unreachable. Verify that the database service is running and try again.",
    };
  }

  return { submitted: true, error: null };
}
