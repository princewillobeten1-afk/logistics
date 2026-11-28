import { queryAs } from "@/lib/db";
import {
  assertVerifiedOrgId,
  checkTenantRateLimit,
  claimWebhookDeliveryMemory,
} from "@/lib/tenant-guard";

export interface DistributedRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
  backend: "database" | "memory";
}

export type WebhookReplayChannel =
  | "WHATSAPP"
  | "TELEGRAM"
  | "EXTERNAL_INTAKE"
  | "INTEGRATION_WEBHOOK";

export interface DistributedReplayResult {
  fresh: boolean;
  backend: "database" | "memory";
}

const DEFAULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Distributed per-tenant rate limiter backed by PostgreSQL `tenant_rate_limits`
 * (using atomic INSERT ... ON CONFLICT DO UPDATE under RLS) so rate limits synchronize
 * across horizontally scaled server instances.
 *
 * Falls back cleanly to process-local rate limiting only if the database table is
 * not yet migrated in a legacy database.
 */
export async function checkDistributedTenantRateLimit(
  orgId: string,
  bucket: string,
  maxRequests: number,
  windowMs: number,
): Promise<DistributedRateLimitResult> {
  const verifiedOrgId = assertVerifiedOrgId(orgId, "checkDistributedTenantRateLimit");
  const safeMax = Math.max(1, Math.floor(maxRequests));
  const safeWindowMs = Math.max(1_000, Math.floor(windowMs));
  const now = Date.now();
  const windowStartMs = Math.floor(now / safeWindowMs) * safeWindowMs;
  const windowEndMs = windowStartMs + safeWindowMs;
  const expiresAtIso = new Date(windowEndMs + safeWindowMs).toISOString();

  try {
    const rows = await queryAs<{ hit_count: number | string }>(
      verifiedOrgId,
      `INSERT INTO tenant_rate_limits (org_id, bucket, window_start_ms, hit_count, expires_at)
       VALUES (app_current_org_id(), $1, $2, 1, $3::timestamptz)
       ON CONFLICT (org_id, bucket, window_start_ms)
       DO UPDATE SET hit_count = tenant_rate_limits.hit_count + 1,
                     expires_at = GREATEST(tenant_rate_limits.expires_at, EXCLUDED.expires_at),
                     updated_at = now()
       RETURNING hit_count`,
      [bucket, windowStartMs, expiresAtIso],
    );

    const count = Number(rows[0]?.hit_count ?? 1);
    if (count > safeMax) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((windowEndMs - now) / 1000)),
        backend: "database",
      };
    }

    // Opportunistic expired-window cleanup (~2% of calls)
    if (Math.random() < 0.02) {
      queryAs(
        verifiedOrgId,
        `DELETE FROM tenant_rate_limits WHERE expires_at < now()`,
        [],
      ).catch(() => {});
    }

    return {
      allowed: true,
      remaining: Math.max(0, safeMax - count),
      retryAfterSec: 0,
      backend: "database",
    };
  } catch {
    // Graceful fallback if tenant_rate_limits migration has not been applied yet
    const fallback = checkTenantRateLimit(verifiedOrgId, bucket, safeMax, safeWindowMs);
    return {
      ...fallback,
      backend: "memory",
    };
  }
}

/**
 * Distributed, atomic webhook replay protection backed by PostgreSQL `webhook_deliveries`
 * under tenant RLS (`ON CONFLICT (org_id, channel, delivery_id) DO NOTHING`).
 *
 * Ensures replayed provider webhooks or external intake deliveries are rejected consistently
 * across horizontally scaled server replicas without relying on process-local memory.
 */
export async function claimDistributedWebhookReplay(
  orgId: string,
  channel: WebhookReplayChannel,
  deliveryId: string,
  ttlMs = DEFAULT_REPLAY_TTL_MS,
): Promise<DistributedReplayResult> {
  const verifiedOrgId = assertVerifiedOrgId(orgId, "claimDistributedWebhookReplay");
  const normalizedId = deliveryId.trim();
  if (!normalizedId) {
    return { fresh: true, backend: "database" };
  }

  const safeTtlMs = Math.max(1_000, Math.floor(ttlMs));
  const expiresAtIso = new Date(Date.now() + safeTtlMs).toISOString();

  try {
    // Remove expired entry for this key if a previous TTL window elapsed
    await queryAs(
      verifiedOrgId,
      `DELETE FROM webhook_deliveries
        WHERE channel = $1
          AND delivery_id = $2
          AND expires_at IS NOT NULL
          AND expires_at < now()`,
      [channel, normalizedId],
    ).catch(() => {});

    const rows = await queryAs<{ id: string }>(
      verifiedOrgId,
      `INSERT INTO webhook_deliveries (org_id, channel, delivery_id, expires_at)
       VALUES (app_current_org_id(), $1, $2, $3::timestamptz)
       ON CONFLICT (org_id, channel, delivery_id) DO NOTHING
       RETURNING id`,
      [channel, normalizedId, expiresAtIso],
    );

    // Opportunistic expired-replay pruning (~2% of calls)
    if (Math.random() < 0.02) {
      queryAs(
        verifiedOrgId,
        `DELETE FROM webhook_deliveries WHERE expires_at IS NOT NULL AND expires_at < now()`,
        [],
      ).catch(() => {});
    }

    return {
      fresh: rows.length > 0,
      backend: "database",
    };
  } catch {
    // Graceful fallback only if legacy schema lacks expires_at or table
    try {
      const legacyRows = await queryAs<{ id: string }>(
        verifiedOrgId,
        `INSERT INTO webhook_deliveries (channel, delivery_id)
         VALUES ($1, $2)
         ON CONFLICT (org_id, channel, delivery_id) DO NOTHING
         RETURNING id`,
        [channel, normalizedId],
      );
      return {
        fresh: legacyRows.length > 0,
        backend: "database",
      };
    } catch {
      const fresh = claimWebhookDeliveryMemory(verifiedOrgId, channel, normalizedId, safeTtlMs);
      return { fresh, backend: "memory" };
    }
  }
}
