"use server";

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";

/** Channel management runs through the Python layer via a queued step, for the
 *  same reason support replies do: credential encryption, provider
 *  verification and the Fernet key all live there. Re-implementing any of it
 *  in TypeScript would put a second copy of the security-critical half of this
 *  feature somewhere it could drift.
 *
 *  The form writes an intent row; `channels.configure` picks it up, verifies
 *  against the real service, and stores the result. The page shows the outcome. */
/** Queue one channel-configuration intent. The dedupe key keeps a
 *  double-submitted form to one work item; it is unique per organisation
 *  (migration 019), so two companies configuring Telegram do not collide. */
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
  // Channel credentials are how customers reach this company, and a bot token
  // is a live secret. Administrators only.
  const user = await requireRole("ADMINISTER");

  const channel = String(formData.get("channel") ?? "");
  if (!channel) return;

  const submitted: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key === "channel" || key === "action") continue;
    submitted[key] = String(value);
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
    // The field *names* only. Values are credentials, and an audit log that
    // records a bot token is a second place the token can leak from.
    after: { channel, fields: Object.keys(submitted) },
  });

  revalidatePath("/settings");
}

export async function toggleChannel(formData: FormData): Promise<void> {
  const user = await requireRole("ADMINISTER");

  const channel = String(formData.get("channel") ?? "");
  const enable = String(formData.get("enable")) === "true";
  if (!channel) return;

  await enqueueChannelWork(channel, `channel-toggle:${channel}`, {
    action: enable ? "enable" : "disable",
  });

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

  const channel = String(formData.get("channel") ?? "");
  if (!channel) return;

  await enqueueChannelWork(channel, `channel-disconnect:${channel}`, {
    action: "disconnect",
  });

  await recordAudit({
    actor: user.email,
    orgId: user.orgId,
    action: "CHANNEL_DISABLED",
    entityType: "channel",
    after: { channel, disconnected: true },
  });

  revalidatePath("/settings");
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
