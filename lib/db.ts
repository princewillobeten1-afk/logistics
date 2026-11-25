import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool, type PoolClient, type QueryResult } from "pg";

import {
  createEmptyOperationalState,
  reviveOperationalStateDates,
  type OperationalState,
} from "./local-store";

// Next dev reloads modules on every edit; without a global the pool would be
// recreated per reload and leak connections until Postgres refuses new ones.
const globalForPg = globalThis as unknown as {
  logisticsPool?: Pool;
  logisticsLocalStore?: LocalStore;
  logisticsLocalMtimeMs?: number;
  pgUnavailableUntil?: number;
};

const IS_TEST_RUNNER =
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.argv.includes("--test") ||
  process.execArgv.includes("--test");

const CUSTOM_LOCAL_STORE_PATH = process.env.LOGISTICS_LOCAL_STORE_PATH?.trim();
const LOCAL_STORE_PATH =
  CUSTOM_LOCAL_STORE_PATH || path.join(tmpdir(), "logistics-local-store.json");
const PERSIST_LOCAL_STORE = !IS_TEST_RUNNER || Boolean(CUSTOM_LOCAL_STORE_PATH);

type LocalOrg = { id: string; name: string; slug: string; active: boolean };
type LocalUser = {
  id: string;
  org_id: string;
  email: string;
  password_hash: string;
  role: string;
  name: string | null;
  active: boolean;
  last_login_at: Date | null;
};
type LocalSession = {
  token: string;
  user_id: string;
  expires_at: Date;
  ip_address: string | null;
  user_agent: string | null;
};
type LocalReset = {
  token: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
  ip_address: string | null;
};

type LocalStore = {
  orgs: LocalOrg[];
  users: LocalUser[];
  sessions: LocalSession[];
  resets: LocalReset[];
  data: OperationalState;
};

function reviveLocalStore(raw: unknown): LocalStore {
  const parsed = (raw ?? {}) as Partial<LocalStore>;
  return {
    orgs: Array.isArray(parsed.orgs) ? parsed.orgs : [],
    users: Array.isArray(parsed.users)
      ? parsed.users.map((u) => ({
          ...u,
          last_login_at: u.last_login_at ? new Date(u.last_login_at) : null,
        }))
      : [],
    sessions: Array.isArray(parsed.sessions)
      ? parsed.sessions.map((s) => ({
          ...s,
          expires_at: new Date(s.expires_at),
        }))
      : [],
    resets: Array.isArray(parsed.resets)
      ? parsed.resets.map((r) => ({
          ...r,
          expires_at: new Date(r.expires_at),
          created_at: new Date(r.created_at),
          used_at: r.used_at ? new Date(r.used_at) : null,
        }))
      : [],
    data: reviveOperationalStateDates(parsed.data),
  };
}

function getLocalStore(): LocalStore {
  if (PERSIST_LOCAL_STORE) {
    try {
      if (existsSync(LOCAL_STORE_PATH)) {
        const mtimeMs = statSync(LOCAL_STORE_PATH).mtimeMs;
        if (
          !globalForPg.logisticsLocalStore ||
          globalForPg.logisticsLocalMtimeMs !== mtimeMs
        ) {
          const parsed = JSON.parse(readFileSync(LOCAL_STORE_PATH, "utf8"));
          globalForPg.logisticsLocalStore = reviveLocalStore(parsed);
          globalForPg.logisticsLocalMtimeMs = mtimeMs;
        }
      }
    } catch {
      // Fall back to in-memory store if temp file read fails
    }
  }

  if (!globalForPg.logisticsLocalStore) {
    globalForPg.logisticsLocalStore = {
      orgs: [],
      users: [],
      sessions: [],
      resets: [],
      data: createEmptyOperationalState(),
    };
  }
  return globalForPg.logisticsLocalStore;
}

