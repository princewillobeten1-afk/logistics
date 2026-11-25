"use server";

import { requireUser } from "@/lib/auth";
import { handleFrontendLogisticsAction } from "@/lib/controllers/action-controller";
import { query } from "@/lib/db";

export type AssistantTurn = {
  id: string;
  role: "user" | "assistant";
  body: string | null;
  state: "PENDING" | "DONE" | "FAILED";
  confidence: string | null;
  next_step: string | null;
  created_at: Date;
};

/**
 * Ask the assistant about a shipment via the centralized Server-Side Action Controller.
 *
 * Uses the configured server AI provider (NVIDIA Nemotron 3.5 Super VL or Gemini)
 * directly when available, or enqueues `shipment.assist` for the Python worker.
 */
export async function askAssistant(
  reference: string,
  question: string,
): Promise<{ ok: boolean; error?: string }> {
  await requireUser();

  const out = await handleFrontendLogisticsAction({
    intent: "SHIPMENT_ASSIST",
    payload: { reference, question },
  });

  if (!out.ok) {
    return { ok: false, error: out.error ?? out.message };
  }
  return { ok: true };
}

/** One operator's thread on one shipment. Scoped to the signed-in user: two
 *  dispatchers looking at the same shipment should not find each other's
 *  half-finished questions. */
export async function assistantThread(reference: string): Promise<AssistantTurn[]> {
  const user = await requireUser();
  return query<AssistantTurn>(
    `SELECT m.id, m.role, m.body, m.state, m.confidence::text, m.next_step,
            m.created_at
       FROM assistant_messages m
       JOIN shipments s ON s.id = m.shipment_id
      WHERE upper(s.reference) = upper($1) AND m.user_id = $2
      ORDER BY m.created_at
      LIMIT 60`,
    [reference, user.id],
  );
}

export async function clearThread(reference: string): Promise<void> {
  const user = await requireUser();
  await query(
    `DELETE FROM assistant_messages m
      USING shipments s
      WHERE s.id = m.shipment_id
        AND upper(s.reference) = upper($1) AND m.user_id = $2`,
    [reference, user.id],
  );
}
