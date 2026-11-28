import { revalidatePath } from "next/cache";
import { processOmnichannelSupportTurn } from "@/lib/agents/autonomous";
import { identityQuery, query, runWithOrgScope } from "@/lib/db";
import { sealWebhookSecret, unsealWebhookSecret } from "@/lib/integrations/security";

export interface TelegramUpdateItem {
  update_id: number;
  message?: {
    message_id?: number;
    chat?: { id?: number | string; first_name?: string; username?: string; type?: string };
    from?: { id?: number | string; first_name?: string; last_name?: string; username?: string; is_bot?: boolean };
    text?: string;
    caption?: string;
  };
}

interface StoredChannelRow {
  channel: string;
  credentials: unknown;
  config: Record<string, unknown> | null;
  cursor: string | null;
  state: string;
  enabled: boolean;
}

export function sealTelegramCredentials(botToken: string): string {
  return sealWebhookSecret(JSON.stringify({ bot_token: botToken.trim() }));
}

export function extractBotTokenFromStored(
  rawCredentials: unknown,
  config?: Record<string, unknown> | null,
): string | null {
  if (rawCredentials != null) {
    const rawStr = Buffer.isBuffer(rawCredentials)
      ? rawCredentials.toString("utf8")
      : typeof rawCredentials === "string"
        ? rawCredentials
        : typeof rawCredentials === "object"
          ? JSON.stringify(rawCredentials)
          : "";
    if (rawStr) {
      const unsealed = unsealWebhookSecret(rawStr);
      try {
        const parsed = JSON.parse(unsealed) as { bot_token?: unknown };
        if (typeof parsed.bot_token === "string" && parsed.bot_token.trim()) {
          return parsed.bot_token.trim();
        }
      } catch {
        // Not JSON; ignore if unreadable ciphertext (e.g. Python Fernet without Fernet decoder)
      }
    }
  }

  const legacy = config?.bot_token;
  if (typeof legacy === "string" && legacy.trim()) {
    return legacy.trim();
  }
  return null;
}

export async function verifyTelegramBotToken(token: string): Promise<
  | { ok: true; botId: number; username: string; firstName: string }
  | { ok: false; error: string }
> {
  const clean = token.trim();
  if (!clean || !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(clean)) {
    return {
      ok: false,
      error: "Invalid bot token format. Paste the full token from @BotFather (e.g. 123456789:ABC...).",
    };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${clean}/getMe`, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      description?: string;
      result?: { id?: number; username?: string; first_name?: string };
    };
    if (!res.ok || !data.ok || !data.result) {
      return {
        ok: false,
        error: `Telegram rejected the token: ${data.description ?? `HTTP ${res.status}`}`,
      };
    }
    return {
      ok: true,
      botId: Number(data.result.id ?? 0),
      username: String(data.result.username ?? ""),
      firstName: String(data.result.first_name ?? "Support Bot"),
    };
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach Telegram API: ${err instanceof Error ? err.message : "network error"}`,
    };
  }
}

