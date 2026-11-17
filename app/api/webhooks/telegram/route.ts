import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  processOmnichannelSupportTurn,
  resolveDefaultOrgId,
} from "@/lib/agents/autonomous";

export const dynamic = "force-dynamic";

type TelegramUpdate = {
  message?: {
    chat?: { id?: number | string; first_name?: string; username?: string };
    from?: { first_name?: string; last_name?: string; username?: string };
    text?: string;
  };
  chatId?: number | string;
  name?: string;
  text?: string;
  messageText?: string;
  reference?: string;
};

async function sendTelegramReply(chatId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4096),
      }),
    });
  } catch (err) {
    console.warn("[Telegram Webhook] Failed sending outbound Telegram reply:", err);
  }
}

export async function POST(req: NextRequest) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (expectedSecret) {
    const provided = req.headers.get("x-telegram-bot-api-secret-token");
    if (provided !== expectedSecret) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let body: TelegramUpdate;
  try {
    body = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const chatId = String(body.message?.chat?.id ?? body.chatId ?? "").trim();
  const text = String(body.message?.text ?? body.text ?? body.messageText ?? "").trim();
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

  if (out.ok && out.reply) {
    await sendTelegramReply(chatId, out.reply);
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
