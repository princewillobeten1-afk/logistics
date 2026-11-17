import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryResult } from "pg";

import {
  createOperationalSeed,
  generateMockAssistantTurn,
  generateMockSupportReplyMessage,
  reviveSeedDates,
  type OperationalSeed,
} from "./mock-data";

// Next dev reloads modules on every edit; without a global the pool would be
// recreated per reload and leak connections until Postgres refuses new ones.
const globalForPg = globalThis as unknown as {
  logisticsPool?: Pool;
  logisticsMockStore?: MockStore;
  logisticsMockMtimeMs?: number;
};

const MOCK_STORE_PATH = "/tmp/logistics-mock-store.json";

type MockOrg = { id: string; name: string; slug: string; active: boolean };
type MockUser = {
  id: string;
  org_id: string;
  email: string;
  password_hash: string;
  role: string;
  name: string | null;
  active: boolean;
  last_login_at: Date | null;
};
type MockSession = {
  token: string;
  user_id: string;
  expires_at: Date;
  ip_address: string | null;
  user_agent: string | null;
};
type MockReset = {
  token: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
  ip_address: string | null;
};

type MockStore = {
  orgs: MockOrg[];
  users: MockUser[];
  sessions: MockSession[];
  resets: MockReset[];
  seed: OperationalSeed;
};

function reviveMockStore(raw: unknown): MockStore {
  const data = (raw ?? {}) as Partial<MockStore>;
  return {
    orgs: Array.isArray(data.orgs) ? data.orgs : [],
    users: Array.isArray(data.users)
      ? data.users.map((u) => ({
          ...u,
          last_login_at: u.last_login_at ? new Date(u.last_login_at) : null,
        }))
      : [],
    sessions: Array.isArray(data.sessions)
      ? data.sessions.map((s) => ({
          ...s,
          expires_at: new Date(s.expires_at),
        }))
      : [],
    resets: Array.isArray(data.resets)
      ? data.resets.map((r) => ({
          ...r,
          expires_at: new Date(r.expires_at),
          created_at: new Date(r.created_at),
          used_at: r.used_at ? new Date(r.used_at) : null,
        }))
      : [],
    seed: reviveSeedDates(data.seed),
  };
}

function getMockStore(): MockStore {
  try {
    if (existsSync(MOCK_STORE_PATH)) {
      const mtimeMs = statSync(MOCK_STORE_PATH).mtimeMs;
      if (
        !globalForPg.logisticsMockStore ||
        globalForPg.logisticsMockMtimeMs !== mtimeMs
      ) {
        const parsed = JSON.parse(readFileSync(MOCK_STORE_PATH, "utf8"));
        globalForPg.logisticsMockStore = reviveMockStore(parsed);
        globalForPg.logisticsMockMtimeMs = mtimeMs;
      }
    }
  } catch {
    // Fall back to in-memory store if temp file read fails
  }

  if (!globalForPg.logisticsMockStore) {
    globalForPg.logisticsMockStore = {
      orgs: [],
      users: [],
      sessions: [],
      resets: [],
      seed: createOperationalSeed(),
    };
  }
  return globalForPg.logisticsMockStore;
}