export async function clearTelegramWebhookForPolling(token: string): Promise<void> {
  try {
    await fetch(
      `https://api.telegram.org/bot${token.trim()}/deleteWebhook?drop_pending_updates=false`,
      {
        method: "POST",
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch {
    // Non-fatal: webhook may already be empty
  }
}

export async function sendTelegramBotMessage(
  token: string,
  chatId: string | number,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const cleanToken = token.trim();
  const cleanText = text.trim().slice(0, 4096);
  if (!cleanToken || !cleanText) {
    return { ok: false, error: "Missing Telegram bot token or message body." };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${cleanToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: cleanText,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { description?: string };
        if (body.description) detail = body.description;
      } catch {
        // Ignore parse failure
      }
      return { ok: false, error: detail };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error sending Telegram reply",
    };
  }
}

export async function getStoredTelegramToken(
  orgId?: string | null,
): Promise<string | null> {
  if (!orgId || !orgId.trim()) return null;
  try {
    const token = await runWithOrgScope(orgId.trim(), async () => {
      const rows = await query<StoredChannelRow>(
        `SELECT channel, credentials, config, cursor, state, enabled
           FROM channel_connections
          WHERE channel = $1
          LIMIT 1`,
        ["TELEGRAM"],
      );
      const row = rows[0];
      if (!row) return null;
      return extractBotTokenFromStored(row.credentials, row.config);
    });
    return token ?? null;
  } catch {
    return null;
  }
}

export async function configureTelegramChannelInDb({
  orgId,
  fields,
}: {
  orgId: string;
  fields: Record<string, string>;
}): Promise<{ ok: boolean; message: string; username?: string }> {
  return runWithOrgScope(orgId, async () => {
    const existingRows = await query<StoredChannelRow>(
      `SELECT channel, credentials, config, cursor, state, enabled
         FROM channel_connections
        WHERE channel = $1
        LIMIT 1`,
      ["TELEGRAM"],
    );
    const existing = existingRows[0];
    const submittedToken = (fields.bot_token ?? "").trim();
    const effectiveToken =
      submittedToken ||
      extractBotTokenFromStored(existing?.credentials, existing?.config) ||
      "";

    if (!effectiveToken) {
      const msg = "Bot token is required.";
      await query(
        `UPDATE channel_connections
            SET last_error = $1, state = 'ERROR', enabled = false
          WHERE channel = $2`,
        [msg, "TELEGRAM"],
      );
      return { ok: false, message: msg };
    }

    const verified = await verifyTelegramBotToken(effectiveToken);
    if (!verified.ok) {
      await query(
        `UPDATE channel_connections
            SET last_error = $1, state = 'ERROR', enabled = false
          WHERE channel = $2`,
        [verified.error, "TELEGRAM"],
      );
      return { ok: false, message: verified.error };
    }

    // Ensure Telegram delivers updates to our built-in polling loop cleanly
    await clearTelegramWebhookForPolling(effectiveToken);

    const sealed = sealTelegramCredentials(effectiveToken);
    const cleanConfig = {
      username: verified.username,
      bot_name: verified.firstName,
      link: verified.username ? `https://t.me/${verified.username}` : undefined,
      delivery: "polling",
    };

    await query(
      `UPDATE channel_connections
          SET credentials = $1,
              config = $2::jsonb,
              state = $3,
              verified_at = CASE WHEN $4 THEN now() ELSE verified_at END,
              last_error = $5,
              enabled = CASE WHEN $6 THEN true ELSE false END
        WHERE channel = $7`,
      [
        Buffer.from(sealed, "utf8"),
        JSON.stringify(cleanConfig),
        "VERIFIED",
        true,
        null,
        true,
        "TELEGRAM",
      ],
    );

    return {
      ok: true,
      username: verified.username,
      message: verified.username
        ? `Connected as @${verified.username}. Live polling is active.`
        : "Telegram bot verified and live.",
    };
  });
}

async function processSingleTelegramOrg(
  orgId: string,
  longPollTimeoutSec: number,
): Promise<{ polled: boolean; messagesProcessed: number; repliesSent: number }> {
  let token: string | null = null;
  let cursor: string | null = null;
  let config: Record<string, unknown> = {};
  let needsMigration = false;
  let needsMetadataBackfill = false;

  await runWithOrgScope(orgId, async () => {
    const rows = await query<StoredChannelRow>(
      `SELECT channel, credentials, config, cursor, state, enabled
         FROM channel_connections
        WHERE channel = $1
        LIMIT 1`,
      ["TELEGRAM"],
    );
    const row = rows[0];
    if (!row || !row.enabled || row.state !== "VERIFIED") return;

    config = { ...(row.config ?? {}) };
    token = extractBotTokenFromStored(row.credentials, config);
    if (!token) return;

    if (!row.credentials && typeof config.bot_token === "string") {
      needsMigration = true;
    }
    if (!config.username) {
      needsMetadataBackfill = true;
    }
    cursor = row.cursor ?? null;
  });

  if (!token) {
    return { polled: false, messagesProcessed: 0, repliesSent: 0 };
  }
  const activeToken: string = token;

  // One-time cleanup: move any legacy config.bot_token into sealed credentials and backfill @username
  if (needsMigration || needsMetadataBackfill) {
    const info = await verifyTelegramBotToken(activeToken);
    if (info.ok) {
      await clearTelegramWebhookForPolling(activeToken);
      const nextConfig: Record<string, unknown> = {
        ...config,
        username: info.username,
        bot_name: info.firstName,
        link: info.username ? `https://t.me/${info.username}` : undefined,
        delivery: "polling",
      };
      delete nextConfig.bot_token;
      const sealed = sealTelegramCredentials(activeToken);
      await runWithOrgScope(orgId, async () => {
        await query(
          `UPDATE channel_connections
              SET credentials = $1,
                  config = $2::jsonb,
                  state = $3,
                  verified_at = CASE WHEN $4 THEN now() ELSE verified_at END,
                  last_error = $5,
                  enabled = CASE WHEN $6 THEN true ELSE false END
            WHERE channel = $7`,
          [
            Buffer.from(sealed, "utf8"),
            JSON.stringify(nextConfig),
            "VERIFIED",
            false,
            null,
            true,
            "TELEGRAM",
          ],
        );
      });
    }
  }

  const params = new URLSearchParams({
    timeout: String(longPollTimeoutSec),
    allowed_updates: JSON.stringify(["message"]),
  });
  if (cursor && /^\d+$/.test(cursor)) {
    params.set("offset", cursor);
  }

  let updates: TelegramUpdateItem[] = [];
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${activeToken}/getUpdates?${params.toString()}`,
      {
        method: "GET",
        signal: AbortSignal.timeout((longPollTimeoutSec + 8) * 1000),
      },
    );
    const body = (await res.json()) as {
      ok?: boolean;
      error_code?: number;
      description?: string;
      result?: TelegramUpdateItem[];
    };

    if (!res.ok || !body.ok) {
      if (body.error_code === 409) {
        // Webhook is actively configured externally; clear it only if bot is in polling mode
        await clearTelegramWebhookForPolling(activeToken);
        return { polled: true, messagesProcessed: 0, repliesSent: 0 };
      }
      if (body.error_code === 401 || body.error_code === 404) {
        await runWithOrgScope(orgId, async () => {
          await query(
            `UPDATE channel_connections
                SET last_error = $1, state = 'ERROR', enabled = false
              WHERE channel = $2`,
            [`Telegram rejected bot token: ${body.description ?? res.status}`, "TELEGRAM"],
          );
        });
      }
      return { polled: false, messagesProcessed: 0, repliesSent: 0 };
    }

    updates = Array.isArray(body.result) ? body.result : [];
  } catch {
    return { polled: false, messagesProcessed: 0, repliesSent: 0 };
  }

  if (updates.length === 0) {
    return { polled: true, messagesProcessed: 0, repliesSent: 0 };
  }

  // Persist advanced cursor immediately so duplicate updates cannot replay
  const maxUpdateId = updates.reduce(
    (max, u) => (typeof u.update_id === "number" && u.update_id > max ? u.update_id : max),
    0,
  );
  const nextCursor = String(maxUpdateId + 1);
  await runWithOrgScope(orgId, async () => {
    await query(
      `UPDATE channel_connections
          SET cursor = $1, last_inbound_at = now(), last_error = NULL
        WHERE channel = $2`,
      [nextCursor, "TELEGRAM"],
    );
  });

  let messagesProcessed = 0;
  let repliesSent = 0;

  for (const update of updates) {
    const msg = update.message;
    const chatId = msg?.chat?.id != null ? String(msg.chat.id).trim() : "";
    const text = (msg?.text ?? msg?.caption ?? "").trim();
    if (!chatId || msg?.from?.is_bot) continue;

    const displayName =
      [msg?.from?.first_name, msg?.from?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      msg?.from?.username ||
      msg?.chat?.username ||
      `Telegram ${chatId}`;

    if (!text) {
      const sent = await sendTelegramBotMessage(
        activeToken,
        chatId,
        "I currently read text messages. Please type your shipment reference (for example LG-10421) or tell me what you'd like to ship or check.",
      );
      if (sent.ok) repliesSent += 1;
      messagesProcessed += 1;
      continue;
    }

    const out = await processOmnichannelSupportTurn({
      sourceChannel: "TELEGRAM",
      externalId: chatId,
      displayName,
      message: text,
      reference: null,
      orgId,
      actorEmail: `telegram:${chatId}`,
    });

    const replyToSend = out.ok && out.reply
      ? out.reply
      : "Thanks for your message. Please share a shipment reference (such as LG-10421) or your origin and destination cities so I can assist you.";

    const sent = await sendTelegramBotMessage(activeToken, chatId, replyToSend);
    if (sent.ok) {
      repliesSent += 1;
    } else if (sent.error) {
      await runWithOrgScope(orgId, async () => {
        await query(
          `UPDATE channel_connections SET last_error = $1 WHERE channel = $2`,
          [`Failed replying on Telegram: ${sent.error}`, "TELEGRAM"],
        );
      });
    }
    messagesProcessed += 1;
  }

  if (messagesProcessed > 0) {
    try {
      revalidatePath("/support");
      revalidatePath("/orders");
      revalidatePath("/shipments");
      revalidatePath("/planning");
      revalidatePath("/exceptions");
      revalidatePath("/queue");
      revalidatePath("/activity");
      revalidatePath("/settings");
    } catch {
      // Safe when invoked from background timer outside request scope
    }
  }

  return { polled: true, messagesProcessed, repliesSent };
}

export async function syncTelegramUpdatesNow(opts?: {
  orgId?: string | null;
  longPollTimeoutSec?: number;
}): Promise<{
  orgsChecked: number;
  botsPolled: number;
  messagesProcessed: number;
  repliesSent: number;
}> {
  const timeoutSec = Math.max(0, Math.min(25, opts?.longPollTimeoutSec ?? 0));
  let orgIds: string[] = [];

  if (opts?.orgId) {
    orgIds = [opts.orgId];
  } else {
    try {
      const rows = await identityQuery<{ id: string }>(
        `SELECT id FROM organisations WHERE active = true ORDER BY created_at ASC LIMIT 25`,
      );
      orgIds = rows.map((r) => r.id);
    } catch {
      orgIds = [];
    }
  }

  let botsPolled = 0;
  let messagesProcessed = 0;
  let repliesSent = 0;

  for (const orgId of orgIds) {
    try {
      const res = await processSingleTelegramOrg(orgId, timeoutSec);
      if (res.polled) botsPolled += 1;
      messagesProcessed += res.messagesProcessed;
      repliesSent += res.repliesSent;
    } catch {
      // Keep polling resilient across orgs
    }
  }

  return {
    orgsChecked: orgIds.length,
    botsPolled,
    messagesProcessed,
    repliesSent,
  };
}

interface TelegramPollerGlobal {
  running: boolean;
  wakeResolve: (() => void) | null;
}

const globalForTelegram = globalThis as typeof globalThis & {
  __telegramPollerState?: TelegramPollerGlobal;
};

function getPollerState(): TelegramPollerGlobal {
  if (!globalForTelegram.__telegramPollerState) {
    globalForTelegram.__telegramPollerState = {
      running: false,
      wakeResolve: null,
    };
  }
  return globalForTelegram.__telegramPollerState;
}

function sleepOrWake(ms: number): Promise<void> {
  const state = getPollerState();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (state.wakeResolve === done) state.wakeResolve = null;
      resolve();
    }, ms);
    const done = () => {
      clearTimeout(timer);
      if (state.wakeResolve === done) state.wakeResolve = null;
      resolve();
    };
    state.wakeResolve = done;
  });
}

export function triggerTelegramPollNow(): void {
  ensureTelegramPollerRunning();
  const state = getPollerState();
  if (state.wakeResolve) {
    state.wakeResolve();
  } else {
    void syncTelegramUpdatesNow({ longPollTimeoutSec: 0 });
  }
}

export function ensureTelegramPollerRunning(): void {
  const state = getPollerState();
  if (state.running) return;
  state.running = true;

  const loop = async () => {
    while (state.running) {
      let polledAny = false;
      try {
        // Short poll timeout (4s) keeps loop responsive while minimizing idle wait
        const summary = await syncTelegramUpdatesNow({ longPollTimeoutSec: 4 });
        polledAny = summary.botsPolled > 0;
      } catch {
        polledAny = false;
      }
      await sleepOrWake(polledAny ? 400 : 5_000);
    }
  };

  void loop();
}
