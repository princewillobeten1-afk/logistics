"use server";

import { requireUser } from "@/lib/auth";
import { query, transaction } from "@/lib/db";

/** What a customer is allowed to see. An allowlist, mirroring
 *  `src/logistics/support/view.py::CustomerView` — carrier cost, quotes, scores and
 *  policy decisions are absent by construction rather than filtered out. */
export type TrackResult = {
  reference: string;
  status: string;
  origin: string | null;
  destination: string | null;
  promised_by: string | null;
  estimated_arrival: string | null;
  carrier: string | null;
  delayed: boolean;
  quantity: number | null;
};

const CUSTOMER_STATUS: Record<string, string> = {
  DRAFT: "Order received",
  NEEDS_INFO: "Waiting for information from you",
  VALIDATED: "Being prepared",
  ALLOCATED: "Being prepared",
  PLANNED: "Arranging transport",
  SOURCING: "Arranging transport",
  AWAITING_APPROVAL: "Arranging transport",
  BOOKED: "Booked — awaiting pickup",
  IN_TRANSIT: "In transit",
  EXCEPTION: "Delayed",
  DELIVERED: "Delivered",
  POD_VERIFIED: "Delivered",
  CLOSED: "Delivered",
  CANCELLED: "Cancelled",
  FAILED: "Could not be completed",
};

function place(loc: Record<string, unknown> | null): string | null {
  if (!loc) return null;
  return (
    (loc.city as string) || (loc.warehouse as string) || (loc.address as string) || null
  );
}

export async function lookupShipment(
  reference: string,
): Promise<TrackResult | null> {
  const trimmed = reference.trim().toUpperCase();
  if (!trimmed) return null;

  const rows = await query<{
    state: string;
    reference: string;
    origin: Record<string, unknown>;
    destination: Record<string, unknown>;
    cargo: Record<string, unknown>;
    deadline: Date | null;
    plan: Record<string, unknown> | null;
    booking: Record<string, unknown> | null;
    open_exceptions: string;
  }>(
    `SELECT s.reference, s.state, s.origin, s.destination, s.cargo,
            s.deadline, s.plan, s.booking,
            (SELECT count(*)::text FROM exceptions e
              WHERE e.shipment_id = s.id AND e.state <> 'RESOLVED') AS open_exceptions
       FROM shipments s WHERE upper(s.reference) = $1`,
    [trimmed],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    reference: row.reference,
    status: CUSTOMER_STATUS[row.state] ?? "In progress",
    origin: place(row.origin),
    destination: place(row.destination),
    promised_by: row.deadline ? new Date(row.deadline).toISOString() : null,
    estimated_arrival: (row.plan?.projected_delivery as string) ?? null,
    // The carrier's name is fine to share. Nothing about what we paid is.
    carrier: (row.booking?.carrier_code as string) ?? null,
    delayed: Number(row.open_exceptions) > 0 || row.state === "EXCEPTION",
    quantity: (row.cargo?.quantity as number) ?? null,
  };
}

export type ChatTurn = { role: "customer" | "agent"; text: string; at: string };

export async function conversation(
  reference?: string,
  sessionKey?: string,
): Promise<{ turns: ChatTurn[]; activeReference: string | null }> {
  const user = await requireUser();
  const extId = sessionKey?.trim() || `portal:${user.id}`;
  const trimmedRef = reference?.trim().toUpperCase() || "";

  if (trimmedRef) {
    const rows = await query<{ direction: string; body: string; created_at: Date }>(
      `SELECT m.direction, m.body, m.created_at
         FROM communications m
         JOIN shipments s ON s.id = m.shipment_id
        WHERE upper(s.reference) = $1 AND m.channel IN ('WIDGET', 'PORTAL')
        ORDER BY m.created_at`,
      [trimmedRef],
    );
    return {
      turns: rows.map((r) => ({
        role: r.direction === "INBOUND" ? "customer" : "agent",
        text: r.body,
        at: new Date(r.created_at).toISOString(),
      })),
      activeReference: trimmedRef,
    };
  }

  // Session-based conversation (e.g. booking a new shipment via support chat)
  const contacts = await query<{ id: string; last_ref: string | null }>(
    `SELECT c.id,
            (SELECT s.reference FROM shipments s WHERE s.id = c.last_shipment_id) AS last_ref
       FROM channel_contacts c
      WHERE c.channel = 'WIDGET' AND c.external_id = $1
      LIMIT 1`,
    [extId],
  );
  const contact = contacts[0];
  if (!contact) {
    return { turns: [], activeReference: null };
  }

  const rows = await query<{ direction: string; body: string; created_at: Date }>(
    `SELECT m.direction, m.body, m.created_at
       FROM communications m
      WHERE m.contact_id = $1
      ORDER BY m.created_at`,
    [contact.id],
  );

  return {
    turns: rows.map((r) => ({
      role: r.direction === "INBOUND" ? "customer" : "agent",
      text: r.body,
      at: new Date(r.created_at).toISOString(),
    })),
    activeReference: contact.last_ref ?? null,
  };
}

/** Record a question or booking message and queue the support agent to answer it.
 *
 *  Deliberately does not call a model here. The reply is produced by the
 *  `support.reply` handler in the Python worker, so it lands in `agent_runs`
 *  with its cost and latency, registers any completed new order on WPCargo,
 *  and delegates to the Orchestrator pipeline. */
export async function askQuestion(
  reference: string,
  question: string,
  sessionKey?: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = question.trim();
  if (!trimmed) return { ok: false, error: "Type a message first." };
  if (trimmed.length > 1500) {
    return { ok: false, error: "That message is too long." };
  }

  const user = await requireUser();
  const extId = sessionKey?.trim() || `portal:${user.id}`;
  const trimmedRef = reference.trim().toUpperCase();

  try {
    return await transaction(async (client) => {
      let shipmentId: string | null = null;
      if (trimmedRef) {
        const found = await client.query(
          `SELECT id FROM shipments WHERE upper(reference) = $1`,
          [trimmedRef],
        );
        if (found.rowCount === 0) {
          return { ok: false as const, error: "We could not find that reference." };
        }
        shipmentId = found.rows[0].id;
      }

      const contactRes = await client.query(
        `INSERT INTO channel_contacts (channel, external_id, display_name, last_shipment_id)
         VALUES ('WIDGET', $1, $2, $3)
         ON CONFLICT (org_id, channel, external_id) DO UPDATE
             SET last_seen_at = now(),
                 last_shipment_id = COALESCE($3, channel_contacts.last_shipment_id)
         RETURNING id, last_shipment_id`,
        [extId, user.name || user.email, shipmentId],
      );
      const contactId: string = contactRes.rows[0].id;
      const effectiveShipmentId: string | null =
        shipmentId ?? contactRes.rows[0].last_shipment_id ?? null;

      const inbound = await client.query(
        `INSERT INTO communications
            (shipment_id, contact_id, channel, direction, body, recipient, state, safety_checked)
         VALUES ($1, $2, 'WIDGET', 'INBOUND', $3, $4, 'RECEIVED', false)
         RETURNING id`,
        [effectiveShipmentId, contactId, trimmed, extId],
      );

      await client.query(
        `INSERT INTO work_items (shipment_id, kind, payload, priority, dedupe_key)
         VALUES ($1, 'support.reply', $2, 5, $3)
         ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
        [
          effectiveShipmentId,
          JSON.stringify({
            communication_id: inbound.rows[0].id,
            contact_id: contactId,
          }),
          `support:${inbound.rows[0].id}`,
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
