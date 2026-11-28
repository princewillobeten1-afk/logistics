import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { processOmnichannelSupportTurn } from "@/lib/agents/autonomous";
import {
  getStoredTelegramToken,
  sendTelegramBotMessage,
} from "@/lib/channels/telegram";
import { checkDistributedTenantRateLimit } from "@/lib/distributed-guard";
import {
  claimWorkspaceWebhookDelivery,
  resolveOrgByWebhookToken,
  verifyWorkspaceTelegramSecret,
} from "@/lib/workspace-admin";

export const dynamic = "force-dynamic";

type TelegramUpdate = {
  update_id?: number | string;
  message?: {
    message_id?: number | string;
    chat?: { id?: number | string; first_name?: string; username?: string };
    from?: { first_name?: string; last_name?: string; username?: string; is_bot?: boolean };
    text?: string;
    caption?: string;
  };
  chatId?: number | string;
  name?: string;
  text?: string;
  messageText?: string;
  reference?: string;
};

export async function POST(req: NextRequest) {
  const workspaceToken =
    req.nextUrl.searchParams.get("workspace")?.trim() ||
    req.nextUrl.searchParams.get("token")?.trim() ||
    null;

  if (!workspaceToken) {
    return NextResponse.json(
      { error: "Workspace webhook token is required (?workspace=<token>)." },
      { status: 401 },
    );
  }

  const org = await resolveOrgByWebhookToken(workspaceToken);
  if (!org) {
    return NextResponse.json(
      { error: "Unknown workspace webhook token." },
      { status: 401 },
    );
  }

  const providedSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (!verifyWorkspaceTelegramSecret(org, providedSecret)) {
    return NextResponse.json(
      { error: "Invalid or missing Telegram webhook secret token." },
      { status: 403 },
    );
  }

  const rate = await checkDistributedTenantRateLimit(org.id, "webhook:telegram", 120, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Workspace Telegram webhook rate limit exceeded." },
      { status: 429 },
    );
  }

  let body: TelegramUpdate;
  try {
    body = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  if (body.message?.from?.is_bot) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const deliveryId =
    body.update_id != null
      ? `upd:${body.update_id}`
      : body.message?.message_id != null
        ? `msg:${body.message.message_id}`
        : null;
  if (deliveryId) {
    const fresh = await claimWorkspaceWebhookDelivery(org.id, "TELEGRAM", deliveryId);
    if (!fresh) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
  }

  const chatId = String(body.message?.chat?.id ?? body.chatId ?? "").trim();
  const text = String(
    body.message?.text ?? body.message?.caption ?? body.text ?? body.messageText ?? "",
  ).trim();
  const displayName =
    body.name?.trim() ||
    [body.message?.from?.first_name, body.message?.from?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    body.message?.from?.username ||
    body.message?.chat?.username ||
    (chatId ? `Telegram ${chatId}` : "Telegram User");

  if (!chatId || !text) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const out = await processOmnichannelSupportTurn({
    sourceChannel: "TELEGRAM",
    externalId: chatId,
    displayName,
    message: text,
    reference: body.reference ?? null,
    orgId: org.id,
    actorEmail: `telegram:${chatId}`,
  });

  const token = await getStoredTelegramToken(org.id);
  if (token) {
    const replyText =
      out.ok && out.reply
        ? out.reply
        : "Thanks for reaching out. Share a shipment reference (like LG-10421) or your origin and destination cities so I can help.";
    const sent = await sendTelegramBotMessage(token, chatId, replyText);
    if (!sent.ok) {
      console.warn("[Telegram Webhook] Failed sending outbound Telegram reply:", sent.error);
    }
  }

  revalidatePath("/support");
  revalidatePath("/orders");
  revalidatePath("/shipments");
  revalidatePath("/planning");
  revalidatePath("/exceptions");
  revalidatePath("/queue");
  revalidatePath("/activity");

  if (!out.ok) {
    return NextResponse.json(
      { ok: false, error: out.error ?? "Could not process Telegram message." },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    chatId,
    reply: out.reply,
    reference: out.reference,
    orderReference: out.orderReference,
    intent: out.autonomous?.intent ?? null,
    startedWork: Boolean(out.autonomous?.startedWork),
  });
}
