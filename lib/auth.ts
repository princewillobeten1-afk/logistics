import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { identityQuery, runSchemaCompatDdl, transaction } from "./db";
import { isMailConfigured, sendMailDetail } from "./mail";
import {
  hasDepartmentAccess,
  normalizeBranchCodes,
  normalizeDepartments,
  type WorkspaceDepartment,
} from "./tenant-guard";

// Hand-wrapped rather than promisify()'d: promisify resolves to scrypt's
// three-argument overload and silently drops the options object, which is
// where N, r and p live — the parameters that have to match what Python used.
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derived) =>
      err ? reject(err) : resolve(derived),
    );
  });
}

export const SESSION_COOKIE = "logistics_session";
const SESSION_DAYS = 14;

/** Mirrors `Role` in src/logistics/auth.py. Both runtimes read the same rows,
 *  so the two must agree — tests/test_auth.py owns the definition. */
export type Role = "VIEWER" | "DISPATCHER" | "APPROVER" | "ADMIN";
export type Permission = "READ" | "EDIT_SHIPMENT" | "APPROVE" | "ADMINISTER";

const GRANTS: Record<Role, Permission[]> = {
  VIEWER: ["READ"],
  DISPATCHER: ["READ", "EDIT_SHIPMENT"],
  // Deliberately not EDIT_SHIPMENT: whoever authorises the spend should not
  // be the one who arranged it.
  APPROVER: ["READ", "APPROVE"],
  ADMIN: ["READ", "EDIT_SHIPMENT", "APPROVE", "ADMINISTER"],
};

export function may(role: string | undefined, permission: Permission): boolean {
  // An unrecognised role grants nothing: a typo must not read as permission.
  return GRANTS[role as Role]?.includes(permission) ?? false;
}

export type SessionUser = {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  name: string | null;
  role: Role;
  departments: WorkspaceDepartment[];
  branchCodes: string[];
};

function toSessionUser(row: SessionRow): SessionUser {
  return {
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    email: row.email,
    name: row.name,
    role: row.role,
    departments: normalizeDepartments(row.departments),
    branchCodes: normalizeBranchCodes(row.branch_codes),
  };
}

let schemaCompatPromise: Promise<void> | null = null;

async function ensureIdentitySchemaCompat(): Promise<void> {
  if (!schemaCompatPromise) {
    schemaCompatPromise = runSchemaCompatDdl([
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS departments TEXT[] NOT NULL DEFAULT ARRAY['ALL']::TEXT[]`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_codes TEXT[] NOT NULL DEFAULT ARRAY['ALL']::TEXT[]`,
      `CREATE TABLE IF NOT EXISTS password_resets (
        token TEXT PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ip_address TEXT
      )`,
      `ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_version_key`,
      `DROP INDEX IF EXISTS policies_version_key`,
      `CREATE UNIQUE INDEX IF NOT EXISTS policies_org_version_idx ON policies (org_id, version)`,
    ]).catch((err) => {
      schemaCompatPromise = null;
      throw err;
    });
  }
  await schemaCompatPromise;
}

function isMissingColumnError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "42703";
}

/**
 * Verifies a raw session token against the active sessions/users/organisations
 * tables. Used by SSE and WebSocket handlers to detect revoked or deactivated
 * sessions mid-stream.
 */
export async function verifyActiveSessionToken(
  token: string | null | undefined,
): Promise<SessionUser | null> {
  if (!token) return null;
  let rows: SessionRow[];
  try {
    rows = await identityQuery<SessionRow>(
      `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role,
              u.departments, u.branch_codes
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN organisations o ON o.id = u.org_id
        WHERE s.token = $1 AND s.expires_at > now()
          AND u.active AND o.active`,
      [token],
    );
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    rows = await identityQuery<SessionRow>(
      `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN organisations o ON o.id = u.org_id
        WHERE s.token = $1 AND s.expires_at > now()
          AND u.active AND o.active`,
      [token],
    );
  }
  if (rows.length === 0) return null;
  return toSessionUser(rows[0]);
}

