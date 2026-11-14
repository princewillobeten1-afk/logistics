import { pool } from "./db";

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
  try {
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
        [
          entry.actor,
          entry.actorType ?? "USER",
          entry.action,
          entry.entityType ?? null,
          entry.entityId ?? null,
          entry.before ? JSON.stringify(entry.before) : null,
          entry.after ? JSON.stringify(entry.after) : null,
          entry.ip ?? null,
          entry.userAgent?.slice(0, 500) ?? null,
        ],
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
