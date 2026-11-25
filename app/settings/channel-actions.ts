"use server";

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { requireRole } from "@/lib/auth";
import {
  configureTelegramChannelInDb,
  syncTelegramUpdatesNow,
  triggerTelegramPollNow,
} from "@/lib/channels/telegram";
import { query } from "@/lib/db";

async function enqueueChannelWork(
  channel: string,
  key: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO work_items (kind, payload, priority, dedupe_key)
     VALUES ('channels.configure', $1, 1, $2)
     ON CONFLICT (org_id, dedupe_key) DO UPDATE SET payload = EXCLUDED.payload,
                                                    state = 'PENDING',
                                                    run_after = now(),
                                                    attempts = 0`,
    [JSON.stringify({ channel, ...payload }), key],
  );
}

export async function saveChannel(formData: FormData): Promise<void> {
  const user = await requireRole("ADMINISTER");

  const channel = String(formData.get("channel") ?? "").trim().toUpperCase();
  if (!channel) return;

  const submitted: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key === "channel" || key === "action") continue;
    submitted[key] = String(value);
  }

  if (channel === "TELEGRAM") {
    const res = await configureTelegramChannelInDb({
      orgId: user.orgId,
      fields: submitted,
    });

    await recordAudit({
      actor: user.email,
      orgId: user.orgId,
      action: res.ok ? "CHANNEL_CONFIGURED" : "CHANNEL_CONFIGURATION_FAILED",
      entityType: "channel",
      after: {
        channel,
        ok: res.ok,
        username: res.username ?? null,
        fields: Object.keys(submitted),
      },
    });

    if (res.ok) {
      triggerTelegramPollNow();
      await syncTelegramUpdatesNow({ orgId: user.orgId, longPollTimeoutSec: 0 });
    }

    revalidatePath("/settings");
    revalidatePath("/support");
    return;
  }

  await enqueueChannelWork(channel, `channel-config:${channel}`, {
    action: "save",
    fields: submitted,
  });

  await recordAudit({
    actor: user.email,
    orgId: user.orgId,
    action: "CHANNEL_CONFIGURED",
    entityType: "channel",
    after: { channel, fields: Object.keys(submitted) },
  });

  revalidatePath("/settings");
}

export async function toggleChannel(formData: FormData): Promise<void> {
  const user = await requireRole("ADMINISTER");

  const channel = String(formData.get("channel") ?? "").trim().toUpperCase();
  const enable = String(formData.get("enable")) === "true";
  if (!channel) return;

  if (channel === "TELEGRAM") {
    await query(
      `UPDATE channel_connections SET enabled = $1 WHERE channel = $2`,
      [enable, channel],
    );
    if (enable) {
      triggerTelegramPollNow();
      await syncTelegramUpdatesNow({ orgId: user.orgId, longPollTimeoutSec: 0 });
    }
  } else {
    await enqueueChannelWork(channel, `channel-toggle:${channel}`, {
      action: enable ? "enable" : "disable",
    });
  }

  await recordAudit({
    actor: user.email,
    orgId: user.orgId,
    action: enable ? "CHANNEL_CONFIGURED" : "CHANNEL_DISABLED",
    entityType: "channel",
    after: { channel, enabled: enable },
  });

  revalidatePath("/settings");
}

export async function disconnectChannel(formData: FormData): Promise<void> {
  const user = await requireRole("ADMINISTER");

  const channel = String(formData.get("channel") ?? "").trim().toUpperCase();
  if (!channel) return;

  if (channel === "TELEGRAM") {
    await query(
      `UPDATE channel_connections
          SET credentials = NULL,
              config = '{}'::jsonb,
              enabled = false,
              state = 'UNCONFIGURED',
              verified_at = NULL,
              last_error = NULL,
              cursor = NULL
        WHERE channel = $1`,
      [channel],
    );
  } else {
    await enqueueChannelWork(channel, `channel-disconnect:${channel}`, {
      action: "disconnect",
    });
  }

  await recordAudit({
    actor: user.email,
    orgId: user.orgId,
    action: "CHANNEL_DISABLED",
    entityType: "channel",
    after: { channel, disconnected: true },
  });

  revalidatePath("/settings");
}

export async function syncTelegramChannel(): Promise<void> {
  const user = await requireRole("ADMINISTER");
  triggerTelegramPollNow();
  await syncTelegramUpdatesNow({ orgId: user.orgId, longPollTimeoutSec: 0 });
  revalidatePath("/settings");
  revalidatePath("/support");
}

export type ChannelRow = {
  channel: string;
  display_name: string;
  state: string;
  enabled: boolean;
  config: Record<string, unknown>;
  has_credentials: boolean;
  verified_at: Date | null;
  last_inbound_at: Date | null;
  last_error: string | null;
};

/** Never selects `credentials`. The ciphertext has no business leaving the
 *  database, and a query that cannot fetch it cannot leak it. */
export async function listChannels(): Promise<ChannelRow[]> {
  return query<ChannelRow>(
    `SELECT channel, display_name, state, enabled, config,
            (credentials IS NOT NULL) AS has_credentials,
            verified_at, last_inbound_at, last_error
       FROM channel_connections
      ORDER BY array_position(ARRAY['TELEGRAM','WHATSAPP','GMAIL','WIDGET'], channel)`,
  );
}

export async function pendingChannelWork(): Promise<number> {
  const [row] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM work_items
      WHERE kind = 'channels.configure' AND state IN ('PENDING','RUNNING')`,
  );
  return Number(row?.n ?? 0);
}