function saveLocalStore(store: LocalStore): void {
  globalForPg.logisticsLocalStore = store;
  if (!PERSIST_LOCAL_STORE) return;
  const tmpFile = `${LOCAL_STORE_PATH}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpFile, JSON.stringify(store), "utf8");
    renameSync(tmpFile, LOCAL_STORE_PATH);
    globalForPg.logisticsLocalMtimeMs = statSync(LOCAL_STORE_PATH).mtimeMs;
  } catch {
    try {
      unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
    // Ignore disk write issues in read-only environments
  }
}

const INACTIVE_STATES = new Set(["CLOSED", "CANCELLED", "FAILED"]);
const TERMINAL_OR_DELIVERED = new Set([
  "DELIVERED",
  "POD_VERIFIED",
  "CLOSED",
  "CANCELLED",
  "FAILED",
]);

function localQuery(
  text: string,
  params: unknown[] = [],
): QueryResult<Record<string, unknown>> {
  const sql = text.trim();
  const store = getLocalStore();
  const seed = store.data;

  const ok = (rows: Record<string, unknown>[], rowCount = rows.length) =>
    ({
      rows,
      rowCount,
      command: "SELECT",
      oid: 0,
      fields: [],
    }) as QueryResult<Record<string, unknown>>;

  const shipById = (id: string | null | undefined) =>
    id ? seed.shipments.find((s) => s.id === id) : undefined;

  // Session / role setup statements
  if (
    /^(BEGIN|COMMIT|ROLLBACK|SET ROLE|RESET ROLE|SELECT set_config)/i.test(sql)
  ) {
    return ok([], 0);
  }

  // Current session lookup
  if (/FROM sessions s\s+JOIN users u/i.test(sql)) {
    const token = String(params[0] ?? "");
    const now = Date.now();
    const session = store.sessions.find(
      (s) => s.token === token && s.expires_at.getTime() > now,
    );
    if (!session) return ok([]);
    const user = store.users.find((u) => u.id === session.user_id && u.active);
    if (!user) return ok([]);
    const org = store.orgs.find((o) => o.id === user.org_id && o.active);
    if (!org) return ok([]);
    return ok([
      {
        id: user.id,
        org_id: user.org_id,
        org_name: org.name,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    ]);
  }

  // User sign-in lookup
  if (/FROM users u JOIN organisations o[\s\S]*lower\(u\.email\)/i.test(sql)) {
    const email = String(params[0] ?? "").toLowerCase();
    const user = store.users.find((u) => u.email.toLowerCase() === email);
    if (!user) return ok([]);
    const org = store.orgs.find((o) => o.id === user.org_id);
    if (!org) return ok([]);
    return ok([
      {
        id: user.id,
        org_id: user.org_id,
        org_name: org.name,
        email: user.email,
        name: user.name,
        role: user.role,
        active: user.active,
        org_active: org.active,
        password_hash: user.password_hash,
      },
    ]);
  }

  // Fallback & active org lookup for external webhooks / background workers
  if (/FROM organisations\b/i.test(sql) && !/WHERE slug/i.test(sql) && !/JOIN/i.test(sql)) {
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    const limit = limitMatch ? Number(limitMatch[1]) : 25;
    const activeOnly = /active\s*=\s*true/i.test(sql);
    const orgs = (activeOnly ? store.orgs.filter((o) => o.active) : store.orgs).slice(0, limit);
    if (orgs.length > 0) {
      return ok(orgs.map((o) => ({ id: o.id, name: o.name })));
    }
    return ok([{ id: "00000000-0000-0000-0000-000000000001", name: "Operations Workspace" }]);
  }

  // Unique org slug check
  if (/FROM organisations WHERE slug = \$1/i.test(sql)) {
    const slug = String(params[0] ?? "");
    const n = store.orgs.filter((o) => o.slug === slug).length;
    return ok([{ n: String(n) }]);
  }

  // Insert organisation
  if (/INSERT INTO organisations/i.test(sql)) {
    const org: LocalOrg = {
      id: randomUUID(),
      name: String(params[0] ?? ""),
      slug: String(params[1] ?? ""),
      active: true,
    };
    store.orgs.push(org);
    saveLocalStore(store);
    return ok([{ id: org.id, name: org.name }], 1);
  }

  // Insert user
  if (/INSERT INTO users/i.test(sql)) {
    const email = String(params[1] ?? "").toLowerCase();
    if (store.users.some((u) => u.email.toLowerCase() === email)) {
      const err = new Error(
        "duplicate key value violates unique constraint",
      ) as Error & {
        code?: string;
        constraint?: string;
      };
      err.code = "23505";
      err.constraint = "users_email_idx";
      throw err;
    }
    const user: LocalUser = {
      id: randomUUID(),
      org_id: String(params[0] ?? ""),
      email,
      password_hash: String(params[2] ?? ""),
      role: "ADMIN",
      name: params[3] != null ? String(params[3]) : null,
      active: true,
      last_login_at: null,
    };
    store.users.push(user);
    saveLocalStore(store);
    return ok(
      [{ id: user.id, email: user.email, name: user.name, role: user.role }],
      1,
    );
  }

  // Insert session
  if (/INSERT INTO sessions/i.test(sql)) {
    store.sessions.push({
      token: String(params[0] ?? ""),
      user_id: String(params[1] ?? ""),
      expires_at:
        params[2] instanceof Date ? params[2] : new Date(String(params[2])),
      ip_address: params[3] != null ? String(params[3]) : null,
      user_agent: params[4] != null ? String(params[4]) : null,
    });
    saveLocalStore(store);
    return ok([], 1);
  }

  if (/UPDATE users SET last_login_at/i.test(sql)) {
    const id = String(params[0] ?? "");
    const user = store.users.find((u) => u.id === id);
    if (user) {
      user.last_login_at = new Date();
      saveLocalStore(store);
    }
    return ok([], user ? 1 : 0);
  }

  if (/DELETE FROM sessions WHERE token = \$1/i.test(sql)) {
    const token = String(params[0] ?? "");
    const before = store.sessions.length;
    store.sessions = store.sessions.filter((s) => s.token !== token);
    if (store.sessions.length !== before) saveLocalStore(store);
    return ok([], before - store.sessions.length);
  }

  if (/DELETE FROM sessions WHERE user_id = \$1/i.test(sql)) {
    const userId = String(params[0] ?? "");
    const before = store.sessions.length;
    store.sessions = store.sessions.filter((s) => s.user_id !== userId);
    if (store.sessions.length !== before) saveLocalStore(store);
    return ok([], before - store.sessions.length);
  }

  // Password resets
  if (/FROM password_resets[\s\S]*created_at >/i.test(sql)) {
    const userId = String(params[0] ?? "");
    const mins = Number(params[1] ?? 5);
    const cutoff = Date.now() - mins * 60_000;
    const n = store.resets.filter(
      (r) => r.user_id === userId && r.created_at.getTime() > cutoff,
    ).length;
    return ok([{ n: String(n) }]);
  }

  if (/INSERT INTO password_resets/i.test(sql)) {
    store.resets.push({
      token: String(params[0] ?? ""),
      user_id: String(params[1] ?? ""),
      expires_at:
        params[2] instanceof Date ? params[2] : new Date(String(params[2])),
      used_at: null,
      created_at: new Date(),
      ip_address: params[3] != null ? String(params[3]) : null,
    });
    saveLocalStore(store);
    return ok([], 1);
  }

  if (/FROM password_resets pr JOIN users u/i.test(sql)) {
    const token = String(params[0] ?? "");
    const reset = store.resets.find((r) => r.token === token);
    if (!reset) return ok([]);
    const user = store.users.find((u) => u.id === reset.user_id);
    if (!user) return ok([]);
    return ok([
      {
        user_id: reset.user_id,
        used_at: reset.used_at,
        expires_at: reset.expires_at,
        org_id: user.org_id,
        email: user.email,
      },
    ]);
  }

  if (/UPDATE users SET password_hash = \$1/i.test(sql)) {
    const hash = String(params[0] ?? "");
    const userId = String(params[1] ?? "");
    const user = store.users.find((u) => u.id === userId);
    if (user) {
      user.password_hash = hash;
      saveLocalStore(store);
    }
    return ok([], user ? 1 : 0);
  }

  if (/UPDATE password_resets SET used_at/i.test(sql)) {
    const token = String(params[0] ?? "");
    const reset = store.resets.find((r) => r.token === token);
    if (reset) {
      reset.used_at = new Date();
      saveLocalStore(store);
    }
    return ok([], reset ? 1 : 0);
  }

  // ---------------- Operational Control Tower Queries ----------------

  // 1. Audit log insert
  if (/INSERT INTO audit_logs/i.test(sql)) {
    seed.auditLogs.unshift({
      id: `aud-${Date.now()}`,
      actor: String(params[0] ?? "system"),
      actor_type: String(params[1] ?? "USER"),
      action: String(params[2] ?? "ACTION"),
      entity_type: params[3] != null ? String(params[3]) : null,
      created_at: new Date(),
    });
    saveLocalStore(store);
    return ok([], 1);
  }

  // 2. Audit logs select
  if (/FROM audit_logs/i.test(sql)) {
    const limit = Number(params[0] ?? 50);
    return ok(
      [...seed.auditLogs]
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .slice(0, limit) as unknown as Record<string, unknown>[],
    );
  }

  // 3. Shipment counts by state
  if (/SELECT state, count\(\*\)::text AS n FROM shipments GROUP BY state/i.test(sql)) {
    const map = new Map<string, number>();
    for (const s of seed.shipments) {
      map.set(s.state, (map.get(s.state) ?? 0) + 1);
    }
    return ok(
      Array.from(map.entries()).map(([state, n]) => ({ state, n: String(n) })),
    );
  }

  // 4. Overview stats
  if (/AS waiting_on_customer[\s\S]*FROM shipments/i.test(sql)) {
    const cutoff = Date.now() + 24 * 3_600_000;
    let active = 0;
    let waiting = 0;
    let approval = 0;
    let exc = 0;
    let atRisk = 0;
    for (const s of seed.shipments) {
      const isActive = !INACTIVE_STATES.has(s.state);
      if (isActive) active += 1;
      if (s.state === "NEEDS_INFO") waiting += 1;
      if (s.state === "AWAITING_APPROVAL") approval += 1;
      if (s.state === "EXCEPTION") exc += 1;
      if (isActive && s.deadline && s.deadline.getTime() < cutoff) atRisk += 1;
    }
    return ok([
      {
        active: String(active),
        waiting_on_customer: String(waiting),
        awaiting_approval: String(approval),
        in_exception: String(exc),
        deadline_at_risk: String(atRisk),
      },
    ]);
  }

  // 5. SSE stream: max(id) and poll e.id > $1
  if (/SELECT max\(id\)::text AS id FROM shipment_events/i.test(sql)) {
    const maxId = seed.events.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
    return ok([{ id: String(maxId) }]);
  }

  if (/FROM shipment_events e[\s\S]*e\.id > \$1/i.test(sql)) {
    const cursor = Number(params[0] ?? 0);
    const limit = Number(params[1] ?? 50);
    const rows = seed.events
      .filter((e) => (Number(e.id) || 0) > cursor)
      .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
      .slice(0, limit)
      .map((e) => ({
        id: e.id,
        type: e.type,
        actor: e.actor,
        to_state: e.to_state,
        created_at: e.created_at,
        reference: shipById(e.shipment_id)?.reference ?? null,
      }));
    return ok(rows);
  }

  // 6. Track lookup (returns reference, state, open_exceptions)
  if (/open_exceptions[\s\S]*FROM shipments s WHERE upper\(s\.reference\)/i.test(sql)) {
    const ref = String(params[0] ?? "").trim().toUpperCase();
    const s = seed.shipments.find((x) => x.reference.toUpperCase() === ref);
    if (!s) return ok([]);
    const openExc = seed.exceptions.filter(
      (e) => e.shipment_id === s.id && e.state !== "RESOLVED",
    ).length;
    return ok([{ ...s, open_exceptions: String(openExc) }]);
  }

  // 7. Assistant / Track / Approval / Autonomous shipment lookup
  if (/SELECT id(?:,\s*reference)?[\s\S]*FROM shipments[\s\S]*WHERE upper\(reference\) = (?:upper\(\$1\)|\$1)/i.test(sql)) {
    const ref = String(params[0] ?? "").trim().toUpperCase();
    const s = seed.shipments.find(
      (x) =>
        x.reference.toUpperCase() === ref ||
        (x.customer_ref && x.customer_ref.toUpperCase() === ref),
    );
    return s ? ok([{ id: s.id, reference: s.reference }], 1) : ok([]);
  }

  if (/SELECT reference,\s*state,\s*origin,\s*destination,\s*plan,\s*booking[\s\S]*FROM shipments/i.test(sql)) {
    const ref = String(params[0] ?? "").trim().toUpperCase();
    const s = seed.shipments.find(
      (x) =>
        x.reference.toUpperCase() === ref ||
        (x.customer_ref && x.customer_ref.toUpperCase() === ref),
    );
    return s
      ? ok([
          {
            reference: s.reference,
            state: s.state,
            origin: s.origin,
            destination: s.destination,
            plan: s.plan,
            booking: s.booking,
          },
        ])
      : ok([]);
  }

  if (/SELECT reference FROM shipments WHERE id = \$1/i.test(sql)) {
    const s = shipById(String(params[0] ?? ""));
    return s ? ok([{ reference: s.reference }], 1) : ok([]);
  }

  // 8. Assistant thread select / insert / delete
  if (/FROM assistant_messages m/i.test(sql)) {
    const ref = String(params[0] ?? "").trim().toUpperCase();
    const userId = String(params[1] ?? "");
    const s = seed.shipments.find((x) => x.reference.toUpperCase() === ref);
    if (!s) return ok([]);
    const rows = seed.assistantMessages
      .filter((m) => m.shipment_id === s.id && m.user_id === userId)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .slice(0, 60)
      .map((m) => ({
        id: m.id,
        role: m.role,
        body: m.body,
        state: m.state,
        confidence: m.confidence,
        next_step: m.next_step,
        created_at: m.created_at,
      }));
    return ok(rows);
  }

  if (/INSERT INTO assistant_messages[\s\S]*'user'/i.test(sql)) {
    const msgId = `ast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    seed.assistantMessages.push({
      id: msgId,
      shipment_id: String(params[0] ?? ""),
      user_id: String(params[1] ?? ""),
      role: "user",
      body: String(params[2] ?? ""),
      state: "DONE",
      confidence: null,
      next_step: null,
      created_at: new Date(),
    });
    saveLocalStore(store);
    return ok([{ id: msgId }], 1);
  }

  if (/INSERT INTO assistant_messages[\s\S]*'PENDING'/i.test(sql)) {
    const msgId = `ast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    seed.assistantMessages.push({
      id: msgId,
      shipment_id: String(params[0] ?? ""),
      user_id: String(params[1] ?? ""),
      role: "assistant",
      body: null,
      state: "PENDING",
      confidence: null,
      next_step: null,
      created_at: new Date(Date.now() + 5),
    });
    saveLocalStore(store);
    return ok([{ id: msgId }], 1);
  }

  if (/UPDATE assistant_messages/i.test(sql)) {
    const msgId = String(params[4] ?? "");
    const msg = seed.assistantMessages.find((m) => m.id === msgId);
    if (msg) {
      msg.body = params[0] != null ? String(params[0]) : null;
      msg.state = (String(params[1] ?? "DONE") as "PENDING" | "DONE" | "FAILED");
      msg.confidence = params[2] != null ? String(params[2]) : null;
      msg.next_step = params[3] != null ? String(params[3]) : null;
      saveLocalStore(store);
      return ok([], 1);
    }
    return ok([], 0);
  }

  if (/DELETE FROM assistant_messages/i.test(sql)) {
    const ref = String(params[0] ?? "").trim().toUpperCase();
    const userId = String(params[1] ?? "");
    const s = seed.shipments.find((x) => x.reference.toUpperCase() === ref);
    if (!s) return ok([], 0);
    const before = seed.assistantMessages.length;
    seed.assistantMessages = seed.assistantMessages.filter(
      (m) => !(m.shipment_id === s.id && m.user_id === userId),
    );
    saveLocalStore(store);
    return ok([], before - seed.assistantMessages.length);
  }

  // 9. Get single shipment detail (by id or case-insensitive reference)
  if (/FROM shipments WHERE id = \$1/i.test(sql)) {
    const s = shipById(String(params[0] ?? ""));
    return s ? ok([s as unknown as Record<string, unknown>]) : ok([]);
  }

  if (/FROM shipments WHERE reference = \$1/i.test(sql)) {
    const ref = String(params[0] ?? "").trim().toUpperCase();
    const s = seed.shipments.find((x) => x.reference.toUpperCase() === ref);
    return s ? ok([s as unknown as Record<string, unknown>]) : ok([]);
  }

  // 10. Customer shipments
  if (/FROM shipments[\s\S]*WHERE customer_id = \$1/i.test(sql)) {
    const custId = String(params[0] ?? "");
    const limit = Number(params[1] ?? 40);
    const now = Date.now();
    const rows = seed.shipments
      .filter((s) => s.customer_id === custId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, limit)
      .map((s) => ({
        reference: s.reference,
        state: s.state,
        origin: s.origin,
        destination: s.destination,
        deadline: s.deadline,
        created_at: s.created_at,
        overdue:
          Boolean(s.deadline) &&
          s.deadline.getTime() < now &&
          !TERMINAL_OR_DELIVERED.has(s.state),
      }));
    return ok(rows);
  }

  // 11. List shipments (with optional state)
  if (/FROM shipments(?:\s+WHERE state = \$1)?\s+ORDER BY updated_at DESC/i.test(sql)) {
    const stateFilter = params[0] ? String(params[0]) : null;
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    const limit = limitMatch ? Number(limitMatch[1]) : 100;
    const rows = seed.shipments
      .filter((s) => (!stateFilter ? true : s.state === stateFilter))
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
      .slice(0, limit);
    return ok(rows as unknown as Record<string, unknown>[]);
  }

  // 12. Shipment events
  if (/FROM shipment_events WHERE shipment_id = \$1/i.test(sql)) {
    const sid = String(params[0] ?? "");
    return ok(
      seed.events
        .filter((e) => e.shipment_id === sid)
        .sort((a, b) => a.seq - b.seq) as unknown as Record<string, unknown>[],
    );
  }

  // 13. Shipment legs + legStats
  if (/FROM shipment_legs WHERE shipment_id = \$1/i.test(sql)) {
    const sid = String(params[0] ?? "");
    return ok(
      seed.legs
        .filter((l) => l.shipment_id === sid)
        .sort((a, b) => a.sequence - b.sequence) as unknown as Record<
        string,
        unknown
      >[],
    );
  }

  if (/FROM shipment_legs GROUP BY mode/i.test(sql)) {
    const byMode = new Map<string, { legs: number; km: number; co2: number }>();
    for (const l of seed.legs) {
      const cur = byMode.get(l.mode) ?? { legs: 0, km: 0, co2: 0 };
      cur.legs += 1;
      cur.km += Number(l.distance_km) || 0;
      cur.co2 += Number(l.co2e_kg) || 0;
      byMode.set(l.mode, cur);
    }
    return ok(
      Array.from(byMode.entries())
        .sort((a, b) => b[1].legs - a[1].legs)
        .map(([mode, v]) => ({
          mode,
          legs: String(v.legs),
          total_km: String(Math.round(v.km)),
          total_co2e: v.co2.toFixed(1),
        })),
    );
  }

  if (/FROM shipment_legs\s+ORDER BY sequence/i.test(sql)) {
    return ok(
      [...seed.legs].sort((a, b) => a.sequence - b.sequence) as unknown as Record<
        string,
        unknown
      >[],
    );
  }

  // 14. Quotes
  if (/FROM quotes q\s+LEFT JOIN carriers c/i.test(sql)) {
    return ok(seed.quotes as unknown as Record<string, unknown>[]);
  }

  if (/FROM quotes q\s+JOIN carriers c/i.test(sql)) {
    const sid = String(params[0] ?? "");
    const matching = seed.quotes.filter((q) => q.shipment_id === sid);
    const maxRound = matching.reduce((m, q) => Math.max(m, q.round), 0);
    return ok(
      matching
        .filter((q) => q.round === maxRound)
        .sort((a, b) => Number(b.score) - Number(a.score)) as unknown as Record<
        string,
        unknown
      >[],
    );
  }

  // 15. Approvals (pendingCount, openApprovals, decideApproval UPDATEs)
  if (/SELECT count\(\*\)::text AS n FROM approvals WHERE state = 'PENDING'/i.test(sql)) {
    const n = seed.approvals.filter(
      (a) => a.state === "PENDING" && a.expires_at.getTime() > Date.now(),
    ).length;
    return ok([{ n: String(n) }]);
  }

  if (/FROM approvals ap[\s\S]*WHERE ap\.state = 'PENDING'/i.test(sql)) {
    const rows = seed.approvals
      .filter((a) => a.state === "PENDING")
      .sort((a, b) => a.requested_at.getTime() - b.requested_at.getTime())
      .map((a) => ({
        ...a,
        reference: shipById(a.shipment_id)?.reference ?? null,
      }));
    return ok(rows as unknown as Record<string, unknown>[]);
  }

  if (/UPDATE approvals[\s\S]*WHERE token = \$3 AND state = 'PENDING'/i.test(sql)) {
    const nextState = String(params[0] ?? "APPROVED") as "APPROVED" | "REJECTED";
    const decidedBy = String(params[1] ?? "operator");
    const token = String(params[2] ?? "");
    const app = seed.approvals.find(
      (a) =>
        a.token === token &&
        a.state === "PENDING" &&
        a.expires_at.getTime() > Date.now(),
    );
    if (!app) return ok([], 0);
    app.state = nextState;
    app.decided_by = decidedBy;
    app.decided_at = new Date();
    const s = shipById(app.shipment_id);
    if (s) {
      const from = s.state;
      s.state = nextState === "APPROVED" ? "BOOKED" : "PLANNED";
      s.version += 1;
      s.updated_at = new Date();
      const maxId = seed.events.reduce((m, e) => Math.max(m, Number(e.id) || 0), 100);
      const maxSeq = seed.events
        .filter((e) => e.shipment_id === s.id)
        .reduce((m, e) => Math.max(m, e.seq), 0);
      seed.events.push({
        id: String(maxId + 1),
        shipment_id: s.id,
        seq: maxSeq + 1,
        type: nextState === "APPROVED" ? "approval.granted" : "approval.refused",
        from_state: from,
        to_state: s.state,
        payload: { rationale: `${nextState} by ${decidedBy}` },
        actor: decidedBy,
        created_at: new Date(),
      });
    }
    saveLocalStore(store);
    return ok(
      [
        {
          id: app.id,
          shipment_id: app.shipment_id,
          proposed_action_id: app.proposed_action_id,
        },
      ],
      1,
    );
  }

  if (/UPDATE proposed_actions SET state = \$1/i.test(sql)) {
    const nextState = String(params[0] ?? "APPROVED");
    const paId = String(params[1] ?? "");
    const pa = seed.proposedActions.find(
      (p) => p.id === paId && p.state === "PROPOSED",
    );
    if (pa) {
      pa.state = nextState;
      saveLocalStore(store);
      return ok([], 1);
    }
    return ok([], 0);
  }

  if (/SELECT params FROM proposed_actions WHERE id = \$1/i.test(sql)) {
    const paId = String(params[0] ?? "");
    const pa = seed.proposedActions.find((p) => p.id === paId);
    return ok(pa ? [{ params: pa.params }] : []);
  }

  // 16. Work items (stats, deadWork, pending list, support.%, channel pending, inserts)
  if (/SELECT state, count\(\*\)::text AS n FROM work_items GROUP BY state/i.test(sql)) {
    const map = new Map<string, number>();
    for (const w of seed.workItems) {
      map.set(w.state, (map.get(w.state) ?? 0) + 1);
    }
    return ok(
      Array.from(map.entries()).map(([state, n]) => ({ state, n: String(n) })),
    );
  }

  if (/FROM work_items w[\s\S]*WHERE w\.state = 'DEAD'/i.test(sql)) {
    const rows = seed.workItems
      .filter((w) => w.state === "DEAD")
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
      .slice(0, 25)
      .map((w) => ({
        id: w.id,
        kind: w.kind,
        attempts: w.attempts,
        last_error: w.last_error,
        reference: shipById(w.shipment_id)?.reference ?? null,
      }));
    return ok(rows);
  }

  if (/FROM work_items w[\s\S]*WHERE w\.state IN \('PENDING','RUNNING'\)/i.test(sql)) {
    const rows = seed.workItems
      .filter((w) => w.state === "PENDING" || w.state === "RUNNING")
      .sort((a, b) => a.run_after.getTime() - b.run_after.getTime())
      .slice(0, 50)
      .map((w) => ({
        id: w.id,
        kind: w.kind,
        state: w.state,
        attempts: w.attempts,
        run_after: w.run_after,
        reference: shipById(w.shipment_id)?.reference ?? null,
      }));
    return ok(rows);
  }

  if (/FROM work_items w[\s\S]*WHERE w\.kind LIKE 'support\.%'/i.test(sql)) {
    const rows = seed.workItems
      .filter((w) => w.kind.startsWith("support."))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, 25)
      .map((w) => ({
        kind: w.kind,
        state: w.state,
        created_at: w.created_at,
        last_error: w.last_error,
        reference: shipById(w.shipment_id)?.reference ?? null,
      }));
    return ok(rows);
  }

  if (/FROM work_items[\s\S]*kind = 'channels\.configure'/i.test(sql)) {
    const n = seed.workItems.filter(
      (w) =>
        w.kind === "channels.configure" &&
        (w.state === "PENDING" || w.state === "RUNNING"),
    ).length;
    return ok([{ n: String(n) }]);
  }

  if (/INSERT INTO work_items/i.test(sql)) {
    const now = new Date();
    // Handle channel configuration mutations directly in local store mode
    if (/channels\.configure/i.test(sql)) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(params[0] ?? "{}"));
      } catch {
        payload = {};
      }
      const channelName = String(payload.channel ?? "");
      const act = String(payload.action ?? "");
      const ch = seed.channels.find((c) => c.channel === channelName);
      if (ch) {
        if (act === "save") {
          const fields = (payload.fields as Record<string, unknown>) ?? {};
          ch.state = "VERIFIED";
          ch.enabled = true;
          ch.has_credentials = true;
          ch.verified_at = now;
          ch.last_error = null;
          ch.config = { ...ch.config, ...fields };
        } else if (act === "enable") {
          ch.enabled = true;
        } else if (act === "disable") {
          ch.enabled = false;
        } else if (act === "disconnect") {
          ch.state = "UNCONFIGURED";
          ch.enabled = false;
          ch.has_credentials = false;
          ch.verified_at = null;
          ch.config = {};
        }
      }
      seed.workItems.unshift({
        id: `wi-${Date.now()}`,
        shipment_id: null,
        kind: "channels.configure",
        state: "DONE",
        attempts: 1,
        last_error: null,
        run_after: now,
        created_at: now,
        updated_at: now,
      });
      saveLocalStore(store);
      return ok([], 1);
    }

    // Parse column list & VALUES expressions so queries omitting shipment_id (e.g. (kind, state, payload, ...)) map accurately
    const colMatch = sql.match(/INSERT INTO work_items\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+?)\)(?:\s*ON CONFLICT|$)/i);
    const cols = colMatch
      ? colMatch[1].split(",").map((c) => c.trim().toLowerCase())
      : [];
    const valsRaw = colMatch
      ? colMatch[2].split(",").map((v) => v.trim())
      : [];

    const readColValue = (colName: string): unknown => {
      const idx = cols.indexOf(colName);
      if (idx === -1) return undefined;
      const expr = valsRaw[idx] ?? "";
      const paramMatch = expr.match(/^\$(\d+)/);
      if (paramMatch) {
        return params[Number(paramMatch[1]) - 1];
      }
      const strMatch = expr.match(/^'([^']*)'/);
      if (strMatch) return strMatch[1];
      return undefined;
    };

    const parsedShipmentId = readColValue("shipment_id");
    const parsedKind = readColValue("kind");
    const parsedState = readColValue("state");

    // If caller already executed inline (e.g. server-side Gemini agent) and inserted DONE, record only the work item
    if (
      String(parsedState ?? "").toUpperCase() === "DONE" ||
      /VALUES\s*\([^)]*'DONE'/i.test(sql) ||
      /,\s*'DONE'\s*,/i.test(sql)
    ) {
      const shipmentId =
        cols.length > 0
          ? parsedShipmentId != null
            ? String(parsedShipmentId)
            : null
          : params[0] != null
            ? String(params[0])
            : null;
      const kindMatch = sql.match(/'([a-z0-9_]+\.[a-z0-9_]+)'/i);
      const kind =
        typeof parsedKind === "string" && parsedKind.trim()
          ? parsedKind.trim()
          : kindMatch
            ? kindMatch[1]
            : String(params[1] ?? "agent.run");
      seed.workItems.unshift({
        id: `wi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        shipment_id: shipmentId,
        kind,
        state: "DONE",
        attempts: 1,
        last_error: null,
        run_after: now,
        created_at: now,
        updated_at: now,
      });
      saveLocalStore(store);
      return ok([], 1);
    }

    // Handle planning.optimize_fleet job in local fallback mode
    if (/planning\.optimize_fleet/i.test(sql)) {
      seed.workItems.unshift({
        id: `wi-${Date.now()}`,
        shipment_id: null,
        kind: "planning.optimize_fleet",
        state: "PENDING",
        attempts: 0,
        last_error: null,
        run_after: now,
        created_at: now,
        updated_at: now,
      });
      saveLocalStore(store);
      return ok([], 1);
    }

    // Queue shipment.assist / support.reply as real pending work items when Gemini is unconfigured
    if (/shipment\.assist/i.test(sql)) {
      const shipmentId = params[0] != null ? String(params[0]) : null;
      seed.workItems.unshift({
        id: `wi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        shipment_id: shipmentId,
        kind: "shipment.assist",
        state: "PENDING",
        attempts: 0,
        last_error: null,
        run_after: now,
        created_at: now,
        updated_at: now,
      });
      saveLocalStore(store);
      return ok([], 1);
    }

    if (/support\.reply/i.test(sql)) {
      const shipmentId = params[0] != null ? String(params[0]) : null;
      seed.workItems.unshift({
        id: `wi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        shipment_id: shipmentId,
        kind: "support.reply",
        state: "PENDING",
        attempts: 0,
        last_error: null,
        run_after: now,
        created_at: now,
        updated_at: now,
      });
      saveLocalStore(store);
      return ok([], 1);
    }

    // Generic or explicit work item (e.g. autonomous.*, support.*, agent.*)
    const shipmentId =
      cols.length > 0
        ? parsedShipmentId != null
          ? String(parsedShipmentId)
          : null
        : params[0] != null
          ? String(params[0])
          : null;
    const literalKindMatch = sql.match(/'([a-z0-9_]+\.[a-z0-9_]+)'/i);
    const kind =
      typeof parsedKind === "string" && parsedKind.trim()
        ? parsedKind.trim()
        : literalKindMatch
          ? literalKindMatch[1]
          : String(params[1] ?? "work.step");
    const isDone =
      String(parsedState ?? "").toUpperCase() === "DONE" ||
      /,\s*'DONE'\s*,/i.test(sql) ||
      /\(\s*[^,]+,\s*[^,]+,\s*'DONE'/i.test(sql);
    seed.workItems.unshift({
      id: `wi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      shipment_id: shipmentId,
      kind,
      state: isDone ? "DONE" : "PENDING",
      attempts: isDone ? 1 : 0,
      last_error: null,
      run_after: now,
      created_at: now,
      updated_at: now,
    });
    saveLocalStore(store);
    return ok([], 1);
  }

  // Autonomous intake domain mutations (orders, shipments, shipment_events, exceptions)
  if (/INSERT INTO orders\s*\(/i.test(sql)) {
    const id = `ord-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const reference = String(params[0] ?? `PO-${Date.now()}`);
    const state = String(params[1] ?? "VALIDATED");
    const source = String(params[2] ?? "PORTAL");
    const currency = String(params[3] ?? "NGN");
    const parsedReq = params[4] ? new Date(String(params[4])) : null;
    const requiredBy =
      parsedReq && !Number.isNaN(parsedReq.getTime())
        ? parsedReq
        : new Date(Date.now() + 72 * 3_600_000);
    let rawObj: Record<string, unknown> = {};
    try {
      rawObj = typeof params[5] === "string" ? JSON.parse(params[5]) : ((params[5] as Record<string, unknown>) ?? {});
    } catch {
      rawObj = {};
    }
    const customerName =
      (typeof rawObj.customerName === "string" && rawObj.customerName.trim()) ||
      (typeof rawObj.customer === "string" && rawObj.customer.trim()) ||
      "Direct Customer";
    seed.orders.unshift({
      id,
      reference,
      state,
      source,
      currency,
      ordered_at: new Date(),
      required_by: requiredBy,
      customer: customerName,
      items: String(rawObj.itemsCount ?? 1),
    });
    saveLocalStore(store);
    return ok([{ id, reference }], 1);
  }

  if (/INSERT INTO shipments\s*\(/i.test(sql)) {
    const id = `shp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const reference = String(params[0] ?? `LG-${Math.floor(10000 + Math.random() * 89999)}`);
    const state = String(params[1] ?? "ALLOCATED");
    const customerRef = params[2] != null ? String(params[2]) : reference;
    const parseJson = (val: unknown): Record<string, unknown> => {
      if (val && typeof val === "object") return val as Record<string, unknown>;
      if (typeof val === "string") {
        try {
          return JSON.parse(val) as Record<string, unknown>;
        } catch {
          return {};
        }
      }
      return {};
    };
    const origin = parseJson(params[3]);
    const destination = parseJson(params[4]);
    const cargo = parseJson(params[5]);
    const parsedDeadline = params[6] ? new Date(String(params[6])) : null;
    const deadline =
      parsedDeadline && !Number.isNaN(parsedDeadline.getTime())
        ? parsedDeadline
        : new Date(Date.now() + 72 * 3_600_000);
    const plan = parseJson(params[7]);
    const createdVia = String(params[8] ?? "MANUAL");
    const now = new Date();
    seed.shipments.unshift({
      id,
      reference,
      state,
      version: 1,
      customer_id: seed.customers[0]?.id ?? null,
      customer_ref: customerRef,
      origin,
      destination,
      cargo,
      deadline,
      allocation: seed.warehouses[0]
        ? { warehouse: seed.warehouses[0].code, status: "ALLOCATED" }
        : null,
      plan,
      booking: null,
      created_via: createdVia,
      created_at: now,
      updated_at: now,
    });
    saveLocalStore(store);
    return ok([{ id, reference }], 1);
  }

  if (/INSERT INTO shipment_events\s*\(/i.test(sql)) {
    const shipmentId = String(params[0] ?? "");
    const type = String(params[1] ?? "shipment.updated");
    const fromState = params[2] != null ? String(params[2]) : null;
    const toState = params[3] != null ? String(params[3]) : null;
    let payload: Record<string, unknown> = {};
    try {
      payload =
        typeof params[4] === "string"
          ? JSON.parse(params[4])
          : ((params[4] as Record<string, unknown>) ?? {});
    } catch {
      payload = {};
    }
    const actor = String(params[5] ?? "agent:orchestrator");
    const maxId = seed.events.reduce((m, e) => Math.max(m, Number(e.id) || 0), 100);
    const maxSeq = seed.events
      .filter((e) => e.shipment_id === shipmentId)
      .reduce((m, e) => Math.max(m, e.seq), 0);
    seed.events.push({
      id: String(maxId + 1),
      shipment_id: shipmentId,
      seq: maxSeq + 1,
      type,
      from_state: fromState,
      to_state: toState,
      payload,
      actor,
      created_at: new Date(),
    });
    saveLocalStore(store);
    return ok([], 1);
  }

  if (/INSERT INTO exceptions\s*\(/i.test(sql)) {
    const id = `exc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const shipmentId = String(params[0] ?? seed.shipments[0]?.id ?? "");
    const kind = String(params[1] ?? "CUSTOMER_REPORTED");
    const rawSev = String(params[2] ?? "HIGH").toUpperCase();
    const severity = (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(rawSev)
      ? rawSev
      : "HIGH") as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    const detectedBy = String(params[3] ?? "autonomous_intake");
    const hasSummaryCol = /,\s*summary\s*,\s*detail\)/i.test(sql);
    const rawDetail = hasSummaryCol ? params[5] : params[4];
    let detail: Record<string, unknown> = {};
    try {
      detail =
        typeof rawDetail === "string"
          ? JSON.parse(rawDetail)
          : ((rawDetail as Record<string, unknown>) ?? {});
    } catch {
      detail = {};
    }
    if (hasSummaryCol && params[4] != null && !detail.summary) {
      detail.summary = String(params[4]);
    }
    const existing = seed.exceptions.find(
      (e) =>
        e.shipment_id === shipmentId &&
        e.kind === kind &&
        String(e.state) !== "RESOLVED" &&
        String(e.state) !== "ABANDONED",
    );
    if (existing) {
      existing.detail = detail;
      saveLocalStore(store);
      return ok([{ id: existing.id }], 1);
    }
    seed.exceptions.unshift({
      id,
      shipment_id: shipmentId,
      kind,
      severity,
      detected_by: detectedBy,
      state: "OPEN",
      detail,
      created_at: new Date(),
    });
    saveLocalStore(store);
    return ok([{ id }], 1);
  }

  // Insert agent_runs (direct server-side Gemini agent telemetry)
  if (/INSERT INTO agent_runs/i.test(sql)) {
    const id = `ar-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let parsedResponse: { reasoning?: string | null; text?: string } | null = null;
    if (params[8] != null) {
      if (typeof params[8] === "string") {
        try {
          parsedResponse = JSON.parse(params[8]) as { reasoning?: string | null; text?: string };
        } catch {
          parsedResponse = { text: params[8] };
        }
      } else if (typeof params[8] === "object") {
        parsedResponse = params[8] as { reasoning?: string | null; text?: string };
      }
    }
    seed.agentRuns.unshift({
      id,
      shipment_id: params[0] != null ? String(params[0]) : null,
      agent: String(params[1] ?? "orchestrator"),
      job: String(params[2] ?? "Agent task"),
      model: String(params[3] ?? "gemini-4-hydrogen"),
      status: String(params[4] ?? "OK"),
      latency_ms: params[5] != null ? Number(params[5]) : 0,
      prompt_tokens: params[6] != null ? Number(params[6]) : 0,
      completion_tokens: params[7] != null ? Number(params[7]) : 0,
      response: parsedResponse ?? {},
      created_at: new Date(),
    });
    saveLocalStore(store);
    return ok([{ id }], 1);
  }

  // 17. Agent runs + Model usage + Activity feed
  if (/SELECT count\(\*\)::text AS n FROM agent_runs/i.test(sql)) {
    return ok([{ n: String(seed.agentRuns.length) }]);
  }

  if (/FROM agent_runs a/i.test(sql)) {
    const limit = Number(params[0] ?? 50);
    const rows = [...seed.agentRuns]
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, limit)
      .map((a) => ({
        ...a,
        reference: shipById(a.shipment_id)?.reference ?? null,
      }));
    return ok(rows as unknown as Record<string, unknown>[]);
  }

  if (/WITH feed AS/i.test(sql)) {
    const limit = Number(params[0] ?? 120);
    const kinds = Array.isArray(params[1]) ? (params[1] as string[]) : null;
    const items: {
      kind: "MODEL" | "EVENT" | "TOOL" | "GATE";
      at: Date;
      actor: string;
      action: string;
      reason: string | null;
      result: string | null;
      reference: string | null;
      detail: Record<string, unknown> | null;
    }[] = [
      ...seed.agentRuns.map((a) => ({
        kind: "MODEL" as const,
        at: a.created_at,
        actor: a.agent,
        action: a.job,
        reason: a.model,
        result: `${a.status} · ${a.latency_ms}ms`,
        reference: shipById(a.shipment_id)?.reference ?? null,
        detail: {
          tokens_out: a.completion_tokens,
          reasoning: a.response?.reasoning ?? null,
        },
      })),
      ...seed.events.map((e) => ({
        kind: "EVENT" as const,
        at: e.created_at,
        actor: e.actor || "system",
        action: e.type,
        reason: null,
        result: e.to_state ? `${e.from_state ?? "-"} -> ${e.to_state}` : null,
        reference: shipById(e.shipment_id)?.reference ?? null,
        detail: e.payload,
      })),
      ...seed.toolCalls.map((t) => ({
        kind: "TOOL" as const,
        at: t.created_at,
        actor: "tool",
        action: t.tool,
        reason: `tier ${t.tier}`,
        result: t.error ? `${t.state} · ${t.error}` : t.state,
        reference: shipById(t.shipment_id)?.reference ?? null,
        detail: t.request,
      })),
      ...seed.proposedActions.map((p) => {
        const run = p.agent_run_id
          ? seed.agentRuns.find((r) => r.id === p.agent_run_id)
          : undefined;
        return {
          kind: "GATE" as const,
          at: p.created_at,
          actor: run?.agent ?? "agent",
          action: p.action,
          reason: p.policy_reason,
          result: `${p.policy_decision} · ${p.state}`,
          reference: shipById(p.shipment_id)?.reference ?? null,
          detail: p.params,
        };
      }),
    ];

    const filtered = kinds && kinds.length > 0
      ? items.filter((row) => kinds.includes(row.kind))
      : items;
    filtered.sort((a, b) => b.at.getTime() - a.at.getTime());
    return ok(filtered.slice(0, limit) as unknown as Record<string, unknown>[]);
  }

  if (/FROM agent_runs[\s\S]*GROUP BY job, model/i.test(sql)) {
    const cutoff = Date.now() - 24 * 3_600_000;
    const grouped = new Map<
      string,
      {
        job: string;
        model: string;
        calls: number;
        latencySum: number;
        tokensOut: number;
        failures: number;
      }
    >();
    for (const r of seed.agentRuns) {
      if (r.created_at.getTime() < cutoff) continue;
      const key = `${r.job}::${r.model}`;
      const cur = grouped.get(key) ?? {
        job: r.job,
        model: r.model,
        calls: 0,
        latencySum: 0,
        tokensOut: 0,
        failures: 0,
      };
      cur.calls += 1;
      cur.latencySum += r.latency_ms ?? 0;
      cur.tokensOut += r.completion_tokens ?? 0;
      if (r.status !== "OK") cur.failures += 1;
      grouped.set(key, cur);
    }
    return ok(
      Array.from(grouped.values())
        .sort((a, b) => b.calls - a.calls)
        .map((g) => ({
          job: g.job,
          model: g.model,
          calls: String(g.calls),
          avg_latency: String(Math.round(g.latencySum / g.calls)),
          total_out: String(g.tokensOut),
          failures: String(g.failures),
        })),
    );
  }

  // 18. Carriers, Warehouses, Inventory, Locations
  if (/FROM carriers c/i.test(sql)) {
    return ok(seed.carriers as unknown as Record<string, unknown>[]);
  }

  if (/FROM warehouses w/i.test(sql)) {
    return ok(seed.warehouses as unknown as Record<string, unknown>[]);
  }

  if (/FROM inventory i JOIN warehouses w/i.test(sql)) {
    return ok(seed.inventory as unknown as Record<string, unknown>[]);
  }

  if (/FROM locations/i.test(sql)) {
    return ok(seed.locations as unknown as Record<string, unknown>[]);
  }

  // 19. Customers (single & list)
  if (/FROM customers c[\s\S]*WHERE upper\(c\.code\)/i.test(sql)) {
    const code = String(params[0] ?? "").toUpperCase();
    const c = seed.customers.find((x) => x.code.toUpperCase() === code);
    if (!c) return ok([]);
    const ships = seed.shipments.filter((s) => s.customer_id === c.id);
    const now = Date.now();
    const last = ships.reduce<Date | null>(
      (max, s) => (!max || s.created_at > max ? s.created_at : max),
      null,
    );
    return ok([
      {
        ...c,
        total: String(ships.length),
        open: String(ships.filter((s) => !INACTIVE_STATES.has(s.state)).length),
        late: String(
          ships.filter(
            (s) =>
              s.deadline &&
              s.deadline.getTime() < now &&
              !TERMINAL_OR_DELIVERED.has(s.state),
          ).length,
        ),
        last_shipment_at: last,
      },
    ]);
  }

  if (/FROM customers c/i.test(sql)) {
    const now = Date.now();
    const rows = seed.customers.map((c) => {
      const ships = seed.shipments.filter((s) => s.customer_id === c.id);
      const last = ships.reduce<Date | null>(
        (max, s) => (!max || s.created_at > max ? s.created_at : max),
        null,
      );
      return {
        ...c,
        total: String(ships.length),
        open: String(ships.filter((s) => !INACTIVE_STATES.has(s.state)).length),
        late: String(
          ships.filter(
            (s) =>
              s.deadline &&
              s.deadline.getTime() < now &&
              !TERMINAL_OR_DELIVERED.has(s.state),
          ).length,
        ),
        last_shipment_at: last,
      };
    });
    return ok(rows as unknown as Record<string, unknown>[]);
  }

  // 20. Fleet: Conveyances & Drivers
  if (/FROM conveyances v/i.test(sql)) {
    return ok(seed.conveyances as unknown as Record<string, unknown>[]);
  }

  if (/FROM drivers d/i.test(sql)) {
    return ok(seed.drivers as unknown as Record<string, unknown>[]);
  }

  // 21. Orders, Documents, Customs, Exceptions
  if (/FROM orders o/i.test(sql)) {
    return ok(seed.orders as unknown as Record<string, unknown>[]);
  }

  if (/FROM documents d/i.test(sql)) {
    return ok(
      seed.documents.map((d) => ({
        ...d,
        reference: shipById(d.shipment_id)?.reference ?? null,
      })) as unknown as Record<string, unknown>[],
    );
  }

  if (/FROM customs_declarations cd/i.test(sql)) {
    return ok(
      seed.customs.map((c) => ({
        ...c,
        reference: shipById(c.shipment_id)?.reference ?? null,
      })) as unknown as Record<string, unknown>[],
    );
  }

  if (/FROM exceptions e/i.test(sql)) {
    const rank: Record<string, number> = {
      CRITICAL: 0,
      HIGH: 1,
      MEDIUM: 2,
      LOW: 3,
    };
    const rows = seed.exceptions
      .filter((e) => e.state !== "RESOLVED")
      .sort(
        (a, b) =>
          (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) ||
          b.created_at.getTime() - a.created_at.getTime(),
      )
      .map((e) => ({
        ...e,
        reference: shipById(e.shipment_id)?.reference ?? null,
      }));
    return ok(rows as unknown as Record<string, unknown>[]);
  }

  // 22. Communications & Channel contacts (including /track, WhatsApp, Telegram, & /support)
  if (/FROM communications m[\s\S]*WHERE upper\(s\.reference\) = \$1/i.test(sql)) {
    const ref = String(params[0] ?? "").trim().toUpperCase();
    const s = seed.shipments.find((x) => x.reference.toUpperCase() === ref);
    if (!s) return ok([]);
    const rows = seed.communications
      .filter(
        (m) =>
          m.shipment_id === s.id &&
          ["WIDGET", "PORTAL", "WHATSAPP", "TELEGRAM"].includes(m.channel),
      )
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    return ok(rows as unknown as Record<string, unknown>[]);
  }

  if (/FROM communications(?:\s+m)?[\s\S]*WHERE (?:m\.)?contact_id = \$1/i.test(sql)) {
    const contactId = String(params[0] ?? "");
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    const limit = limitMatch ? Number(limitMatch[1]) : 100;
    const rows = seed.communications
      .filter((m) => m.contact_id === contactId)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .slice(-limit);
    return ok(rows as unknown as Record<string, unknown>[]);
  }

  if (/FROM communications m[\s\S]*WHERE m\.customer_id = \$1/i.test(sql)) {
    const custId = String(params[0] ?? "");
    const limit = Number(params[1] ?? 25);
    const rows = seed.communications
      .filter(
        (m) =>
          m.customer_id === custId ||
          shipById(m.shipment_id)?.customer_id === custId,
      )
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, limit)
      .map((m) => ({
        channel: m.channel,
        direction: m.direction,
        body: m.body,
        created_at: m.created_at,
        reference: shipById(m.shipment_id)?.reference ?? null,
      }));
    return ok(rows);
  }

  if (/SELECT count\(\*\)::text AS n FROM communications/i.test(sql)) {
    return ok([{ n: String(seed.communications.length) }]);
  }

  if (/FROM communications m/i.test(sql) && !/FROM channel_contacts c/i.test(sql)) {
    const rows = [...seed.communications]
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, 100)
      .map((m) => ({
        ...m,
        reference: shipById(m.shipment_id)?.reference ?? null,
      }));
    return ok(rows as unknown as Record<string, unknown>[]);
  }

  if (/UPDATE shipments[\s\S]*SET plan = (?:COALESCE\(plan,\s*'\{\}'::jsonb\)\s*\|\|\s*)?\$1::jsonb/i.test(sql)) {
    const rawPlan = params[0];
    let parsedPlan: Record<string, unknown> = {};
    if (typeof rawPlan === "string") {
      try {
        parsedPlan = JSON.parse(rawPlan) as Record<string, unknown>;
      } catch {
        parsedPlan = {};
      }
    } else if (rawPlan && typeof rawPlan === "object") {
      parsedPlan = rawPlan as Record<string, unknown>;
    }
    const targetRefOrId = String(params[1] ?? "");
    const ship = seed.shipments.find(
      (s) => s.id === targetRefOrId || s.reference.toUpperCase() === targetRefOrId.toUpperCase(),
    );
    if (ship) {
      ship.plan = { ...(ship.plan ?? {}), ...parsedPlan };
      ship.updated_at = new Date();
      saveLocalStore(store);
      return ok([{ id: ship.id, reference: ship.reference }], 1);
    }
    return ok([], 0);
  }

  if (/INSERT INTO communications/i.test(sql)) {
    const id = `comm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const colsMatch = sql.match(/INSERT INTO communications\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+)\)/i);
    if (colsMatch) {
      const colNames = colsMatch[1].split(",").map((c) => c.trim().toLowerCase());
      const rawValues = colsMatch[2];
      const tokens: string[] = [];
      let current = "";
      let inQuote = false;
      let parenDepth = 0;
      for (let i = 0; i < rawValues.length; i += 1) {
        const ch = rawValues[i];
        if (ch === "'") {
          if (inQuote && rawValues[i + 1] === "'") {
            current += "'";
            i += 1;
            continue;
          }
          inQuote = !inQuote;
          current += ch;
          continue;
        }
        if (!inQuote) {
          if (ch === "(") parenDepth += 1;
          else if (ch === ")") {
            if (parenDepth === 0) break;
            parenDepth -= 1;
          } else if (ch === "," && parenDepth === 0) {
            tokens.push(current.trim());
            current = "";
            continue;
          }
        }
        current += ch;
      }
      if (current.trim()) tokens.push(current.trim());

      const resolveVal = (token: string | undefined): unknown => {
        if (!token) return null;
        const paramMatch = token.match(/^\$(\d+)/);
        if (paramMatch) {
          return params[Number(paramMatch[1]) - 1] ?? null;
        }
        if (/^null$/i.test(token)) return null;
        if (/^true$/i.test(token)) return true;
        if (/^false$/i.test(token)) return false;
        const strMatch = token.match(/^'([\s\S]*)'$/);
        if (strMatch) return strMatch[1];
        return token;
      };

      const rowMap: Record<string, unknown> = {};
      colNames.forEach((col, idx) => {
        rowMap[col] = resolveVal(tokens[idx]);
      });

      const dirRaw = String(rowMap.direction ?? "INBOUND").toUpperCase();
      const direction = dirRaw === "OUTBOUND" ? "OUTBOUND" : "INBOUND";
      const channel = String(rowMap.channel ?? "WIDGET").toUpperCase();
      const state = String(rowMap.state ?? (direction === "OUTBOUND" ? "SENT" : "RECEIVED")).toUpperCase();

      seed.communications.push({
        id,
        shipment_id: rowMap.shipment_id != null ? String(rowMap.shipment_id) : null,
        customer_id: rowMap.customer_id != null ? String(rowMap.customer_id) : null,
        contact_id: rowMap.contact_id != null ? String(rowMap.contact_id) : null,
        channel,
        direction,
        recipient: rowMap.recipient != null ? String(rowMap.recipient) : null,
        subject: rowMap.subject != null ? String(rowMap.subject) : null,
        body: String(rowMap.body ?? ""),
        state,
        safety_checked: rowMap.safety_checked != null ? Boolean(rowMap.safety_checked) : true,
        created_at: new Date(),
      });
    } else {
      const isOutbound = /'OUTBOUND'/i.test(sql) || String(params[2] ?? "").toUpperCase() === "OUTBOUND";
      const channelMatch = sql.match(/'(EMAIL|WIDGET|PORTAL|TELEGRAM|WHATSAPP)'/i);
      seed.communications.push({
        id,
        shipment_id: params[0] != null ? String(params[0]) : null,
        customer_id: null,
        contact_id: params[1] != null ? String(params[1]) : null,
        channel: channelMatch ? channelMatch[1].toUpperCase() : String(params[2] ?? "WIDGET").toUpperCase(),
        direction: isOutbound ? "OUTBOUND" : "INBOUND",
        recipient: params[4] != null ? String(params[4]) : params[3] != null ? String(params[3]) : null,
        subject: null,
        body: String(params[3] ?? params[2] ?? ""),
        state: isOutbound ? "SENT" : "RECEIVED",
        safety_checked: true,
        created_at: new Date(),
      });
    }
    saveLocalStore(store);
    return ok([{ id }], 1);
  }

  if (/UPDATE channel_contacts[\s\S]*escalated_at/i.test(sql)) {
    const reason = params[0] != null ? String(params[0]) : "Escalated by AI support";
    const contactId = String(params[1] ?? "");
    const c = seed.contacts.find((x) => x.id === contactId);
    if (c) {
      c.escalated_at = new Date();
      c.escalation_reason = reason;
      saveLocalStore(store);
      return ok([], 1);
    }
    return ok([], 0);
  }

  if (/UPDATE channel_contacts[\s\S]*SET draft/i.test(sql)) {
    let draftObj: Record<string, unknown> | null = null;
    if (params[0] != null) {
      try {
        draftObj =
          typeof params[0] === "string"
            ? (JSON.parse(params[0]) as Record<string, unknown>)
            : (params[0] as Record<string, unknown>);
      } catch {
        draftObj = null;
      }
    }
    const contactId = String(params[1] ?? "");
    const c = seed.contacts.find((x) => x.id === contactId);
    if (c) {
      c.draft = draftObj;
      c.last_seen_at = new Date();
      saveLocalStore(store);
      return ok([], 1);
    }
    return ok([], 0);
  }

  if (/UPDATE channel_contacts[\s\S]*SET last_shipment_id/i.test(sql)) {
    const shipmentId = params[0] != null ? String(params[0]) : null;
    const contactId = String(params[1] ?? "");
    const c = seed.contacts.find((x) => x.id === contactId);
    if (c) {
      c.last_shipment_id = shipmentId;
      if (/draft\s*=\s*NULL/i.test(sql)) {
        c.draft = null;
      }
      c.last_seen_at = new Date();
      saveLocalStore(store);
      return ok([], 1);
    }
    return ok([], 0);
  }

  if (/INSERT INTO channel_contacts/i.test(sql)) {
    const literalChannelMatch = sql.match(/VALUES\s*\(\s*'(WIDGET|WHATSAPP|TELEGRAM|GMAIL|PORTAL)'/i);
    const channel = literalChannelMatch
      ? literalChannelMatch[1].toUpperCase()
      : String(params[0] ?? "WIDGET").toUpperCase();
    const offset = literalChannelMatch ? 0 : 1;
    const extId = String(params[offset] ?? "");
    const displayName = String(params[offset + 1] ?? "Customer");
    const shipmentId = params[offset + 2] != null ? String(params[offset + 2]) : null;
    let existing = seed.contacts.find(
      (c) => c.channel === channel && c.external_id === extId,
    );
    if (existing) {
      existing.last_seen_at = new Date();
      if (displayName && displayName !== "Customer") {
        existing.display_name = displayName;
      }
      if (shipmentId) existing.last_shipment_id = shipmentId;
    } else {
      existing = {
        id: `ct-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        channel,
        external_id: extId,
        display_name: displayName,
        escalated_at: null,
        escalation_reason: null,
        draft: null,
        last_seen_at: new Date(),
        last_shipment_id: shipmentId,
      };
      seed.contacts.push(existing);
    }
    saveLocalStore(store);
    return ok(
      [{ id: existing.id, last_shipment_id: existing.last_shipment_id, draft: existing.draft }],
      1,
    );
  }

  if (/FROM channel_contacts c[\s\S]*c\.channel = (?:'WIDGET'|\$1) AND c\.external_id = \$(?:1|2)/i.test(sql)) {
    const literalWidget = /c\.channel = 'WIDGET'/i.test(sql);
    const channel = literalWidget ? "WIDGET" : String(params[0] ?? "WIDGET").toUpperCase();
    const extId = String(literalWidget ? params[0] : params[1] ?? "");
    const c = seed.contacts.find(
      (x) => x.channel === channel && x.external_id === extId,
    );
    if (!c) return ok([]);
    return ok([
      {
        id: c.id,
        last_ref: shipById(c.last_shipment_id)?.reference ?? null,
        draft: c.draft,
      },
    ]);
  }

  if (/FROM channel_contacts c/i.test(sql)) {
    const rows = [...seed.contacts]
      .sort((a, b) => {
        if (a.escalated_at && !b.escalated_at) return -1;
        if (!a.escalated_at && b.escalated_at) return 1;
        return b.last_seen_at.getTime() - a.last_seen_at.getTime();
      })
      .map((c) => {
        const msgs = seed.communications
          .filter((m) => m.contact_id === c.id)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        return {
          id: c.id,
          channel: c.channel,
          external_id: c.external_id,
          display_name: c.display_name,
          escalated_at: c.escalated_at,
          escalation_reason: c.escalation_reason,
          draft: c.draft,
          last_seen_at: c.last_seen_at,
          reference: shipById(c.last_shipment_id)?.reference ?? null,
          messages: String(msgs.length),
          last_message: msgs[0]?.body ?? null,
          last_direction: msgs[0]?.direction ?? null,
        };
      });
    return ok(rows);
  }

  // 23. Throughput (14-day sparkline)
  if (/FROM generate_series\(/i.test(sql)) {
    const days: { day: string; created: string; closed: string }[] = [];
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86_400_000);
      const label = d.toLocaleDateString("en-US", {
        month: "short",
        day: "2-digit",
      });
      const dayStart = new Date(d);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);
      const actualCreated = seed.shipments.filter(
        (s) => s.created_at >= dayStart && s.created_at < dayEnd,
      ).length;
      const actualClosed = seed.shipments.filter(
        (s) =>
          s.state === "CLOSED" && s.updated_at >= dayStart && s.updated_at < dayEnd,
      ).length;
      days.push({
        day: label,
        created: String(actualCreated),
        closed: String(actualClosed),
      });
    }
    return ok(days);
  }

  // 24. Settings: Channel connections, Policy, Currencies, FX rates, Migrations
  const sanitizeChannelForDashboard = (c: (typeof seed.channels)[number]) => {
    const safeConfig = { ...(c.config ?? {}) };
    delete safeConfig.bot_token;
    delete safeConfig.access_token;
    delete safeConfig.verify_token;
    delete safeConfig.app_password;
    return {
      channel: c.channel,
      display_name: c.display_name,
      state: c.state,
      enabled: c.enabled,
      config: safeConfig,
      has_credentials: Boolean(c.credentials || c.config?.bot_token || c.has_credentials),
      verified_at: c.verified_at,
      last_inbound_at: c.last_inbound_at,
      last_error: c.last_error,
    };
  };

  const extractWhereChannel = (queryText: string, queryParams: unknown[]): string => {
    const paramMatch = queryText.match(/WHERE\s+channel\s*=\s*\$(\d+)/i);
    if (paramMatch) {
      return String(queryParams[Number(paramMatch[1]) - 1] ?? "").toUpperCase();
    }
    const litMatch = queryText.match(/WHERE\s+channel\s*=\s*'([A-Za-z0-9_]+)'/i);
    return litMatch ? litMatch[1].toUpperCase() : "";
  };

  if (/UPDATE\s+channel_connections\s+SET\s+last_inbound_at/i.test(sql)) {
    const chName = extractWhereChannel(sql, params) || String(params[0] ?? "").toUpperCase();
    const ch = seed.channels.find((c) => c.channel === chName);
    if (ch) {
      ch.last_inbound_at = new Date();
      saveLocalStore(store);
    }
    return ok([], ch ? 1 : 0);
  }

  if (/UPDATE\s+channel_connections\s+SET\s+cursor\s*=\s*\$1/i.test(sql)) {
    const cursorVal = params[0] != null ? String(params[0]) : null;
    const chName = extractWhereChannel(sql, params) || String(params[1] ?? "TELEGRAM").toUpperCase();
    const ch = seed.channels.find((c) => c.channel === chName);
    if (ch) {
      ch.cursor = cursorVal;
      if (/last_inbound_at\s*=\s*now\(\)/i.test(sql)) {
        ch.last_inbound_at = new Date();
      }
      if (/last_error\s*=\s*NULL/i.test(sql)) {
        ch.last_error = null;
      }
      saveLocalStore(store);
      return ok([], 1);
    }
    return ok([], 0);
  }

  if (/UPDATE\s+channel_connections\s+SET\s+last_error\s*=\s*\$1/i.test(sql)) {
    const errVal = params[0] != null ? String(params[0]) : null;
    const chName = extractWhereChannel(sql, params) || String(params[1] ?? "TELEGRAM").toUpperCase();
    const ch = seed.channels.find((c) => c.channel === chName);
    if (ch) {
      ch.last_error = errVal;
      if (/state\s*=\s*'ERROR'/i.test(sql)) {
        ch.state = "ERROR";
        ch.enabled = false;
      }
      saveLocalStore(store);
      return ok([], 1);
    }
    return ok([], 0);
  }

  if (/UPDATE\s+channel_connections\s+SET\s+credentials\s*=\s*NULL/i.test(sql)) {
    const chName = extractWhereChannel(sql, params) || String(params[0] ?? "").toUpperCase();
    const ch = seed.channels.find((c) => c.channel === chName);
    if (ch) {
      ch.credentials = null;
      ch.config = {};
      ch.enabled = false;
      ch.state = "UNCONFIGURED";
      ch.verified_at = null;
      ch.last_error = null;
      ch.cursor = null;
      ch.has_credentials = false;
      saveLocalStore(store);
      return ok([], 1);
    }
    return ok([], 0);
  }

  if (/UPDATE\s+channel_connections\s+SET\s+enabled\s*=\s*\$1/i.test(sql)) {
    const enabledVal = Boolean(params[0]);
    const chName = extractWhereChannel(sql, params) || String(params[1] ?? "").toUpperCase();
    const ch = seed.channels.find((c) => c.channel === chName);
    if (ch) {
      ch.enabled = enabledVal;
      saveLocalStore(store);
      return ok([], 1);
    }
    return ok([], 0);
  }

  if (/UPDATE\s+channel_connections\s+SET\s+credentials\s*=\s*\$1/i.test(sql)) {
    const rawCreds = params[0];
    const credStr =
      Buffer.isBuffer(rawCreds)
        ? rawCreds.toString("utf8")
        : rawCreds != null
          ? String(rawCreds)
          : null;
    let nextConfig: Record<string, unknown> = {};
    if (typeof params[1] === "string") {
      try {
        nextConfig = JSON.parse(params[1]) as Record<string, unknown>;
      } catch {
        nextConfig = {};
      }
    } else if (params[1] && typeof params[1] === "object") {
      nextConfig = params[1] as Record<string, unknown>;
    }
    const nextState = String(params[2] ?? "VERIFIED");
    const isOk = Boolean(params[3]);
    const nextErr = params[4] != null ? String(params[4]) : null;
    const nextEnabled = Boolean(params[5]);
    const chName = extractWhereChannel(sql, params) || String(params[6] ?? "").toUpperCase();
    const ch = seed.channels.find((c) => c.channel === chName);
    if (ch) {
      ch.credentials = credStr;
      ch.has_credentials = Boolean(credStr);
      ch.config = nextConfig;
      ch.state = nextState;
      ch.verified_at = isOk ? new Date() : ch.verified_at;
      ch.last_error = nextErr;
      ch.enabled = nextEnabled;
      saveLocalStore(store);
      return ok([sanitizeChannelForDashboard(ch) as unknown as Record<string, unknown>], 1);
    }
    return ok([], 0);
  }

  if (/SELECT\s+org_id,\s*channel,\s*credentials/i.test(sql)) {
    const defaultOrgId = store.orgs[0]?.id ?? null;
    const filterChannel = extractWhereChannel(sql, params) || null;
    const rows = seed.channels
      .filter((c) => (!filterChannel || c.channel === filterChannel))
      .filter((c) => !/enabled\s*=\s*true/i.test(sql) || (c.enabled && c.state === "VERIFIED"))
      .map((c) => ({
        org_id: defaultOrgId,
        channel: c.channel,
        credentials: c.credentials ?? null,
        config: c.config ?? {},
        cursor: c.cursor ?? null,
        state: c.state,
        enabled: c.enabled,
      }));
    return ok(rows as unknown as Record<string, unknown>[]);
  }

  if (/FROM\s+channel_connections[\s\S]*WHERE\s+channel\s*=\s*(?:\$\d+|'[A-Za-z0-9_]+')/i.test(sql)) {
    const chName = extractWhereChannel(sql, params);
    const includeCreds = /\bcredentials\b/i.test(sql) && !/credentials IS NOT NULL/i.test(sql);
    return ok(
      seed.channels
        .filter((c) => c.channel === chName)
        .map((c) =>
          includeCreds ? (c as unknown as Record<string, unknown>) : sanitizeChannelForDashboard(c),
        ) as unknown as Record<string, unknown>[],
    );
  }

  if (/FROM\s+channel_connections/i.test(sql)) {
    return ok(
      seed.channels.map(sanitizeChannelForDashboard) as unknown as Record<string, unknown>[],
    );
  }

  if (/FROM policies/i.test(sql)) {
    return ok(seed.policies as unknown as Record<string, unknown>[]);
  }

  if (/FROM currencies/i.test(sql)) {
    return ok(seed.currencies as unknown as Record<string, unknown>[]);
  }

  if (/FROM fx_rates/i.test(sql)) {
    return ok(seed.fxRates as unknown as Record<string, unknown>[]);
  }

  if (/FROM schema_migrations/i.test(sql)) {
    return ok(seed.migrations as unknown as Record<string, unknown>[]);
  }

  // 25. Universal Integrations (connectors, sync events, telemetry, inventory)
  if (/^CREATE\s+(?:TABLE|INDEX)/i.test(sql)) {
    return ok([], 0);
  }

  if (/FROM\s+integration_connectors\s+WHERE\s+api_key_hash\s*=\s*\$1/i.test(sql)) {
    const hash = String(params[0] ?? "");
    const found = seed.integrationConnectors.find((c) => c.api_key_hash === hash);
    return found ? ok([found as unknown as Record<string, unknown>], 1) : ok([]);
  }

  if (/FROM\s+integration_connectors\s+WHERE\s+id\s*=\s*\$1\s+AND\s+org_id\s*=\s*\$2/i.test(sql)) {
    const id = String(params[0] ?? "");
    const orgId = String(params[1] ?? "");
    const found = seed.integrationConnectors.find(
      (c) => c.id === id && c.org_id === orgId,
    );
    return found ? ok([found as unknown as Record<string, unknown>], 1) : ok([]);
  }

  if (/FROM\s+integration_connectors\s+WHERE\s+org_id\s*=\s*\$1/i.test(sql)) {
    const orgId = String(params[0] ?? "");
    const rows = seed.integrationConnectors
      .filter((c) => c.org_id === orgId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return ok(rows as unknown as Record<string, unknown>[]);
  }

  if (/INSERT INTO integration_connectors/i.test(sql)) {
    const now = new Date();
    const parseJsonArr = (val: unknown): string[] => {
      if (Array.isArray(val)) return val.map(String);
      if (typeof val === "string") {
        try {
          const p = JSON.parse(val);
          return Array.isArray(p) ? p.map(String) : [];
        } catch {
          return [];
        }
      }
      return [];
    };
    const parseJsonObj = (val: unknown): Record<string, string> => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return val as Record<string, string>;
      }
      if (typeof val === "string") {
        try {
          const p = JSON.parse(val);
          return p && typeof p === "object" ? (p as Record<string, string>) : {};
        } catch {
          return {};
        }
      }
      return {};
    };
    const rec = {
      id: String(params[0] ?? `conn-${Date.now()}`),
      org_id: String(params[1] ?? ""),
      name: String(params[2] ?? "Connector"),
      system_type: String(params[3] ?? "custom_rest_webhook"),
      category: String(params[4] ?? "CUSTOM"),
      status: (String(params[5] ?? "ACTIVE") as "ACTIVE" | "PAUSED"),
      autonomy_mode: (String(params[6] ?? "FULL_AUTONOMOUS") as
        | "FULL_AUTONOMOUS"
        | "ASSISTED_APPROVAL"
        | "SYNC_ONLY"),
      api_key_prefix: String(params[7] ?? ""),
      api_key_hash: String(params[8] ?? ""),
      webhook_secret_hash: String(params[9] ?? ""),
      outbound_webhook_url: params[10] != null ? String(params[10]) : null,
      outbound_events: parseJsonArr(params[11]),
      field_mapping: parseJsonObj(params[12]),
      created_by: String(params[13] ?? "operator"),
      created_at: now,
      updated_at: now,
      last_sync_at: null,
      events_processed: 0,
      errors_count: 0,
    };
    seed.integrationConnectors.unshift(rec);
    saveLocalStore(store);
    return ok([rec as unknown as Record<string, unknown>], 1);
  }

  if (/UPDATE\s+integration_connectors\s+SET\s+api_key_prefix\s*=\s*\$1/i.test(sql)) {
    const id = String(params[3] ?? "");
    const orgId = String(params[4] ?? "");
    const c = seed.integrationConnectors.find((x) => x.id === id && x.org_id === orgId);
    if (!c) return ok([], 0);
    c.api_key_prefix = String(params[0] ?? c.api_key_prefix);
    c.api_key_hash = String(params[1] ?? c.api_key_hash);
    c.webhook_secret_hash = String(params[2] ?? c.webhook_secret_hash);
    c.updated_at = new Date();
    saveLocalStore(store);
    return ok([c as unknown as Record<string, unknown>], 1);
  }

  if (/UPDATE\s+integration_connectors\s+SET\s+events_processed\s*=\s*events_processed\s*\+\s*\$1/i.test(sql)) {
    const incProcessed = Number(params[0] ?? 0);
    const incErrors = Number(params[1] ?? 0);
    const id = String(params[2] ?? "");
    const c = seed.integrationConnectors.find((x) => x.id === id);
    if (!c) return ok([], 0);
    c.events_processed += incProcessed;
    c.errors_count += incErrors;
    c.last_sync_at = new Date();
    c.updated_at = new Date();
    saveLocalStore(store);
    return ok([c as unknown as Record<string, unknown>], 1);
  }

  if (/UPDATE\s+integration_connectors\s+SET\s+name\s*=\s*\$1/i.test(sql)) {
    const id = String(params[6] ?? "");
    const orgId = String(params[7] ?? "");
    const c = seed.integrationConnectors.find((x) => x.id === id && x.org_id === orgId);
    if (!c) return ok([], 0);
    c.name = String(params[0] ?? c.name);
    c.status = String(params[1] ?? c.status) as "ACTIVE" | "PAUSED";
    c.autonomy_mode = String(params[2] ?? c.autonomy_mode) as
      | "FULL_AUTONOMOUS"
      | "ASSISTED_APPROVAL"
      | "SYNC_ONLY";
    c.outbound_webhook_url = params[3] != null ? String(params[3]) : null;
    try {
      c.outbound_events =
        typeof params[4] === "string"
          ? JSON.parse(params[4])
          : Array.isArray(params[4])
            ? (params[4] as string[])
            : c.outbound_events;
    } catch {
      // keep existing
    }
    try {
      c.field_mapping =
        typeof params[5] === "string"
          ? JSON.parse(params[5])
          : ((params[5] as Record<string, string>) ?? c.field_mapping);
    } catch {
      // keep existing
    }
    c.updated_at = new Date();
    saveLocalStore(store);
    return ok([c as unknown as Record<string, unknown>], 1);
  }

  if (/DELETE\s+FROM\s+integration_connectors\s+WHERE\s+id\s*=\s*\$1\s+AND\s+org_id\s*=\s*\$2/i.test(sql)) {
    const id = String(params[0] ?? "");
    const orgId = String(params[1] ?? "");
    const before = seed.integrationConnectors.length;
    seed.integrationConnectors = seed.integrationConnectors.filter(
      (c) => !(c.id === id && c.org_id === orgId),
    );
    if (seed.integrationConnectors.length !== before) saveLocalStore(store);
    return ok([], before - seed.integrationConnectors.length);
  }

  if (/FROM\s+integration_events\s+WHERE\s+org_id\s*=\s*\$1\s+AND\s+connector_id\s*=\s*\$2\s+AND\s+idempotency_key\s*=\s*\$3/i.test(sql)) {
    const orgId = String(params[0] ?? "");
    const connectorId = String(params[1] ?? "");
    const key = String(params[2] ?? "");
    const found = seed.integrationEvents.find(
      (e) =>
        e.org_id === orgId &&
        e.connector_id === connectorId &&
        e.idempotency_key === key &&
        e.status === "PROCESSED",
    );
    return found ? ok([found as unknown as Record<string, unknown>], 1) : ok([]);
  }

  if (/FROM\s+integration_events\s+WHERE\s+org_id\s*=\s*\$1/i.test(sql)) {
    const orgId = String(params[0] ?? "");
    const limit = Number(params[1] ?? 50);
    const rows = seed.integrationEvents
      .filter((e) => e.org_id === orgId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, limit);
    return ok(rows as unknown as Record<string, unknown>[]);
  }

  if (/INSERT INTO integration_events/i.test(sql)) {
    const parseJson = <T,>(val: unknown, fallback: T): T => {
      if (val && typeof val === "object") return val as T;
      if (typeof val === "string") {
        try {
          return JSON.parse(val) as T;
        } catch {
          return fallback;
        }
      }
      return fallback;
    };
    const ev = {
      id: String(params[0] ?? `iev-${Date.now()}`),
      org_id: String(params[1] ?? ""),
      connector_id: String(params[2] ?? ""),
      connector_name: String(params[3] ?? ""),
      direction: (String(params[4] ?? "INBOUND") as "INBOUND" | "OUTBOUND"),
      format: String(params[5] ?? "JSON"),
      entity_type: String(params[6] ?? "ORDER"),
      status: (String(params[7] ?? "PROCESSED") as
        | "PROCESSED"
        | "DUPLICATE"
        | "FAILED"
        | "DELIVERED"),
      idempotency_key: params[8] != null ? String(params[8]) : null,
      external_ref: params[9] != null ? String(params[9]) : null,
      shipment_ref: params[10] != null ? String(params[10]) : null,
      order_ref: params[11] != null ? String(params[11]) : null,
      mapped_by: String(params[12] ?? "HEURISTIC"),
      summary: String(params[13] ?? ""),
      delegated_agents: parseJson<string[]>(params[14], []),
      raw_preview: String(params[15] ?? ""),
      normalized_payload: parseJson<Record<string, unknown>>(params[16], {}),
      outbound_status: params[17] != null ? String(params[17]) : null,
      latency_ms: Number(params[18] ?? 0),
      error: params[19] != null ? String(params[19]) : null,
      created_at: new Date(),
    };
    seed.integrationEvents.unshift(ev);
    if (seed.integrationEvents.length > 250) {
      seed.integrationEvents = seed.integrationEvents.slice(0, 250);
    }
    saveLocalStore(store);
    return ok([ev as unknown as Record<string, unknown>], 1);
  }

  // Telemetry vehicle GPS update
  if (/UPDATE conveyances[\s\S]*(?:last_lat|identifiers)/i.test(sql)) {
    const isJsonbForm = /identifiers/i.test(sql) && params.length >= 5;
    const lat = String(params[0] ?? "");
    const lon = String(params[1] ?? "");
    const speedRaw = params[2] != null && String(params[2]) !== "" ? String(params[2]) : null;
    const reg = String(isJsonbForm ? (params[4] ?? "") : (params[3] ?? "")).trim().toUpperCase();
    const conv = seed.conveyances.find((c) => c.registration.toUpperCase() === reg);
    if (conv) {
      conv.last_lat = lat;
      conv.last_lon = lon;
      conv.last_speed = speedRaw;
      conv.last_seen_at = new Date();
      saveLocalStore(store);
      return ok([{ id: conv.id, registration: conv.registration }], 1);
    }
    // Create a tracked external fleet conveyance if unseen so GPS telemetry shows on Fleet immediately
    const newConv = {
      id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      mode: "ROAD",
      kind: "EXTERNAL_GPS",
      registration: reg || `TRK-${Date.now().toString().slice(-4)}`,
      carrier_code: "EXT",
      carrier_name: "External Connected Fleet",
      capacity_kg: "15000",
      capacity_cbm: "45",
      reefer: false,
      hazmat_certified: false,
      active: true,
      assigned_to: null,
      leg_state: "IN_TRANSIT",
      last_seen_at: new Date(),
      last_lat: lat,
      last_lon: lon,
      last_speed: speedRaw,
    };
    seed.conveyances.unshift(newConv);
    saveLocalStore(store);
    return ok([{ id: newConv.id, registration: newConv.registration }], 1);
  }

  if (/FROM shipment_legs l\s+JOIN conveyances v/i.test(sql)) {
    const reg = String(params[0] ?? "").trim().toUpperCase();
    const conv = seed.conveyances.find((c) => c.registration.toUpperCase() === reg);
    if (!conv?.assigned_to) return ok([]);
    const ship = seed.shipments.find((s) => s.reference === conv.assigned_to);
    return ship ? ok([{ shipment_id: ship.id }]) : ok([]);
  }

  if (/INSERT INTO tracking_events/i.test(sql)) {
    const shipmentId = String(params[0] ?? "");
    const ship = shipById(shipmentId);
    if (ship && params[1] != null && params[2] != null) {
      const conv = seed.conveyances.find((c) => c.assigned_to === ship.reference);
      if (conv) {
        conv.last_lat = String(params[1]);
        conv.last_lon = String(params[2]);
        conv.last_speed = params[3] != null ? String(params[3]) : conv.last_speed;
        conv.last_seen_at = new Date();
        saveLocalStore(store);
      }
    }
    return ok([], 1);
  }

  if (/SELECT id FROM warehouses WHERE upper\(code\)/i.test(sql)) {
    const code = String(params[0] ?? "").trim().toUpperCase();
    const wh = seed.warehouses.find((w) => w.code.toUpperCase() === code);
    return wh ? ok([{ id: wh.id }]) : ok([]);
  }

  if (/INSERT INTO warehouses\s*\(/i.test(sql)) {
    const code = String(params[0] ?? "MAIN-WH").trim().toUpperCase();
    const name = String(params[1] ?? code);
    const existing = seed.warehouses.find((w) => w.code.toUpperCase() === code);
    if (existing) return ok([{ id: existing.id }], 1);
    const newWh = {
      id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      code,
      name,
      dispatch_lead_hours: "8",
      handles_hazmat: false,
      handles_reefer: false,
      active: true,
      city: "Lagos",
      country: "NG",
      latitude: "6.5244",
      longitude: "3.3792",
      skus: "0",
      on_hand: "0",
      reserved: "0",
    };
    seed.warehouses.unshift(newWh);
    saveLocalStore(store);
    return ok([{ id: newWh.id }], 1);
  }

  // Warehouse inventory sync upsert
  if (/INSERT INTO inventory/i.test(sql)) {
    const rawWh = String(params[0] ?? "MAIN-WH").trim();
    const byId = seed.warehouses.find((w) => w.id === rawWh);
    const wh = (byId ? byId.code : rawWh).toUpperCase();
    const sku = String(params[1] ?? "SKU-UNKNOWN").trim().toUpperCase();
    const onHand = Math.max(0, Math.round(Number(params[2] ?? 0)));
    const reserved = Math.min(onHand, Math.max(0, Math.round(Number(params[3] ?? 0))));
    const available = Math.max(0, onHand - reserved);
    const existing = seed.inventory.find(
      (i) => i.warehouse.toUpperCase() === wh && i.sku.toUpperCase() === sku,
    );
    if (existing) {
      existing.on_hand = onHand;
      existing.reserved = reserved;
      existing.available = available;
    } else {
      seed.inventory.unshift({
        warehouse: wh,
        sku,
        on_hand: onHand,
        reserved,
        available,
      });
    }
    if (byId) {
      const whItems = seed.inventory.filter((i) => i.warehouse.toUpperCase() === wh);
      byId.skus = String(whItems.length);
      byId.on_hand = String(whItems.reduce((sum, i) => sum + i.on_hand, 0));
      byId.reserved = String(whItems.reduce((sum, i) => sum + i.reserved, 0));
    }
    saveLocalStore(store);
    return ok([{ warehouse: wh, sku, on_hand: onHand, reserved, available }], 1);
  }

  if (/FROM insights/i.test(sql)) {
    return ok([]);
  }

  if (/INSERT INTO (?:channel_connections|policies)/i.test(sql)) {
    return ok([], 1);
  }

  // Fallback for unhandled queries
  return ok([]);
}

function createLocalClient(): PoolClient {
  return {
    query: (async (
      textOrConfig: string | { text: string; values?: unknown[] },
      values?: unknown[],
    ) => {
      const text =
        typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
      const params =
        typeof textOrConfig === "string" ? values : textOrConfig.values;
      return localQuery(text, params);
    }) as PoolClient["query"],
    release: () => {},
  } as unknown as PoolClient;
}

const PG_RETRY_COOLDOWN_MS = 60_000;

function isPgInCooldown(): boolean {
  return (
    typeof globalForPg.pgUnavailableUntil === "number" &&
    Date.now() < globalForPg.pgUnavailableUntil
  );
}

function markPgUnavailable(): void {
  globalForPg.pgUnavailableUntil = Date.now() + PG_RETRY_COOLDOWN_MS;
}

function clearPgCooldown(): void {
  globalForPg.pgUnavailableUntil = undefined;
}

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL?.trim());

let realPool: Pool | null = null;
if (hasDatabaseUrl) {
  try {
    realPool =
      globalForPg.logisticsPool ??
      new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
    if (process.env.NODE_ENV !== "production") {
      globalForPg.logisticsPool = realPool;
    }
  } catch {
    realPool = null;
  }
}

export const pool = {
  connect: async (): Promise<PoolClient> => {
    if (!realPool || isPgInCooldown()) return createLocalClient();
    try {
      const client = await realPool.connect();
      clearPgCooldown();
      return client;
    } catch (err) {
      if (isConnectionError(err)) {
        markPgUnavailable();
        return createLocalClient();
      }
      throw err;
    }
  },
  query: async (
    textOrConfig: string | { text: string; values?: unknown[] },
    values?: unknown[],
  ) => {
    const text =
      typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
    const params =
      typeof textOrConfig === "string" ? values : textOrConfig.values;
    if (!realPool || isPgInCooldown()) return localQuery(text, params);
    try {
      const res = await realPool.query(textOrConfig as string, values);
      clearPgCooldown();
      return res;
    } catch (err) {
      if (isConnectionError(err)) {
        markPgUnavailable();
        return localQuery(text, params);
      }
      throw err;
    }
  },
} as unknown as Pool;

// The role application queries run as. It owns nothing and has no BYPASSRLS,
// which is the only reason migration 016's policies apply at all — the
// connection role is a superuser, and superusers ignore row level security
// entirely. See migrations/017_app_role.sql.
const APP_ROLE = "logistics_app";

function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string })?.code;
  if (
    code === "ECONNREFUSED" ||
    code === "EACCES" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET"
  ) {
    return true;
  }
  if (err instanceof AggregateError) {
    return true;
  }
  const cause = (err as { cause?: unknown }).cause;
  return cause ? isConnectionError(cause) : false;
}

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
  if (!realPool || isPgInCooldown()) {
    return fn(createLocalClient());
  }

  let client: PoolClient;
  try {
    client = await realPool.connect();
    clearPgCooldown();
  } catch (err) {
    if (isConnectionError(err)) {
      markPgUnavailable();
      return fn(createLocalClient());
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

const orgScopeStorage = new AsyncLocalStorage<string | null>();

export function runWithOrgScope<T>(
  orgId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  return orgScopeStorage.run(orgId, fn);
}

async function resolveCurrentOrgId(): Promise<string | null> {
  const scoped = orgScopeStorage.getStore();
  if (scoped !== undefined) return scoped;
  try {
    const { currentUser } = await import("./auth");
    const user = await currentUser();
    return user?.orgId ?? null;
  } catch {
    return null;
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
  const orgId = await resolveCurrentOrgId();
  return withScope(orgId, async (client) => {
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
  const orgId = await resolveCurrentOrgId();
  return withScope(orgId, async (client) => {
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
  if (!realPool || isPgInCooldown()) return false;
  try {
    await realPool.query("SELECT 1");
    clearPgCooldown();
    return true;
  } catch (err) {
    if (isConnectionError(err)) {
      markPgUnavailable();
    }
    return false;
  }
}