/**
 * The signed-in user, or null.
 *
 * `cache()` memoises this for the duration of one request, so the dozen
 * queries a page makes resolve the session once rather than a dozen times.
 */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifyActiveSessionToken(token);
});

/** For pages. Sends anyone without a session to the sign-in form. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) {
    const hadCookie = Boolean((await cookies()).get(SESSION_COOKIE)?.value);
    redirect(hadCookie ? "/login?expired=1" : "/login");
  }
  return user;
}

/**
 * For server actions — the actual authorisation boundary for writes.
 *
 * Pages fail safe on their own: with no session there is no org, and RLS
 * returns nothing. Writes need something stronger, because a write does not
 * need to read anything first.
 */
export async function requireRole(permission: Permission): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new Error("Not signed in.");
  if (!may(user.role, permission)) {
    throw new Error(
      `Your role (${user.role}) is not permitted to do that.`,
    );
  }
  return user;
}

export async function requireDepartment(
  department: WorkspaceDepartment,
  permission: Permission = "READ",
): Promise<SessionUser> {
  const user = await requireRole(permission);
  if (!hasDepartmentAccess(user, department)) {
    throw new Error(
      `Your workspace access does not include the ${department} department.`,
    );
  }
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireRole("ADMINISTER");
  if (user.role !== "ADMIN") {
    throw new Error("Workspace administrator privileges are required.");
  }
  return user;
}

// ----------------------------------------------------------- passwords

// scrypt parameters, matching src/logistics/auth.py's hash_password exactly.
// n=2**14 costs ~50ms per hash on ordinary hardware — slow enough to make
// offline cracking expensive, fast enough that signing up does not stall.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export const MIN_PASSWORD_LENGTH = 10;

/**
 * Writes a hash in the same self-describing format Python's `hash_password`
 * produces: `scrypt$n$r$p$salt$hash`. Until self-service signup and password
 * reset existed, only Python ever created a password — the dashboard only
 * verified. Both runtimes read the same `users` table, so a hash written here
 * has to be one Python's `verify_password` can also read.
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error("password must not be empty");
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * SCRYPT_N * SCRYPT_R,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verifies a hash written by Python's `hashlib.scrypt`, format
 * `scrypt$n$r$p$salt$hash`. Both runtimes read the same `users` table, so this
 * has to agree with src/logistics/auth.py exactly — scrypt is a standard, and
 * the parameters travel inside the hash rather than being assumed here.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltHex, digestHex] = parts;

  try {
    const expected = Buffer.from(digestHex, "hex");
    const derived = await scryptAsync(
      password,
      Buffer.from(saltHex, "hex"),
      expected.length,
      {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        // scrypt needs 128 * N * r bytes. Node's 32MB default is too tight for
        // the parameters Python uses, and it throws rather than returning
        // false — which would read as "wrong password" for everyone.
        maxmem: 256 * Number(n) * Number(r),
      },
    );
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    // A malformed hash is not a reason to let anyone in.
    return false;
  }
}

// ------------------------------------------------------------ sessions

export type SessionRow = {
  id: string;
  org_id: string;
  org_name: string;
  email: string;
  name: string | null;
  role: Role;
  departments?: string[] | null;
  branch_codes?: string[] | null;
};

export function isHttpsRequest(head: Headers): boolean {
  const proto =
    (head.get("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase() ??
    "";
  const origin = (head.get("origin") ?? "").trim().toLowerCase();
  const referer = (head.get("referer") ?? "").trim().toLowerCase();
  const rawHost =
    (head.get("x-forwarded-host") ?? head.get("host") ?? "")
      .split(",")[0]
      ?.trim()
      .toLowerCase() ?? "";
  const hostname = rawHost.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");

  // 1. Explicit HTTPS request headers win first.
  if (
    proto === "https" ||
    origin.startsWith("https://") ||
    referer.startsWith("https://")
  ) {
    return true;
  }

  // 2. Localhost / plain HTTP requests must NOT receive Secure cookies, even
  //    when APP_URL points at an external HTTPS deployment or preview URL.
  if (
    proto === "http" ||
    origin.startsWith("http://") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1"
  ) {
    return false;
  }

  // 3. Hosted HTTPS platforms (Cloud Run / Vercel)
  if (hostname.endsWith(".run.app") || hostname.endsWith(".vercel.app")) {
    return true;
  }

  // 4. Fallback when request host/proto headers are absent
  const appUrl = (process.env.APP_URL ?? "").trim().toLowerCase();
  if (appUrl.startsWith("https://")) {
    return true;
  }

  return process.env.NODE_ENV === "production";
}

export function sessionCookieOptions(isHttps: boolean, expires: Date) {
  return {
    httpOnly: true, // unreadable from JavaScript, so XSS cannot lift it
    sameSite: (isHttps ? "none" : "lax") as "none" | "lax",
    secure: isHttps,
    partitioned: isHttps,
    path: "/",
    expires,
  };
}

export type SessionCookieMeta = {
  token: string;
  options: ReturnType<typeof sessionCookieOptions>;
};

/**
 * Issues a session and sets the cookie. Shared by sign-in and sign-up so a
 * freshly created account does not have to be verified a second time right
 * after its password was hashed.
 */
