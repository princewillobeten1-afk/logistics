import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  processOmnichannelSupportTurn,
  resolveDefaultOrgId,
} from "@/lib/agents/autonomous";
import {
  getStoredTelegramToken,
  sendTelegramBotMessage,
} from "@/lib/channels/telegram";

export const dynamic = "force-dynamic";

type TelegramUpdate = {
  message?: {
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

function secretMatches(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (expectedSecret) {
    const provided = req.headers.get("x-telegram-bot-api-secret-token");
    if (!secretMatches(expectedSecret, provided)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
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

  const orgId = await resolveDefaultOrgId();
  const out = await processOmnichannelSupportTurn({
    sourceChannel: "TELEGRAM",
    externalId: chatId,
    displayName,
    message: text,
    reference: body.reference ?? null,
    orgId,
    actorEmail: `telegram:${chatId}`,
  });

  const token = await getStoredTelegramToken(orgId);
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
