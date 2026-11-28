import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { processOmnichannelSupportTurn } from "@/lib/agents/autonomous";
import { query, runWithOrgScope } from "@/lib/db";
import { unsealWebhookSecret } from "@/lib/integrations/security";
import { checkDistributedTenantRateLimit } from "@/lib/distributed-guard";
import {
  constantTimeTokenEqual,
  verifyWhatsAppHmacSignature,
} from "@/lib/tenant-guard";
import {
  claimWorkspaceWebhookDelivery,
  resolveOrgByWebhookToken,
  resolveOrgByWhatsAppPhoneId,
  unsealWorkspaceWhatsAppSecret,
  type ResolvedOrgWebhookRow,
} from "@/lib/workspace-admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("hub.mode");
  const token = req.nextUrl.searchParams.get("hub.verify_token");
  const challenge = req.nextUrl.searchParams.get("hub.challenge");
  const workspaceToken =
    req.nextUrl.searchParams.get("workspace")?.trim() ||
    req.nextUrl.searchParams.get("token")?.trim() ||
    null;

  if (mode !== "subscribe" || !challenge || !token) {
    return NextResponse.json(
      { error: "Invalid verification request." },
      { status: 400 },
    );
  }

  if (!workspaceToken) {
    return NextResponse.json(
      { error: "Workspace webhook token is required (?workspace=<token>)." },
      { status: 401 },
    );
  }

  const org = await resolveOrgByWebhookToken(workspaceToken);
  if (!org) {
    return NextResponse.json({ error: "Unknown workspace." }, { status: 403 });
  }

  let expectedVerifyToken = org.whatsapp_verify_token?.trim() || null;
  if (!expectedVerifyToken) {
    await runWithOrgScope(org.id, async () => {
      const rows = await query<{ config: Record<string, unknown> }>(
        `SELECT config FROM channel_connections WHERE channel = 'WHATSAPP' LIMIT 1`,
      );
      const raw = rows[0]?.config?.verify_token;
      if (typeof raw === "string" && raw.trim()) {
        expectedVerifyToken = raw.trim();
      }
    });
  }

  if (!expectedVerifyToken || !constantTimeTokenEqual(expectedVerifyToken, token)) {
    return NextResponse.json(
      { error: "Invalid verify token." },
      { status: 403 },
    );
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
        metadata?: {
          phone_number_id?: string;
          display_phone_number?: string;
        };
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          id?: string;
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
  messageId?: string;
};

async function sendWorkspaceWhatsAppReply(
  org: ResolvedOrgWebhookRow,
  to: string,
  text: string,
) {
  let accessToken: string | null = null;
  let phoneNumberId: string | null = org.whatsapp_phone_number_id ?? null;

  await runWithOrgScope(org.id, async () => {
    const rows = await query<{
      credentials: unknown;
      config: Record<string, unknown> | null;
    }>(
      `SELECT credentials, config FROM channel_connections WHERE channel = 'WHATSAPP' LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return;
    if (typeof row.config?.phone_number_id === "string" && row.config.phone_number_id.trim()) {
      phoneNumberId = phoneNumberId ?? row.config.phone_number_id.trim();
    }
    if (row.credentials != null) {
      const raw = Buffer.isBuffer(row.credentials)
        ? row.credentials.toString("utf8")
        : typeof row.credentials === "string"
          ? row.credentials
          : "";
      if (raw) {
        try {
          const parsed = JSON.parse(unsealWebhookSecret(raw)) as {
            access_token?: string;
          };
          if (typeof parsed.access_token === "string" && parsed.access_token.trim()) {
            accessToken = parsed.access_token.trim();
          }
        } catch {
          // Ignore unreadable sealed credentials
        }
      }
    }
  });

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
  const rawBody = await req.text();
  if (!rawBody || rawBody.length > 512_000) {
    return NextResponse.json(
      { error: "Invalid or oversized webhook payload." },
      { status: 400 },
    );
  }

  let payload: WhatsAppWebhookBody;
  try {
    payload = JSON.parse(rawBody) as WhatsAppWebhookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const workspaceToken =
    req.nextUrl.searchParams.get("workspace")?.trim() ||
    req.nextUrl.searchParams.get("token")?.trim() ||
    null;

  // Extract Meta phone_number_id if present in payload metadata
  let payloadPhoneNumberId: string | null = null;
  if (Array.isArray(payload.entry)) {
    for (const entry of payload.entry) {
      for (const change of entry.changes ?? []) {
        const pid = change.value?.metadata?.phone_number_id?.trim();
        if (pid) {
          payloadPhoneNumberId = pid;
          break;
        }
      }
      if (payloadPhoneNumberId) break;
    }
  }

  const [orgFromToken, orgFromPhone] = await Promise.all([
    workspaceToken ? resolveOrgByWebhookToken(workspaceToken) : Promise.resolve(null),
    payloadPhoneNumberId
      ? resolveOrgByWhatsAppPhoneId(payloadPhoneNumberId)
      : Promise.resolve(null),
  ]);

  if (orgFromToken && orgFromPhone && orgFromToken.id !== orgFromPhone.id) {
    return NextResponse.json(
      { error: "Webhook workspace token does not match WhatsApp phone_number_id." },
      { status: 403 },
    );
  }

  const org = orgFromToken ?? orgFromPhone;
  if (!org) {
    return NextResponse.json(
      { error: "Unrecognized workspace webhook credentials." },
      { status: 401 },
    );
  }

  // Cryptographic HMAC-SHA256 verification against raw body using workspace secret
  const appSecret = unsealWorkspaceWhatsAppSecret(org);
  const sigHeader = req.headers.get("x-hub-signature-256");
  if (!appSecret || !verifyWhatsAppHmacSignature(rawBody, sigHeader, appSecret)) {
    return NextResponse.json(
      { error: "Invalid or missing WhatsApp webhook signature." },
      { status: 403 },
    );
  }

  const rate = await checkDistributedTenantRateLimit(org.id, "webhook:whatsapp", 120, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Workspace webhook rate limit exceeded." },
      { status: 429 },
    );
  }

  const inboundMessages: Array<{
    id: string | null;
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
              id: msg.id?.trim() || null,
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
      id: payload.messageId?.trim() || null,
      from: payload.from.trim(),
      name: payload.name?.trim() || `WhatsApp ${payload.from.trim()}`,
      text: String(payload.text ?? payload.message ?? "").trim(),
      reference: payload.reference,
    });
  }

  if (inboundMessages.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  const results = [];

  for (const item of inboundMessages) {
    if (item.id) {
      const fresh = await claimWorkspaceWebhookDelivery(org.id, "WHATSAPP", item.id);
      if (!fresh) {
        results.push({ from: item.from, ok: true, duplicate: true });
        continue;
      }
    }

    const out = await processOmnichannelSupportTurn({
      sourceChannel: "WHATSAPP",
      externalId: item.from,
      displayName: item.name,
      message: item.text,
      reference: item.reference ?? null,
      orgId: org.id,
      actorEmail: `whatsapp:${item.from}`,
    });

    if (out.ok && out.reply) {
      await sendWorkspaceWhatsAppReply(org, item.from, out.reply);
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
