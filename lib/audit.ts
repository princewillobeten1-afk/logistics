import { isIP } from "node:net";
import { pool } from "./db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeAuditEntityId(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

export function sanitizeAuditIp(value?: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim() ?? "";
  return isIP(first) ? first : null;
}

/**
 * Writes to `audit_logs` — what a *principal* did, as distinct from what the
 * system did to a shipment. Mirrors src/logistics/audit.py; both write the
 * same table.
 *
 * The org is passed explicitly rather than read from the session, because the
 * two cases that matter most happen when there is no session yet: a failed
 * sign-in, and a sign-in that succeeds.
 */
export async function recordAudit(entry: {
  actor: string;
  action: string;
  orgId: string | null;
  actorType?: "USER" | "AGENT" | "SYSTEM" | "INTEGRATION";
  entityType?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  // A failed audit write must not roll back the action it describes: losing
  // the record of an approval is bad, but refusing an approval that already
  // happened is worse.
  const uuidEntityId = sanitizeAuditEntityId(entry.entityId);
  const safeIp = sanitizeAuditIp(entry.ip);
  const afterPayload =
    entry.entityId && !uuidEntityId
      ? {
          ...(entry.after && typeof entry.after === "object"
            ? (entry.after as Record<string, unknown>)
            : { value: entry.after ?? null }),
          externalEntityId: entry.entityId,
        }
      : entry.after;

  const values = [
    entry.actor,
    entry.actorType ?? "USER",
    entry.action,
    entry.entityType ?? null,
    uuidEntityId,
    entry.before ? JSON.stringify(entry.before) : null,
    afterPayload !== undefined && afterPayload !== null
      ? JSON.stringify(afterPayload)
      : null,
    safeIp,
    entry.userAgent?.slice(0, 500) ?? null,
  ];

  try {
    if (!process.env.DATABASE_URL?.trim()) {
      if (entry.orgId) {
        await pool.query(
          `INSERT INTO audit_logs
             (actor, actor_type, action, entity_type, entity_id,
              before, after, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          values,
        );
      }
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("SET ROLE logistics_app");
      await client.query("SELECT set_config('app.current_org', $1, false)", [
        entry.orgId ?? "",
      ]);
      // A failed sign-in has no organisation, so it has no row to belong to.
      // Recording it in the application log is the honest outcome — inventing
      // an org for it would put one tenant's noise in another's audit trail.
      if (!entry.orgId) {
        console.warn(
          `audit: ${entry.action} by ${entry.actor} (no organisation resolved)`,
        );
        return;
      }
      await client.query(
        `INSERT INTO audit_logs
           (actor, actor_type, action, entity_type, entity_id,
            before, after, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        values,
      );
    } finally {
      try {
        await client.query(
          "RESET ROLE; SELECT set_config('app.current_org', '', false)",
        );
        client.release();
      } catch (err) {
        client.release(err as Error);
      }
    }
  } catch (err) {
    console.error("audit: write failed", entry.action, err);
  }
}