export async function startSessionWithCookie(
  row: SessionRow,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<{ user: SessionUser; cookie: SessionCookieMeta }> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await identityQuery(
    `INSERT INTO sessions (token, user_id, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [token, row.id, expires, meta.ip ?? null, meta.userAgent?.slice(0, 500) ?? null],
  );
  await identityQuery("UPDATE users SET last_login_at = now() WHERE id = $1", [row.id]);

  let head: Headers;
  try {
    head = await headers();
  } catch {
    head = new Headers();
  }
  const isHttps = isHttpsRequest(head);
  const options = sessionCookieOptions(isHttps, expires);

  try {
    (await cookies()).set(SESSION_COOKIE, token, options);
  } catch {
    // Route Handlers also apply session cookie directly onto NextResponse.
  }

  return {
    user: toSessionUser(row),
    cookie: { token, options },
  };
}

async function startSession(
  row: SessionRow,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<SessionUser> {
  const { user } = await startSessionWithCookie(row, meta);
  return user;
}

export type LoginResult =
  | { ok: true; user: SessionUser; cookie?: SessionCookieMeta }
  | { ok: false; error: string };

export async function signIn(
  email: string,
  password: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<LoginResult> {
  await ensureIdentitySchemaCompat();
  const cleanEmail = email.trim();
  type SignInRow = SessionRow & {
    active: boolean;
    org_active: boolean;
    password_hash: string;
  };
  let rows: SignInRow[];
  try {
    rows = await identityQuery<SignInRow>(
      `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role,
              u.departments, u.branch_codes,
              u.active, o.active AS org_active, u.password_hash
         FROM users u JOIN organisations o ON o.id = u.org_id
        WHERE lower(u.email) = lower($1)`,
      [cleanEmail],
    );
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    rows = await identityQuery<SignInRow>(
      `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role,
              u.active, o.active AS org_active, u.password_hash
         FROM users u JOIN organisations o ON o.id = u.org_id
        WHERE lower(u.email) = lower($1)`,
      [cleanEmail],
    );
  }

  const row = rows[0];
  // Hash even when there is no such user, so the response time does not
  // reveal which addresses have accounts.
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);

  if (!row || !ok || !row.active || !row.org_active) {
    // One message for every failure. Saying which half was wrong tells an
    // attacker they have found a real address.
    return { ok: false, error: "Invalid email or password." };
  }

  const started = await startSessionWithCookie(row, meta);
  return { ok: true, user: started.user, cookie: started.cookie };
}

export async function signInWithGoogle(
  input: { email: string; name?: string | null; companyName?: string | null },
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<LoginResult> {
  await ensureIdentitySchemaCompat();
  const email = input.email.trim().toLowerCase();
  if (!email) {
    return { ok: false, error: "Google account did not return an email address." };
  }

  type GoogleExistingRow = SessionRow & { active: boolean; org_active: boolean };
  let existing: GoogleExistingRow[];
  try {
    existing = await identityQuery<GoogleExistingRow>(
      `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role,
              u.departments, u.branch_codes,
              u.active, o.active AS org_active
         FROM users u JOIN organisations o ON o.id = u.org_id
        WHERE lower(u.email) = lower($1)`,
      [email],
    );
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    existing = await identityQuery<GoogleExistingRow>(
      `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role,
              u.active, o.active AS org_active
         FROM users u JOIN organisations o ON o.id = u.org_id
        WHERE lower(u.email) = lower($1)`,
      [email],
    );
  }

  if (existing.length > 0) {
    const row = existing[0];
    if (!row.active || !row.org_active) {
      return { ok: false, error: "This account or workspace is inactive." };
    }
    const started = await startSessionWithCookie(row, meta);
    return { ok: true, user: started.user, cookie: started.cookie };
  }

  const displayName = input.name?.trim() || email.split("@")[0] || "Operator";
  const workspaceName =
    input.companyName?.trim() || `${displayName}'s Workspace`;
  const slug = await uniqueOrgSlug(workspaceName);
  const randomPasswordHash = await hashPassword(
    randomBytes(32).toString("hex"),
  );

  let row: SessionRow;
  try {
    row = await transaction(async (client) => {
      const org = await client.query<{ id: string; name: string }>(
        "INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id, name",
        [workspaceName, slug],
      );
      const orgId = org.rows[0].id;
      const user = await client.query<{
        id: string;
        email: string;
        name: string | null;
        role: Role;
      }>(
        `INSERT INTO users (org_id, email, password_hash, role, name)
         VALUES ($1, $2, $3, 'ADMIN', $4)
         RETURNING id, email, name, role`,
        [orgId, email, randomPasswordHash, displayName],
      );
      await seedNewOrgDefaults(client, orgId);
      return {
        id: user.rows[0].id,
        org_id: orgId,
        org_name: org.rows[0].name,
        email: user.rows[0].email,
        name: user.rows[0].name,
        role: user.rows[0].role,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err, "users_email_idx")) {
      let retry: SessionRow[];
      try {
        retry = await identityQuery<SessionRow>(
          `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role,
                  u.departments, u.branch_codes
             FROM users u JOIN organisations o ON o.id = u.org_id
            WHERE lower(u.email) = lower($1) AND u.active AND o.active`,
          [email],
        );
      } catch (colErr) {
        if (!isMissingColumnError(colErr)) throw colErr;
        retry = await identityQuery<SessionRow>(
          `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role
             FROM users u JOIN organisations o ON o.id = u.org_id
            WHERE lower(u.email) = lower($1) AND u.active AND o.active`,
          [email],
        );
      }
      if (retry[0]) {
        const started = await startSessionWithCookie(retry[0], meta);
        return { ok: true, user: started.user, cookie: started.cookie };
      }
    }
    throw err;
  }

  const started = await startSessionWithCookie(row, meta);
  return { ok: true, user: started.user, cookie: started.cookie };
}

// -------------------------------------------------------------- sign up

/**
 * Self-service signup: creates a brand new organisation and its first user
 * as ADMIN, then signs them in. The Slack/Notion "create a workspace" shape —
 * there is no invite system yet, so joining an *existing* org still goes
 * through `python -m logistics.cli create-user`.
 */
export type SignUpResult =
  | { ok: true; user: SessionUser; cookie?: SessionCookieMeta }
  | { ok: false; error: string };

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "org";
}

/** The base slug, or the first free `base-2`, `base-3`, ... variant.
 *  A last-resort random suffix covers the race between this check and the
 *  insert — rare, and cheaper to handle than to prevent. */
async function uniqueOrgSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const rows = await identityQuery<{ n: string }>(
      "SELECT count(*)::text AS n FROM organisations WHERE slug = $1",
      [candidate],
    );
    if (rows[0].n === "0") return candidate;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return Boolean(e && e.code === "23505" && (!constraint || e.constraint === constraint));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_ORG_CHANNELS: readonly [string, string][] = [
  ["TELEGRAM", "Telegram bot"],
  ["WHATSAPP", "WhatsApp Business"],
  ["GMAIL", "Support mailbox"],
  ["WIDGET", "Website widget"],
];

const DEFAULT_ORG_POLICY = {
  base_currency: "NGN",
  fx_max_age_hours: 24,
  auto_execute_tiers: [0, 1],
  actions: {
    book_shipment: {
      auto_approve_below_minor: 0,
      hard_deny_above_minor: 200_000_000,
      note: "Phase 1: every booking goes to a human. Raise in phase 6.",
    },
    reroute_vehicle: {
      auto_approve_below_minor: 0,
      hard_deny_above_minor: 50_000_000,
      max_cost_increase_pct: 5,
    },
    create_invoice: { auto_approve_below_minor: null },
    send_whatsapp: { auto_approve_below_minor: null },
    send_email: { auto_approve_below_minor: null },
    cancel_shipment: { auto_approve_below_minor: null },
    change_delivery_address: { auto_approve_below_minor: null },
    settle_claim: {
      auto_approve_below_minor: 0,
      hard_deny_above_minor: 100_000_000,
    },
  },
  require_approval_when: {
    unapproved_carrier: true,
    address_change: true,
    hazmat: true,
    temperature_controlled: false,
    customs_uncertain: true,
    cancellation: true,
    sla_breach_risk: true,
    declared_value_above_minor: 500_000_000,
  },
  default_decision: "REQUIRE_APPROVAL",
};

async function seedNewOrgDefaults(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  orgId: string,
): Promise<void> {
  // Scope the remainder of this signup transaction to the new org so RLS
  // allows seeding its default channels and spend policy immediately.
  await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);

  for (const [channel, displayName] of DEFAULT_ORG_CHANNELS) {
    await client.query("SAVEPOINT sp_channel");
    try {
      await client.query(
        `INSERT INTO channel_connections (channel, display_name)
         VALUES ($1, $2)
         ON CONFLICT (org_id, channel) DO NOTHING`,
        [channel, displayName],
      );
      await client.query("RELEASE SAVEPOINT sp_channel");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT sp_channel");
      await client.query("RELEASE SAVEPOINT sp_channel");
    }
  }

  await client.query("SAVEPOINT sp_policy");
  try {
    const existing = (await client.query(
      "SELECT 1 FROM policies WHERE org_id = $1 AND version = 1 LIMIT 1",
      [orgId],
    )) as { rows?: unknown[] } | undefined;
    if (!existing?.rows?.length) {
      await client.query(
        `INSERT INTO policies (version, name, rules, active)
         VALUES (1, 'default conservative', $1::jsonb, true)`,
        [JSON.stringify(DEFAULT_ORG_POLICY)],
      );
    }
    await client.query("RELEASE SAVEPOINT sp_policy");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT sp_policy");
    await client.query("RELEASE SAVEPOINT sp_policy");
    const code = (err as { code?: string })?.code;
    // Do not abort onboarding if an un-migrated DB still carries global policies_version_key.
    if (code !== "23505" && code !== "42P10") {
      throw err;
    }
  }
}