function saveMockStore(store: MockStore): void {
  globalForPg.logisticsMockStore = store;
  try {
    writeFileSync(MOCK_STORE_PATH, JSON.stringify(store), "utf8");
    globalForPg.logisticsMockMtimeMs = statSync(MOCK_STORE_PATH).mtimeMs;
  } catch {
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

function mockQuery(
  text: string,
  params: unknown[] = [],
): QueryResult<Record<string, unknown>> {
  const sql = text.trim();
  const store = getMockStore();
  const seed = store.seed;

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

  // Fallback org lookup for external webhooks / unauthenticated autonomous intake
  if (/FROM organisations/i.test(sql) && /LIMIT 1/i.test(sql) && !/WHERE slug/i.test(sql)) {
    const firstOrg = store.orgs.find((o) => o.active) ?? store.orgs[0];
    if (firstOrg) {
      return ok([{ id: firstOrg.id, name: firstOrg.name }]);
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
    const org: MockOrg = {
      id: randomUUID(),
      name: String(params[0] ?? ""),
      slug: String(params[1] ?? ""),
      active: true,
    };
    store.orgs.push(org);
    saveMockStore(store);
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
    const user: MockUser = {
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
    saveMockStore(store);
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
    saveMockStore(store);
    return ok([], 1);
  }

  if (/UPDATE users SET last_login_at/i.test(sql)) {
    const id = String(params[0] ?? "");
    const user = store.users.find((u) => u.id === id);
    if (user) {
      user.last_login_at = new Date();
      saveMockStore(store);
    }
    return ok([], user ? 1 : 0);
  }

  if (/DELETE FROM sessions WHERE token = \$1/i.test(sql)) {
    const token = String(params[0] ?? "");
    const before = store.sessions.length;
    store.sessions = store.sessions.filter((s) => s.token !== token);
    if (store.sessions.length !== before) saveMockStore(store);
    return ok([], before - store.sessions.length);
  }

  if (/DELETE FROM sessions WHERE user_id = \$1/i.test(sql)) {
    const userId = String(params[0] ?? "");
    const before = store.sessions.length;
    store.sessions = store.sessions.filter((s) => s.user_id !== userId);
    if (store.sessions.length !== before) saveMockStore(store);
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
    saveMockStore(store);
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
      saveMockStore(store);
    }
    return ok([], user ? 1 : 0);
  }

  if (/UPDATE password_resets SET used_at/i.test(sql)) {
    const token = String(params[0] ?? "");
    const reset = store.resets.find((r) => r.token === token);
    if (reset) {
      reset.used_at = new Date();
      saveMockStore(store);
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
    saveMockStore(store);
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

  // 7. Assistant / Track / Approval shipment lookup
  if (/SELECT id(?:,\s*reference)? FROM shipments WHERE upper\(reference\) = (?:upper\(\$1\)|\$1)/i.test(sql)) {
    const ref = String(params[0] ?? "").trim().toUpperCase();
    const s = seed.shipments.find((x) => x.reference.toUpperCase() === ref);
    return s ? ok([{ id: s.id, reference: s.reference }], 1) : ok([]);
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
    saveMockStore(store);
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
    saveMockStore(store);
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
      saveMockStore(store);
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
    saveMockStore(store);
    return ok([], before - seed.assistantMessages.length);
  }

  // 9. Get single shipment detail (case-insensitive for ergonomic quick-jump)
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
    const rows = seed.shipments
      .filter((s) => (!stateFilter ? true : s.state === stateFilter))
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
      .slice(0, 100);
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

  // 14. Quotes
  if (/FROM quotes q JOIN carriers c/i.test(sql)) {
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
    saveMockStore(store);
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
      saveMockStore(store);
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
    // Handle channel configuration mutations directly in mock mode
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
      saveMockStore(store);
      return ok([], 1);
    }

    // If caller already executed inline (e.g. server-side Gemini agent) and inserted DONE, record only the work item
    if (/VALUES\s*\([^)]*'DONE'/i.test(sql) || /,\s*'DONE'\s*,/i.test(sql)) {
      const shipmentId = params[0] != null ? String(params[0]) : null;
      const kindMatch = sql.match(/'([a-z0-9_]+\.[a-z0-9_]+)'/i);
      const kind = kindMatch ? kindMatch[1] : String(params[1] ?? "agent.run");
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
      saveMockStore(store);
      return ok([], 1);
    }

    // Handle planning.optimize_fleet job in fallback mode
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
      seed.agentRuns.unshift({
        id: `ar-${Date.now()}`,
        shipment_id: null,
        agent: "route-optimizer",
        job: "Optimize fleet routes",
        model: "nvidia/cuopt-cvrptw",
        status: "OK",
        latency_ms: 340,
        prompt_tokens: 0,
        completion_tokens: 0,
        created_at: now,
        response: { reasoning: "Dispatched CVRPTW matrix optimization across 4 vehicles." },
      });
      saveMockStore(store);
      return ok([], 1);
    }

    // Handle shipment.assist -> immediately compute fallback assistant reply
    if (/shipment\.assist/i.test(sql)) {
      const shipmentId = String(params[0] ?? "");
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(params[1] ?? "{}"));
      } catch {
        payload = {};
      }
      const pendingId = String(payload.message_id ?? "");
      const pendingMsg = seed.assistantMessages.find((m) => m.id === pendingId);
      const lastUser = [...seed.assistantMessages]
        .reverse()
        .find((m) => m.shipment_id === shipmentId && m.role === "user");
      const generated = generateMockAssistantTurn(
        seed,
        shipmentId,
        pendingMsg?.user_id ?? "mock-user",
        lastUser?.body ?? "",
      );
      if (pendingMsg) {
        pendingMsg.body = generated.body;
        pendingMsg.state = "DONE";
        pendingMsg.confidence = generated.confidence;
        pendingMsg.next_step = generated.next_step;
      } else {
        seed.assistantMessages.push(generated);
      }
      seed.agentRuns.unshift({
        id: `ar-${Date.now()}`,
        shipment_id: shipmentId,
        agent: "shipment-assistant",
        job: "Explain shipment state",
        model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
        status: "OK",
        latency_ms: 410,
        prompt_tokens: 620,
        completion_tokens: 185,
        created_at: now,
        response: { reasoning: generated.next_step },
      });
      saveMockStore(store);
      return ok([], 1);
    }

    // Handle support.reply -> immediately append fallback support reply
    if (/support\.reply/i.test(sql)) {
      const shipmentId = params[0] != null ? String(params[0]) : null;
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(params[1] ?? "{}"));
      } catch {
        payload = {};
      }
      const contactId = String(payload.contact_id ?? "");
      const commId = String(payload.communication_id ?? "");
      const inbound = seed.communications.find((c) => c.id === commId);
      const reply = generateMockSupportReplyMessage(
        seed,
        shipmentId,
        contactId,
        inbound?.body ?? "",
      );
      seed.communications.push(reply);
      seed.workItems.unshift({
        id: `wi-${Date.now()}`,
        shipment_id: shipmentId,
        kind: "support.reply",
        state: "DONE",
        attempts: 1,
        last_error: null,
        run_after: now,
        created_at: now,
        updated_at: now,
      });
      saveMockStore(store);
      return ok([], 1);
    }

    // Generic or explicit work item (e.g. autonomous.*, support.*, agent.*)
    const shipmentId = params[0] != null ? String(params[0]) : null;
    const literalKindMatch = sql.match(/'([a-z0-9_]+\.[a-z0-9_]+)'/i);
    const kind = literalKindMatch
      ? literalKindMatch[1]
      : String(params[1] ?? "work.step");
    const isDone = /,\s*'DONE'\s*,/i.test(sql) || /\(\s*[^,]+,\s*[^,]+,\s*'DONE'/i.test(sql);
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
    saveMockStore(store);
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
    saveMockStore(store);
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
      customer_id: seed.customers[0]?.id ?? "cust-1",
      customer_ref: customerRef,
      origin,
      destination,
      cargo,
      deadline,
      allocation: { warehouse: "LOS-HUB-1", status: "ALLOCATED" },
      plan,
      booking: null,
      created_via: createdVia,
      created_at: now,
      updated_at: now,
    });
    saveMockStore(store);
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
    saveMockStore(store);
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
    let detail: Record<string, unknown> = {};
    try {
      detail =
        typeof params[4] === "string"
          ? JSON.parse(params[4])
          : ((params[4] as Record<string, unknown>) ?? {});
    } catch {
      detail = {};
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
    saveMockStore(store);
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
    saveMockStore(store);
    return ok([{ id }], 1);
  }

  // 17. Agent runs + Model usage + Activity feed
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

  if (/FROM communications m[\s\S]*WHERE m\.contact_id = \$1/i.test(sql)) {
    const contactId = String(params[0] ?? "");
    const rows = seed.communications
      .filter((m) => m.contact_id === contactId)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
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

  if (/UPDATE shipments\s+SET plan = \$1::jsonb/i.test(sql)) {
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
      saveMockStore(store);
      return ok([{ id: ship.id, reference: ship.reference }], 1);
    }
    return ok([], 0);
  }

  if (/INSERT INTO communications/i.test(sql)) {
    const id = `comm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const isOutbound = /'OUTBOUND'/i.test(sql) || String(params[2] ?? "").toUpperCase() === "OUTBOUND";
    const channelMatch = sql.match(/'(EMAIL|WIDGET|PORTAL|TELEGRAM|WHATSAPP)'/i);
    if (channelMatch) {
      seed.communications.push({
        id,
        shipment_id: params[0] != null ? String(params[0]) : null,
        customer_id: null,
        contact_id: params[1] != null ? String(params[1]) : null,
        channel: channelMatch[1].toUpperCase(),
        direction: isOutbound ? "OUTBOUND" : "INBOUND",
        recipient: params[3] != null ? String(params[3]) : null,
        subject: null,
        body: String(params[2] ?? ""),
        state: isOutbound ? "SENT" : "RECEIVED",
        safety_checked: true,
        created_at: new Date(),
      });
    } else {
      // Parameterized: (shipment_id, contact_id, channel, direction, body, recipient, state, safety_checked)
      const ch = String(params[2] ?? "WIDGET").toUpperCase();
      const dir = String(params[3] ?? "INBOUND").toUpperCase() === "OUTBOUND" ? "OUTBOUND" : "INBOUND";
      seed.communications.push({
        id,
        shipment_id: params[0] != null ? String(params[0]) : null,
        customer_id: null,
        contact_id: params[1] != null ? String(params[1]) : null,
        channel: ch,
        direction: dir,
        recipient: params[5] != null ? String(params[5]) : null,
        subject: null,
        body: String(params[4] ?? ""),
        state: dir === "OUTBOUND" ? "SENT" : "RECEIVED",
        safety_checked: true,
        created_at: new Date(),
      });
    }
    saveMockStore(store);
    return ok([{ id }], 1);
  }

  if (/UPDATE channel_contacts[\s\S]*escalated_at/i.test(sql)) {
    const reason = params[0] != null ? String(params[0]) : "Escalated by AI support";
    const contactId = String(params[1] ?? "");
    const c = seed.contacts.find((x) => x.id === contactId);
    if (c) {
      c.escalated_at = new Date();
      c.escalation_reason = reason;
      saveMockStore(store);
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
      saveMockStore(store);
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
      saveMockStore(store);
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
    saveMockStore(store);
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
    const baseline = [1, 0, 2, 1, 3, 2, 1, 4, 2, 3, 2, 5, 3, 2];
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
        created: String(Math.max(actualCreated, baseline[13 - i] ?? 0)),
        closed: String(actualClosed),
      });
    }
    return ok(days);
  }

  // 24. Settings: Channel connections, Policy, Currencies, FX rates, Migrations
  if (/UPDATE channel_connections SET last_inbound_at/i.test(sql)) {
    const chName = String(params[0] ?? "").toUpperCase();
    const ch = seed.channels.find((c) => c.channel === chName);
    if (ch) {
      ch.last_inbound_at = new Date();
      saveMockStore(store);
    }
    return ok([], ch ? 1 : 0);
  }

  if (/FROM channel_connections[\s\S]*WHERE channel = \$1/i.test(sql)) {
    const chName = String(params[0] ?? "").toUpperCase();
    return ok(
      seed.channels.filter((c) => c.channel === chName) as unknown as Record<string, unknown>[],
    );
  }

  if (/FROM channel_connections/i.test(sql)) {
    return ok(seed.channels as unknown as Record<string, unknown>[]);
  }

  if (/FROM policies/i.test(sql)) {
    return ok([
      {
        version: 3,
        name: "West Africa Corridor Controls v3",
        created_at: new Date(Date.now() - 14 * 86_400_000),
        rules: {
          base_currency: "NGN",
          fx_max_age_hours: 24,
          auto_execute_tiers: [1],
          default_decision: "REQUIRE_APPROVAL",
          actions: {
            "carrier.book": {
              auto_approve_below_minor: 50000000,
              hard_deny_above_minor: 500000000,
            },
            "customs.clear": {
              auto_approve_below_minor: 25000000,
              hard_deny_above_minor: 250000000,
            },
            "expedite.reroute": {
              auto_approve_below_minor: 0,
              hard_deny_above_minor: 300000000,
            },
            "claim.settle": {
              auto_approve_below_minor: null,
              hard_deny_above_minor: 150000000,
            },
          },
          require_approval_when: {
            unapproved_carrier: true,
            hazmat_cargo: true,
            international_border_leg: true,
            variance_above_quote_minor: 15000000,
          },
        },
      },
    ]);
  }

  if (/FROM currencies/i.test(sql)) {
    return ok([
      { code: "EUR", name: "Euro", minor_unit_exponent: 2 },
      { code: "GBP", name: "Pound Sterling", minor_unit_exponent: 2 },
      { code: "NGN", name: "Nigerian Naira", minor_unit_exponent: 2 },
      { code: "USD", name: "US Dollar", minor_unit_exponent: 2 },
    ]);
  }

  if (/FROM fx_rates/i.test(sql)) {
    const asOf = new Date(Date.now() - 2 * 3_600_000);
    return ok([
      { base: "USD", quote: "NGN", rate: "1560", as_of: asOf, source: "CBN / FMDQ" },
      { base: "EUR", quote: "NGN", rate: "1695", as_of: asOf, source: "ECB / FMDQ" },
      { base: "GBP", quote: "NGN", rate: "1980", as_of: asOf, source: "BoE / FMDQ" },
    ]);
  }

  if (/FROM schema_migrations/i.test(sql)) {
    const appliedAt = new Date(Date.now() - 3 * 86_400_000);
    return ok(
      [
        "001_core",
        "005_operations",
        "010_channels",
        "015_identity",
        "016_tenancy",
        "020_assistant",
        "021_password_resets",
      ].map((version) => ({ version, applied_at: appliedAt })),
    );
  }

  // Fallback for unhandled queries
  return ok([]);
}

function createMockClient(): PoolClient {
  return {
    query: (async (
      textOrConfig: string | { text: string; values?: unknown[] },
      values?: unknown[],
    ) => {
      const text =
        typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
      const params =
        typeof textOrConfig === "string" ? values : textOrConfig.values;
      return mockQuery(text, params);
    }) as PoolClient["query"],
    release: () => {},
  } as unknown as PoolClient;
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
  } catch (err) {
    console.warn("[AI Studio] Database pool init failed — using in-memory mock", err);
    realPool = null;
  }
} else {
  console.warn("[AI Studio] DATABASE_URL is not set — using in-memory mock store");
}

export const pool = (realPool ?? {
  connect: async () => createMockClient(),
  query: async (
    textOrConfig: string | { text: string; values?: unknown[] },
    values?: unknown[],
  ) => {
    const text =
      typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
    const params =
      typeof textOrConfig === "string" ? values : textOrConfig.values;
    return mockQuery(text, params);
  },
}) as unknown as Pool;

// The role application queries run as. It owns nothing and has no BYPASSRLS,
// which is the only reason migration 016's policies apply at all — the
// connection role is a superuser, and superusers ignore row level security
// entirely. See migrations/017_app_role.sql.
const APP_ROLE = "logistics_app";

function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    err instanceof AggregateError
  );
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
  if (!realPool) {
    return fn(createMockClient());
  }

  let client: PoolClient;
  try {
    client = await realPool.connect();
  } catch (err) {
    if (isConnectionError(err)) {
      console.warn(
        "[AI Studio] Database unreachable — falling back to in-memory mock",
      );
      return fn(createMockClient());
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
  if (!realPool) return false;
  try {
    await realPool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
