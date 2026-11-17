"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { requireRole } from "@/lib/auth";
import { handleFrontendLogisticsAction } from "@/lib/controllers/action-controller";
import { query } from "@/lib/db";

/** Decide an approval from the dashboard via the Server-Side Action Controller,
 *  which verifies APPROVE permission, applies the single-use approval transaction,
 *  and forwards the APPROVAL_DECISION payload to the Autonomous Agent for delegation. */
export async function decideApproval(formData: FormData): Promise<void> {
  await requireRole("APPROVE");

  const token = String(formData.get("token") ?? "");
  const decision =
    String(formData.get("decision")) === "approve" ? "approve" : "reject";
  if (!token) return;

  const head = await headers();
  const ip =
    head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? head.get("x-real-ip");

  await handleFrontendLogisticsAction({
    intent: "APPROVAL_DECISION",
    payload: {
      token,
      decision,
      ip,
      userAgent: head.get("user-agent"),
    },
  });

  revalidatePath("/approvals");
  revalidatePath("/");
  revalidatePath("/queue");
  revalidatePath("/activity");
}

export async function pendingCount(): Promise<number> {
  const [row] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM approvals WHERE state = 'PENDING'`,
  );
  return Number(row?.n ?? 0);
}
