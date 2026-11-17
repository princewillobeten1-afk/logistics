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

import { identityQuery, transaction } from "./db";
import { sendMail } from "./mail";

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
};

/**
 * The signed-in user, or null.
 *
 * `cache()` memoises this for the duration of one request, so the dozen
 * queries a page makes resolve the session once rather than a dozen times.
 */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await identityQuery<{
    id: string;
    org_id: string;
    org_name: string;
    email: string;
    name: string | null;
    role: Role;
  }>(
    `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN organisations o ON o.id = u.org_id
      WHERE s.token = $1 AND s.expires_at > now()
        AND u.active AND o.active`,
    [token],
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    email: row.email,
    name: row.name,
    role: row.role,
  };
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

type SessionRow = {
  id: string;
  org_id: string;
  org_name: string;
  email: string;
  name: string | null;
  role: Role;
};

export function isHttpsRequest(head: Headers): boolean {
  const proto = (head.get("x-forwarded-proto") ?? "").toLowerCase();
  const origin = (head.get("origin") ?? "").toLowerCase();
  const referer = (head.get("referer") ?? "").toLowerCase();
  const host = (
    head.get("x-forwarded-host") ??
    head.get("host") ??
    ""
  ).toLowerCase();
  const appUrl = (process.env.APP_URL ?? "").toLowerCase();

  return (
    proto.includes("https") ||
    origin.startsWith("https://") ||
    referer.startsWith("https://") ||
    host.endsWith(".run.app") ||
    appUrl.startsWith("https://") ||
    process.env.NODE_ENV === "production"
  );
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
async function startSessionWithCookie(
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

  const isHttps = isHttpsRequest(await headers());
  const options = sessionCookieOptions(isHttps, expires);

  (await cookies()).set(SESSION_COOKIE, token, options);

  return {
    user: {
      id: row.id, orgId: row.org_id, orgName: row.org_name,
      email: row.email, name: row.name, role: row.role,
    },
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
  const rows = await identityQuery<SessionRow & { active: boolean; org_active: boolean; password_hash: string }>(
    `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role,
            u.active, o.active AS org_active, u.password_hash
       FROM users u JOIN organisations o ON o.id = u.org_id
      WHERE lower(u.email) = lower($1)`,
    [email.trim()],
  );

  const row = rows[0];
  // Hash even when there is no such user, so the response time does not
  // reveal which addresses have accounts.
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);

  if (!row || !ok || !row.active || !row.org_active) {
    // One message for every failure. Saying which half was wrong tells an
    // attacker they have found a real address.
    return { ok: false, error: "Invalid email or password." };
  }

  return { ok: true, user: await startSession(row, meta) };
}

export async function signInWithGoogle(
  input: { email: string; name?: string | null; companyName?: string | null },
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();
  if (!email) {
    return { ok: false, error: "Google account did not return an email address." };
  }

  const existing = await identityQuery<
    SessionRow & { active: boolean; org_active: boolean }
  >(
    `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role,
            u.active, o.active AS org_active
       FROM users u JOIN organisations o ON o.id = u.org_id
      WHERE lower(u.email) = lower($1)`,
    [email],
  );

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
      const user = await client.query<{
        id: string;
        email: string;
        name: string | null;
        role: Role;
      }>(
        `INSERT INTO users (org_id, email, password_hash, role, name)
         VALUES ($1, $2, $3, 'ADMIN', $4)
         RETURNING id, email, name, role`,
        [org.rows[0].id, email, randomPasswordHash, displayName],
      );
      return {
        id: user.rows[0].id,
        org_id: org.rows[0].id,
        org_name: org.rows[0].name,
        email: user.rows[0].email,
        name: user.rows[0].name,
        role: user.rows[0].role,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err, "users_email_idx")) {
      const retry = await identityQuery<SessionRow>(
        `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role
           FROM users u JOIN organisations o ON o.id = u.org_id
          WHERE lower(u.email) = lower($1) AND u.active AND o.active`,
        [email],
      );
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
export type SignUpResult = { ok: true; user: SessionUser } | { ok: false; error: string };

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

export async function signUp(
  input: { companyName: string; name: string; email: string; password: string },
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<SignUpResult> {
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
      const user = await client.query<{ id: string; email: string; name: string | null; role: Role }>(
        `INSERT INTO users (org_id, email, password_hash, role, name)
         VALUES ($1, $2, $3, 'ADMIN', $4)
         RETURNING id, email, name, role`,
        [org.rows[0].id, email, passwordHash, name],
      );
      return {
        id: user.rows[0].id, org_id: org.rows[0].id, org_name: org.rows[0].name,
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

  return { ok: true, user: await startSession(row, meta) };
}

// ---------------------------------------------------------- forgot password

// Long enough that a real reset gets used, short enough that a leaked or
// abandoned link is not a standing risk.
const RESET_TOKEN_HOURS = 1;
// Caps both how many live tokens accumulate for one account and how fast an
// attacker could make this endpoint send mail on someone else's behalf.
const RESET_MIN_INTERVAL_MINUTES = 5;

export type RequestResetResult = { ok: true };

/**
 * Always resolves the same way, whether or not the address has an account —
 * telling a visitor "no account with that email" is exactly the account
 * enumeration this has to refuse to do. `signIn` protects the same fact by
 * hashing a dummy password either way; this protects it by never branching
 * the visible outcome at all.
 */
export async function requestPasswordReset(
  email: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<RequestResetResult> {
  const GENERIC: RequestResetResult = { ok: true };
  const trimmed = email.trim();
  if (!trimmed) return GENERIC;

  const rows = await identityQuery<{ id: string; email: string; name: string | null }>(
    `SELECT u.id, u.email, u.name
       FROM users u JOIN organisations o ON o.id = u.org_id
      WHERE lower(u.email) = lower($1) AND u.active AND o.active`,
    [trimmed],
  );
  const row = rows[0];
  if (!row) return GENERIC;

  const recent = await identityQuery<{ n: string }>(
    `SELECT count(*)::text AS n FROM password_resets
      WHERE user_id = $1
        AND created_at > now() - make_interval(mins => $2)`,
    [row.id, RESET_MIN_INTERVAL_MINUTES],
  );
  if (recent[0].n !== "0") return GENERIC; // one was already sent recently

  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + RESET_TOKEN_HOURS * 3_600_000);
  await identityQuery(
    `INSERT INTO password_resets (token, user_id, expires_at, ip_address)
     VALUES ($1, $2, $3, $4)`,
    [token, row.id, expires, meta.ip ?? null],
  );

  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const link = `${base}/reset-password?token=${token}`;
  const hours = RESET_TOKEN_HOURS === 1 ? "1 hour" : `${RESET_TOKEN_HOURS} hours`;

  await sendMail({
    to: row.email,
    subject: "Reset your Control Tower password",
    text:
      `${row.name ? `Hi ${row.name},\n\n` : ""}` +
      `Someone requested a password reset for this account. If that was you, ` +
      `set a new password here:\n\n${link}\n\n` +
      `This link expires in ${hours} and can only be used once. If you did not ` +
      `request this, you can ignore this message — your password will not change.`,
  });

  return GENERIC;
}

export type ResetResult =
  | { ok: true; email: string; orgId: string }
  | { ok: false; error: string };

export async function resetPassword(token: string, newPassword: string): Promise<ResetResult> {
  if (!token) return { ok: false, error: "This reset link is invalid." };
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  const rows = await identityQuery<{
    user_id: string;
    used_at: Date | null;
    expires_at: Date;
    org_id: string;
    email: string;
  }>(
    `SELECT pr.user_id, pr.used_at, pr.expires_at, u.org_id, u.email
       FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token = $1`,
    [token],
  );
  const row = rows[0];

  if (!row) return { ok: false, error: "This reset link is invalid." };
  if (row.used_at) return { ok: false, error: "This reset link has already been used." };
  if (row.expires_at.getTime() < Date.now()) {
    return { ok: false, error: "This reset link has expired. Request a new one." };
  }

  const hash = await hashPassword(newPassword);
  await identityQuery("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, row.user_id]);
  await identityQuery("UPDATE password_resets SET used_at = now() WHERE token = $1", [token]);
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
  const isHttps = isHttpsRequest(await headers());
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