export async function signUp(
  input: { companyName: string; name: string; email: string; password: string },
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<SignUpResult> {
  await ensureIdentitySchemaCompat();
  const companyName = input.companyName.trim();
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();

  if (companyName.length < 2) return { ok: false, error: "Enter your company name." };
  if (!name) return { ok: false, error: "Enter your name." };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  const passwordHash = await hashPassword(input.password);
  const slug = await uniqueOrgSlug(companyName);

  let row: SessionRow;
  try {
    row = await transaction(async (client) => {
      const org = await client.query<{ id: string; name: string }>(
        "INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id, name",
        [companyName, slug],
      );
      const orgId = org.rows[0].id;
      const user = await client.query<{ id: string; email: string; name: string | null; role: Role }>(
        `INSERT INTO users (org_id, email, password_hash, role, name)
         VALUES ($1, $2, $3, 'ADMIN', $4)
         RETURNING id, email, name, role`,
        [orgId, email, passwordHash, name],
      );

      await seedNewOrgDefaults(client, orgId);

      return {
        id: user.rows[0].id, org_id: orgId, org_name: org.rows[0].name,
        email: user.rows[0].email, name: user.rows[0].name, role: user.rows[0].role,
      };
    });
  } catch (err) {
    // users_email_idx is the one collision worth a specific message — an
    // address can only ever belong to one account, platform-wide (migration
    // 015). Anything else here is unexpected and should surface as a real
    // error rather than a guessed explanation.
    if (isUniqueViolation(err, "users_email_idx")) {
      return {
        ok: false,
        error: "An account with that email already exists. Try signing in instead.",
      };
    }
    throw err;
  }

  const started = await startSessionWithCookie(row, meta);
  return { ok: true, user: started.user, cookie: started.cookie };
}

// ---------------------------------------------------------- forgot password

// Long enough that a real reset gets used, short enough that a leaked or
// abandoned link is not a standing risk.
const RESET_TOKEN_HOURS = 1;
// Caps both how many live tokens accumulate for one account and how fast an
// attacker could make this endpoint send mail on someone else's behalf.
const RESET_MIN_INTERVAL_MINUTES = 5;

export type RequestResetResult =
  | {
      ok: true;
      delivery: "sent" | "preview" | "suppressed";
      previewResetUrl?: string;
    }
  | {
      ok: false;
      delivery: "unconfigured" | "failed";
      error: string;
    };

/**
 * Generates a single-use password reset token and dispatches it over email
 * (or returns a dev-only preview link when outbound mail is unconfigured outside
 * production) without exposing whether an email address is registered.
 */
export async function requestPasswordReset(
  email: string,
  meta: {
    ip?: string | null;
    userAgent?: string | null;
    origin?: string | null;
  } = {},
): Promise<RequestResetResult> {
  await ensureIdentitySchemaCompat();

  const mailConfigured = isMailConfigured();
  const isProd =
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production";

  if (!mailConfigured && isProd) {
    return {
      ok: false,
      delivery: "unconfigured",
      error:
        "Password reset emails are not configured on this server (configure RESEND_API_KEY or SMTP_HOST).",
    };
  }

  const trimmed = email.trim();
  if (!trimmed) return { ok: true, delivery: "suppressed" };

  const rows = await identityQuery<{ id: string; email: string; name: string | null }>(
    `SELECT u.id, u.email, u.name
       FROM users u JOIN organisations o ON o.id = u.org_id
      WHERE lower(u.email) = lower($1) AND u.active AND o.active`,
    [trimmed],
  );
  const row = rows[0];
  if (!row) return { ok: true, delivery: "suppressed" };

  if (mailConfigured) {
    const recent = await identityQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM password_resets
        WHERE user_id = $1
          AND used_at IS NULL
          AND expires_at > now()
          AND created_at > now() - make_interval(mins => $2)`,
      [row.id, RESET_MIN_INTERVAL_MINUTES],
    );
    if (recent[0]?.n && recent[0].n !== "0") {
      return { ok: true, delivery: "suppressed" };
    }
  }

  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + RESET_TOKEN_HOURS * 3_600_000);
  await identityQuery(
    `INSERT INTO password_resets (token, user_id, expires_at, ip_address)
     VALUES ($1, $2, $3, $4)`,
    [token, row.id, expires, meta.ip ?? null],
  );

  const base = (
    meta.origin?.trim() ||
    process.env.APP_URL?.trim() ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
  const link = `${base}/reset-password?token=${token}`;
  const hours = RESET_TOKEN_HOURS === 1 ? "1 hour" : `${RESET_TOKEN_HOURS} hours`;

  if (!mailConfigured) {
    // Development / non-production preview: no SMTP/Resend configured, so surface
    // the reset URL directly to the operator instead of silently dropping it.
    return { ok: true, delivery: "preview", previewResetUrl: link };
  }

  const mailRes = await sendMailDetail({
    to: row.email,
    subject: "Reset your Control Tower password",
    text:
      `${row.name ? `Hi ${row.name},\n\n` : ""}` +
      `Someone requested a password reset for this account. If that was you, ` +
      `set a new password here:\n\n${link}\n\n` +
      `This link expires in ${hours} and can only be used once. If you did not ` +
      `request this, you can ignore this message — your password will not change.`,
  });

  if (!mailRes.ok) {
    // Clean up failed-delivery token so the user is not blocked by cooldown.
    await identityQuery("DELETE FROM password_resets WHERE token = $1", [token]);
    return {
      ok: false,
      delivery: "failed",
      error:
        "Unable to deliver the password reset email right now. Please try again later.",
    };
  }

  return { ok: true, delivery: "sent" };
}

export type ResetResult =
  | { ok: true; email: string; orgId: string }
  | { ok: false; error: string };

export async function resetPassword(token: string, newPassword: string): Promise<ResetResult> {
  await ensureIdentitySchemaCompat();
  const cleanToken = token.trim();
  if (!cleanToken) return { ok: false, error: "This reset link is invalid." };
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  const rows = await identityQuery<{
    user_id: string;
    used_at: Date | string | null;
    expires_at: Date | string;
    org_id: string;
    email: string;
  }>(
    `SELECT pr.user_id, pr.used_at, pr.expires_at, u.org_id, u.email
       FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token = $1`,
    [cleanToken],
  );
  const row = rows[0];

  if (!row) return { ok: false, error: "This reset link is invalid." };
  if (row.used_at) return { ok: false, error: "This reset link has already been used." };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "This reset link has expired. Request a new one." };
  }

  const hash = await hashPassword(newPassword);
  await identityQuery("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, row.user_id]);
  await identityQuery("UPDATE password_resets SET used_at = now() WHERE token = $1", [cleanToken]);
  // A reset is usually prompted by a suspected compromise. Leaving an
  // intruder's existing session alive would defeat the point — mirrors
  // AuthRepo.set_password on the Python side.
  await identityQuery("DELETE FROM sessions WHERE user_id = $1", [row.user_id]);

  return { ok: true, email: row.email, orgId: row.org_id };
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    // Delete the row, not just the cookie: a copied token must stop working.
    await identityQuery("DELETE FROM sessions WHERE token = $1", [token]);
  }
  let head: Headers;
  try {
    head = await headers();
  } catch {
    head = new Headers();
  }
  const isHttps = isHttpsRequest(head);
  jar.set(SESSION_COOKIE, "", {
    ...sessionCookieOptions(isHttps, new Date(0)),
    maxAge: 0,
  });
}

// A real hash of a value nobody can supply, so a login against an unknown
// address costs the same as one against a known address.
const DUMMY_HASH =
  "scrypt$16384$8$1$" +
  createHash("sha256").update("logistics-dummy-salt").digest("hex").slice(0, 32) +
  "$" +
  createHash("sha512").update("logistics-dummy-digest").digest("hex").repeat(2).slice(0, 128);
