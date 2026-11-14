"use server";

import { requireUser } from "@/lib/auth";
import { query, transaction } from "@/lib/db";

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
 * Ask the assistant about a shipment.
 *
 * The model call happens in the Python worker, not here — one model client,
 * one routing table, one place where cost and latency land in `agent_runs`.
 * So this writes the question, writes an empty PENDING answer for the panel to
 * show progress against, and queues the work. The panel polls for the answer.
 *
 * Nothing on this path can change a shipment. `shipment.assist` reads and
 * writes only its own row.
 */
export async function askAssistant(
  reference: string,
  question: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();

  const text = question.trim();
  if (!text) return { ok: false, error: "Type a question first." };
  if (text.length > 1000) return { ok: false, error: "That question is too long." };

  try {
    return await transaction(async (client) => {
      const found = await client.query(
        `SELECT id FROM shipments WHERE upper(reference) = upper($1)`,
        [reference],
      );
      if (found.rowCount === 0) {
        // Also what another organisation's shipment looks like from here.
        return { ok: false as const, error: "No such shipment." };
      }
      const shipmentId = found.rows[0].id;

      await client.query(
        `INSERT INTO assistant_messages (shipment_id, user_id, role, body, state)
         VALUES ($1, $2, 'user', $3, 'DONE')`,
        [shipmentId, user.id, text],
      );

      const pending = await client.query(
        `INSERT INTO assistant_messages (shipment_id, user_id, role, state)
         VALUES ($1, $2, 'assistant', 'PENDING')
         RETURNING id`,
        [shipmentId, user.id],
      );

      await client.query(
        `INSERT INTO work_items (shipment_id, kind, payload, priority, dedupe_key)
         VALUES ($1, 'shipment.assist', $2, 1, $3)
         ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
        [
          shipmentId,
          JSON.stringify({ message_id: pending.rows[0].id }),
          `assist:${pending.rows[0].id}`,
        ],
      );

      return { ok: true as const };
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }
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
