import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  processOmnichannelSupportTurn,
  resolveDefaultOrgId,
} from "@/lib/agents/autonomous";
import { query, runWithOrgScope } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("hub.mode");
  const token = req.nextUrl.searchParams.get("hub.verify_token");
  const challenge = req.nextUrl.searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !challenge) {
    return NextResponse.json({ error: "Invalid verification request." }, { status: 400 });
  }

  const envToken = process.env.WHATSAPP_VERIFY_TOKEN?.trim();
  const orgId = await resolveDefaultOrgId();

  let dbToken: string | null = null;
  if (orgId) {
    await runWithOrgScope(orgId, async () => {
      const rows = await query<{ config: Record<string, unknown> }>(
        `SELECT config FROM channel_connections WHERE channel = 'WHATSAPP' LIMIT 1`,
      );
      const raw = rows[0]?.config?.verify_token;
      if (typeof raw === "string" && raw.trim()) dbToken = raw.trim();
    });
  }

  const expected = envToken || dbToken;
  if (expected && token !== expected) {
    return NextResponse.json({ error: "Invalid verify token." }, { status: 403 });
  }

  return new NextResponse(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

type WhatsAppWebhookBody = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          from?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
  from?: string;
  name?: string;
  text?: string;
  message?: string;
  reference?: string;
};

async function sendWhatsAppReply(to: string, text: string) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!accessToken || !phoneNumberId) return;

  try {
    await fetch(
      `https://graph.facebook.com/v20.0/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text.slice(0, 4096) },
        }),
      },
    );
  } catch (err) {
    console.warn("[WhatsApp Webhook] Failed sending outbound Cloud API reply:", err);
  }
}

export async function POST(req: NextRequest) {
  let payload: WhatsAppWebhookBody;
  try {
    payload = (await req.json()) as WhatsAppWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const inboundMessages: Array<{
    from: string;
    name: string;
    text: string;
    reference?: string;
  }> = [];

  if (Array.isArray(payload.entry)) {
    for (const entry of payload.entry) {
      for (const change of entry.changes ?? []) {
        const contacts = change.value?.contacts ?? [];
        for (const msg of change.value?.messages ?? []) {
          const bodyText = msg.text?.body?.trim();
          const from = msg.from?.trim();
          if (from && bodyText) {
            const matchedContact = contacts.find((c) => c.wa_id === from) ?? contacts[0];
            inboundMessages.push({
              from,
              name: matchedContact?.profile?.name?.trim() || `WhatsApp ${from}`,
              text: bodyText,
            });
          }
        }
      }
    }
  } else if ((payload.text || payload.message) && payload.from) {
    inboundMessages.push({
      from: payload.from.trim(),
      name: payload.name?.trim() || `WhatsApp ${payload.from.trim()}`,
      text: String(payload.text ?? payload.message ?? "").trim(),
      reference: payload.reference,
    });
  }

  if (inboundMessages.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  const orgId = await resolveDefaultOrgId();
  const results = [];

  for (const item of inboundMessages) {
    const out = await processOmnichannelSupportTurn({
      sourceChannel: "WHATSAPP",
      externalId: item.from,
      displayName: item.name,
      message: item.text,
      reference: item.reference ?? null,
      orgId,
      actorEmail: `whatsapp:${item.from}`,
    });

    if (out.ok && out.reply) {
      await sendWhatsAppReply(item.from, out.reply);
    }

    results.push({
      from: item.from,
      ok: out.ok,
      reply: out.reply,
      reference: out.reference,
      orderReference: out.orderReference,
      intent: out.autonomous?.intent ?? null,
      startedWork: Boolean(out.autonomous?.startedWork),
      error: out.error,
    });
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
    processed: results.length,
    results,
  });
}
