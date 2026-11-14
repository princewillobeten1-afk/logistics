import { Pool, type PoolClient } from "pg";

// Next dev reloads modules on every edit; without a global the pool would be
// recreated per reload and leak connections until Postgres refuses new ones.
const globalForPg = globalThis as unknown as { logisticsPool?: Pool };

export const pool =
  globalForPg.logisticsPool ??
  new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://logistics:logistics@localhost:5433/logistics",
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

if (process.env.NODE_ENV !== "production") globalForPg.logisticsPool = pool;

// The role application queries run as. It owns nothing and has no BYPASSRLS,
// which is the only reason migration 016's policies apply at all — the
// connection role is a superuser, and superusers ignore row level security
// entirely. See migrations/017_app_role.sql.
const APP_ROLE = "logistics_app";

/**
 * Run a callback on a connection pinned to one organisation.
 *
 * Both halves matter. SET ROLE makes the policies apply; app.current_org tells
 * them which tenant. Passing null for the org is not a bypass — it is the
 * fail-closed case, where every tenant-scoped table returns zero rows.
 */
async function withScope<T>(
  orgId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "ECONNREFUSED" || err instanceof AggregateError) {
      const wrapped = new Error(
        "Database connection refused — ensure the Postgres container (logistics-pg) is running.",
        { cause: err },
      ) as Error & { code?: string };
      wrapped.code = code ?? "ECONNREFUSED";
      throw wrapped;
    }
    throw err;
  }
  try {
    await client.query(`SET ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.current_org', $1, false)", [
      orgId ?? "",
    ]);
    return await fn(client);
  } finally {
    // Connections are reused. Without this the next request inherits the
    // previous tenant's scope, which is the exact leak the design exists to
    // prevent — so a failure here must retire the connection rather than
    // return it to the pool.
    try {
      await client.query(
        "RESET ROLE; SELECT set_config('app.current_org', '', false)",
      );
      client.release();
    } catch (err) {
      client.release(err as Error);
    }
  }
}

/**
 * The query every page and action uses. Scoped to the signed-in user's
 * organisation automatically, so no caller has to remember — and a caller with
 * no session gets an empty result rather than someone else's data.
 */
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  // Imported at call time rather than at the top of the file: lib/auth.ts
  // needs identityQuery from here, and a static import both ways is a cycle.
  const { currentUser } = await import("./auth");
  const user = await currentUser();
  return withScope(user?.orgId ?? null, async (client) => {
    const result = await client.query(text, params);
    return result.rows as T[];
  });
}

/**
 * `query` for a caller that already knows its organisation.
 *
 * For the SSE stream. That runs long after the response headers are sent,
 * where `cookies()` is no longer available to read — and re-resolving the
 * session on every poll would mean two extra queries per client per tick for
 * an answer that cannot have changed.
 *
 * The org must come from a resolved session. Passing one in from a request
 * parameter would hand any caller any tenant's data, which is the single
 * mistake this whole layer exists to make impossible.
 */
export async function queryAs<T = Record<string, unknown>>(
  orgId: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withScope(orgId, async (client) => {
    const result = await client.query(text, params);
    return result.rows as T[];
  });
}

/**
 * A multi-statement transaction, scoped like `query`.
 *
 * For server actions that write more than one row and need them to land
 * together — deciding an approval writes three.
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const { currentUser } = await import("./auth");
  const user = await currentUser();
  return withScope(user?.orgId ?? null, async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/**
 * For `users`, `sessions` and `organisations` only — the three tables outside
 * row-level security, because resolving who someone is has to happen before
 * there is an organisation to scope to.
 *
 * Every caller keys on something unguessable or globally unique: a session
 * token, an email, an org slug. It runs as the unprivileged role like
 * everything else; it simply has no org to set yet.
 */
export async function identityQuery<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withScope(null, async (client) => {
    const result = await client.query(text, params);
    return result.rows as T[];
  });
}

/** True when Postgres is reachable — lets pages show a real message instead
 *  of a stack trace when the container is not running. */
export async function isReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
