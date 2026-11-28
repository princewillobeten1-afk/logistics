"use server";

import { headers } from "next/headers";

import { isHttpsRequest, requestPasswordReset } from "@/lib/auth";
import { resolvePublicOrigin } from "@/lib/request-origin";

export type ForgotState = {
  submitted: boolean;
  error?: string | null;
  previewResetUrl?: string | null;
};

export async function requestResetAction(
  _prev: ForgotState,
  formData: FormData,
): Promise<ForgotState> {
  const email = String(formData.get("email") ?? "").trim();

  const head = await headers();
  const ip =
    head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? head.get("x-real-ip");
  const userAgent = head.get("user-agent");
  const origin = resolvePublicOrigin(head, isHttpsRequest(head));

  let result;
  try {
    result = await requestPasswordReset(email, { ip, userAgent, origin });
  } catch {
    return {
      submitted: false,
      error:
        "The system database is temporarily unreachable. Verify that the database service is running and try again.",
    };
  }

  if (!result.ok) {
    return {
      submitted: false,
      error: result.error,
    };
  }

  return {
    submitted: true,
    error: null,
    previewResetUrl: result.previewResetUrl ?? null,
  };
}
