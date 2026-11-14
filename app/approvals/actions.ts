"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { recordAudit } from "@/lib/audit";
import { requireRole } from "@/lib/auth";
import { query, transaction } from "@/lib/db";

/** Decide an approval from the dashboard.
 *
 *  Deliberately the same two writes the CLI performs — a conditional UPDATE
 *  guarded on `state = 'PENDING'`, then the queued follow-up step. That guard
 *  is what makes a token single-use: a double-clicked Approve matches no row
 *  the second time and changes nothing.
 *
 *  Nothing here books anything. It records the decision and enqueues work; the
 *  Python worker executes, through the idempotent tool path. */
export async function decideApproval(formData: FormData): Promise<void> {
  // The point of the whole authentication effort. This action authorises
  // carrier spending, and until now it took the deciding party's name from a
  // form field — the policy gate carefully withheld the decision from the
  // agent and then handed it to whoever could reach the port.
  const user = await requireRole("APPROVE");

  const token = String(formData.get("token") ?? "");
  const approved = String(formData.get("decision")) === "approve";
  if (!token) return;

  const head = await headers();
  const ip =
    head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? head.get("x-real-ip");

  const decided = await transaction(async (client) => {
    const result = await client.query(
      `UPDATE approvals
          SET state = $1, decided_by = $2, decided_at = now()
        WHERE token = $3 AND state = 'PENDING' AND expires_at > now()
      RETURNING id, shipment_id, proposed_action_id`,
      [approved ? "APPROVED" : "REJECTED", user.email, token],
    );

    if (result.rowCount === 0) {
      // Already used, rejected, or expired. Not an error — nothing to do.
      // It is also what another org's token looks like from here: the row
      // exists, but not for us.
      return null;
    }

    const row = result.rows[0];

    await client.query(
      `UPDATE proposed_actions SET state = $1, decided_at = now()
        WHERE id = $2 AND state = 'PROPOSED'`,
      [approved ? "APPROVED" : "REJECTED", row.proposed_action_id],
    );

    const params = await client.query(
      `SELECT params FROM proposed_actions WHERE id = $1`,
      [row.proposed_action_id],
    );
    const round = params.rows[0]?.params?.round ?? 1;

    await client.query(
      `INSERT INTO work_items (shipment_id, kind, payload, priority, dedupe_key)
       VALUES ($1, $2, $3, 10, $4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        row.shipment_id,
        approved ? "approval.granted" : "approval.refused",
        JSON.stringify({
          approval_id: row.id,
          proposed_action_id: row.proposed_action_id,
          decided_by: user.email,
          round,
        }),
        `decision:${row.id}`,
      ],
    );

    return row;
  });

  if (decided) {
    await recordAudit({
      actor: user.email,
      orgId: user.orgId,
      action: approved ? "APPROVAL_GRANTED" : "APPROVAL_DENIED",
      entityType: "approval",
      entityId: decided.id,
      after: {
        shipment_id: decided.shipment_id,
        proposed_action_id: decided.proposed_action_id,
        role: user.role,
      },
      ip,
      userAgent: head.get("user-agent"),
    });
  }

  revalidatePath("/approvals");
  revalidatePath("/");
}

export async function pendingCount(): Promise<number> {
  const [row] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM approvals WHERE state = 'PENDING'`,
  );
  return Number(row?.n ?? 0);
}
