import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { handleFrontendLogisticsAction } from "@/lib/controllers/action-controller";
import { query, runWithOrgScope } from "@/lib/db";
import {
  detectWorkspaceTampering,
  hasDepartmentAccess,
} from "@/lib/tenant-guard";

export const dynamic = "force-dynamic";

const ALLOWED_CHANNELS = new Set([
  "WEBSITE_CHAT",
  "WIDGET",
  "WHATSAPP",
  "TELEGRAM",
]);

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }
  if (!hasDepartmentAccess(user, "SUPPORT")) {
    return NextResponse.json(
      { error: "Your department scope does not include Customer Support." },
      { status: 403 },
    );
  }

  const sessionKey = req.nextUrl.searchParams.get("sessionKey")?.trim() || `portal:${user.id}`;
  const rawChannel = (req.nextUrl.searchParams.get("channel") || "WEBSITE_CHAT").toUpperCase();
  const dbChannel = rawChannel === "WEBSITE_CHAT" ? "WIDGET" : ALLOWED_CHANNELS.has(rawChannel) ? rawChannel : "WIDGET";
  const reference = req.nextUrl.searchParams.get("reference")?.trim().toUpperCase() || "";

  return runWithOrgScope(user.orgId, async () => {
    if (reference) {
      const rows = await query<{ direction: string; body: string; created_at: Date }>(
        `SELECT m.direction, m.body, m.created_at
           FROM communications m
           JOIN shipments s ON s.id = m.shipment_id
          WHERE upper(s.reference) = $1
            AND m.channel IN ('WIDGET', 'PORTAL', 'WHATSAPP', 'TELEGRAM')
          ORDER BY m.created_at`,
        [reference],
      );
      return NextResponse.json({
        activeReference: reference,
        turns: rows.map((r) => ({
          role: r.direction === "INBOUND" ? "customer" : "agent",
          text: r.body,
          at: new Date(r.created_at).toISOString(),
        })),
      });
    }

    const contacts = await query<{ id: string; last_ref: string | null }>(
      `SELECT c.id,
              (SELECT s.reference FROM shipments s WHERE s.id = c.last_shipment_id) AS last_ref
         FROM channel_contacts c
        WHERE c.channel = $1 AND c.external_id = $2
        LIMIT 1`,
      [dbChannel, sessionKey],
    );

    const contact = contacts[0];
    if (!contact) {
      return NextResponse.json({ activeReference: null, turns: [] });
    }

    const rows = await query<{ direction: string; body: string; created_at: Date }>(
      `SELECT m.direction, m.body, m.created_at
         FROM communications m
        WHERE m.contact_id = $1
        ORDER BY m.created_at`,
      [contact.id],
    );

    return NextResponse.json({
      activeReference: contact.last_ref ?? null,
      turns: rows.map((r) => ({
        role: r.direction === "INBOUND" ? "customer" : "agent",
        text: r.body,
        at: new Date(r.created_at).toISOString(),
      })),
    });
  });
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasDepartmentAccess(user, "SUPPORT")) {
    return NextResponse.json(
      { error: "Your department scope does not include Customer Support." },
      { status: 403 },
    );
  }

  let body: {
    message?: string;
    reference?: string;
    sessionKey?: string;
    channel?: string;
  } & Record<string, unknown>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const tamper = detectWorkspaceTampering(req, user.orgId, body);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const rawChannel = String(body.channel || "WEBSITE_CHAT").toUpperCase();
  const sourceChannel = (
    ALLOWED_CHANNELS.has(rawChannel) ? rawChannel : "WEBSITE_CHAT"
  ) as "WEBSITE_CHAT" | "WIDGET" | "WHATSAPP" | "TELEGRAM";

  const { handleFrontendLogisticsAction } = await import(
    "@/lib/controllers/action-controller"
  );

  const out = await handleFrontendLogisticsAction({
    intent: "SUPPORT_MESSAGE",
    payload: {
      channel: sourceChannel,
      message: String(body.message ?? ""),
      reference: body.reference,
      sessionKey: body.sessionKey,
    },
  });

  if (!out.ok) {
    return NextResponse.json(
      { error: out.error ?? "Support agent request failed." },
      { status: out.status },
    );
  }

  revalidatePath("/support");
  revalidatePath("/orders");
  revalidatePath("/shipments");
  revalidatePath("/planning");
  revalidatePath("/exceptions");
  revalidatePath("/queue");
  revalidatePath("/activity");

  return NextResponse.json({
    ok: true,
    reply: out.reply,
    reference: out.shipmentReference ?? null,
    orderReference: out.orderReference ?? null,
    shouldEscalate: out.shouldEscalate,
    autonomousStarted: Boolean(out.startedWork),
    intent: out.intent,
  });
}
