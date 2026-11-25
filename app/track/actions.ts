"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { scheduleBackgroundAgent } from "@/lib/agents/background";
import { getServerGeminiKey } from "@/lib/agents/gemini-client";
import { currentUser, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";

/** What a customer is allowed to see. An allowlist — carrier cost, quotes, scores and
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
  const user = await currentUser();
  if (!user) return null;

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

  const delayed = Number(row.open_exceptions) > 0 || row.state === "EXCEPTION";
  if (delayed && getServerGeminiKey()) {
    const user = await currentUser();
    if (user?.orgId) {
      after(() => {
        scheduleBackgroundAgent({
          workflow: "tracking.monitor",
          orgId: user.orgId,
          reference: row.reference,
          actorEmail: user.email,
          task: `Verify latest transit milestone and delay ETA impact for ${row.reference}.`,
          workKind: "tracking.delayed_check",
          cooldownMs: 180_000,
        });
      });
    }
  }

  return {
    reference: row.reference,
    status: CUSTOMER_STATUS[row.state] ?? "In progress",
    origin: place(row.origin),
    destination: place(row.destination),
    promised_by: row.deadline ? new Date(row.deadline).toISOString() : null,
    estimated_arrival: (row.plan?.projected_delivery as string) ?? null,
    carrier: (row.booking?.carrier_code as string) ?? null,
    delayed,
    quantity: (row.cargo?.quantity as number) ?? null,
  };
}

export type ChatTurn = { role: "customer" | "agent"; text: string; at: string };

export async function conversation(
  reference?: string,
  sessionKey?: string,
  channel: "WEBSITE_CHAT" | "WHATSAPP" | "TELEGRAM" = "WEBSITE_CHAT",
): Promise<{ turns: ChatTurn[]; activeReference: string | null }> {
  const user = await requireUser();
  const extId = sessionKey?.trim() || `portal:${user.id}`;
  const trimmedRef = reference?.trim().toUpperCase() || "";
  const dbChannel = channel === "WEBSITE_CHAT" ? "WIDGET" : channel;

  const contacts = await query<{ id: string; last_ref: string | null }>(
    `SELECT c.id,
            (SELECT s.reference FROM shipments s WHERE s.id = c.last_shipment_id) AS last_ref
       FROM channel_contacts c
      WHERE c.channel = $1 AND c.external_id = $2
      LIMIT 1`,
    [dbChannel, extId],
  );
  const contact = contacts[0] ?? null;

  if (trimmedRef) {
    // Preserve pre-booking chat turns from this same session once the newly
    // created shipment is linked, so the conversation never resets mid-chat.
    const includeSessionPreBooking =
      contact !== null &&
      contact.last_ref !== null &&
      contact.last_ref.toUpperCase() === trimmedRef;

    const rows = includeSessionPreBooking
      ? await query<{ direction: string; body: string; created_at: Date }>(
          `SELECT m.direction, m.body, m.created_at
             FROM communications m
             LEFT JOIN shipments s ON s.id = m.shipment_id
            WHERE (upper(s.reference) = $1
                   AND m.channel IN ('WIDGET', 'PORTAL', 'WHATSAPP', 'TELEGRAM'))
               OR (m.contact_id = $2 AND m.shipment_id IS NULL)
            ORDER BY m.created_at`,
          [trimmedRef, contact.id],
        )
      : await query<{ direction: string; body: string; created_at: Date }>(
          `SELECT m.direction, m.body, m.created_at
             FROM communications m
             JOIN shipments s ON s.id = m.shipment_id
            WHERE upper(s.reference) = $1
              AND m.channel IN ('WIDGET', 'PORTAL', 'WHATSAPP', 'TELEGRAM')
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

/** Route any message arriving through Website Chat, WhatsApp, or Telegram
 *  through the server-side Action Controller -> AI Customer Support Agent
 *  AND straight into the backend Autonomous Agent. */
export async function askQuestion(
  reference: string,
  question: string,
  sessionKey?: string,
  channel: "WEBSITE_CHAT" | "WHATSAPP" | "TELEGRAM" = "WEBSITE_CHAT",
): Promise<{
  ok: boolean;
  error?: string;
  reply?: string;
  reference?: string | null;
  orderReference?: string | null;
  autonomousStarted?: boolean;
  intent?: string;
}> {
  await requireUser();

  try {
    const { handleFrontendLogisticsAction } = await import(
      "@/lib/controllers/action-controller"
    );
    const out = await handleFrontendLogisticsAction({
      intent: "SUPPORT_MESSAGE",
      payload: {
        channel,
        message: question,
        reference: reference.trim() || undefined,
        sessionKey,
      },
    });

    if (!out.ok) {
      return { ok: false, error: out.error ?? out.message };
    }

    revalidatePath("/support");
    revalidatePath("/orders");
    revalidatePath("/shipments");
    revalidatePath("/planning");
    revalidatePath("/exceptions");
    revalidatePath("/queue");
    revalidatePath("/activity");

    const verifiedShipment = out.shipmentReference
      ? await lookupShipment(out.shipmentReference).catch(() => null)
      : null;
    const verifiedReference = verifiedShipment?.reference ?? null;
    const autonomousStarted =
      Boolean(out.startedWork) &&
      (Boolean(out.orderReference) || out.intent !== "TRACKING_INQUIRY");

    return {
      ok: true,
      reply: out.reply,
      reference: verifiedReference,
      orderReference: out.orderReference ?? null,
      autonomousStarted,
      intent: out.intent,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }
}
