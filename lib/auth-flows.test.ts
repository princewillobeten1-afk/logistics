import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";

import {
  isHttpsRequest,
  requestPasswordReset,
  resetPassword,
  signIn,
  signInWithGoogle,
  signUp,
  verifyActiveSessionToken,
} from "./auth";
import { resetLocalStoreForTests } from "./db";
import {
  resolvePublicOrigin,
  sanitizeAuthRedirectTarget,
  verifySameOriginMutation,
} from "./request-origin";

const LOCAL_STORE_PATH =
  process.env.LOGISTICS_LOCAL_STORE_PATH?.trim() ||
  "/tmp/logistics-local-store.json";

function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => T,
): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    if (out instanceof Promise) {
      return out.finally(restore) as T;
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

let storeBackup: string | null = null;

test.before(() => {
  storeBackup = existsSync(LOCAL_STORE_PATH)
    ? readFileSync(LOCAL_STORE_PATH, "utf8")
    : null;
  resetLocalStoreForTests();
});

test.after(() => {
  if (storeBackup !== null) {
    writeFileSync(LOCAL_STORE_PATH, storeBackup, "utf8");
  } else if (existsSync(LOCAL_STORE_PATH)) {
    rmSync(LOCAL_STORE_PATH, { force: true });
  }
});

test("isHttpsRequest respects local HTTP/loopback requests even when APP_URL is https", () => {
  withEnv(
    {
      APP_URL: "https://ais-dev-example.europe-west2.run.app",
      NODE_ENV: "development",
    },
    () => {
      assert.equal(
        isHttpsRequest(
          new Headers({
            host: "localhost:3000",
            origin: "http://localhost:3000",
          }),
        ),
        false,
      );
      assert.equal(
        isHttpsRequest(
          new Headers({
            host: "127.0.0.1:3000",
            "x-forwarded-proto": "http",
          }),
        ),
        false,
      );
      assert.equal(
        isHttpsRequest(
          new Headers({
            host: "app.vercel.app",
            "x-forwarded-proto": "https",
          }),
        ),
        true,
      );
      assert.equal(
        isHttpsRequest(
          new Headers({
            host: "control-tower.vercel.app",
          }),
        ),
        true,
      );
    },
  );
});

test("verifySameOriginMutation and resolvePublicOrigin support localhost, Cloud Run, and Vercel default ports", () => {
  const req = new NextRequest("https://app.vercel.app/api/auth/login", {
    method: "POST",
    headers: {
      origin: "https://app.vercel.app",
      "x-forwarded-host": "app.vercel.app:443",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(verifySameOriginMutation(req), true);
  assert.equal(resolvePublicOrigin(req.headers, true), "https://app.vercel.app");

  const localReq = new NextRequest("http://localhost:3000/api/auth/forgot-password", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
  });
  assert.equal(verifySameOriginMutation(localReq), true);
  assert.equal(
    resolvePublicOrigin(localReq.headers, false),
    "http://localhost:3000",
  );
});

test("sanitizeAuthRedirectTarget blocks open redirects and auth-entry loops", () => {
  assert.equal(sanitizeAuthRedirectTarget(undefined), "/");
  assert.equal(sanitizeAuthRedirectTarget(""), "/");
  assert.equal(sanitizeAuthRedirectTarget("/orders?x=1"), "/orders?x=1");
  assert.equal(sanitizeAuthRedirectTarget("/fleet#active"), "/fleet#active");
  assert.equal(sanitizeAuthRedirectTarget("/login"), "/");
  assert.equal(sanitizeAuthRedirectTarget("/login?next=/orders"), "/");
  assert.equal(sanitizeAuthRedirectTarget("/signup"), "/");
  assert.equal(sanitizeAuthRedirectTarget("/forgot-password"), "/");
  assert.equal(sanitizeAuthRedirectTarget("/reset-password?token=abc"), "/");
  assert.equal(sanitizeAuthRedirectTarget("//evil.com"), "/");
  assert.equal(sanitizeAuthRedirectTarget("/\\evil.com"), "/");
  assert.equal(sanitizeAuthRedirectTarget("https://evil.com"), "/");
});

test("email signup and case-insensitive email sign-in create isolated session and validate passwords", async () => {
  resetLocalStoreForTests();

  const signup = await signUp({
    companyName: "Alpha Freight Ltd",
    name: "Ada Lovelace",
    email: "Ada@AlphaFreight.io",
    password: "StrongPassword!123",
  });
  assert.equal(signup.ok, true);
  if (!signup.ok) return;
  assert.ok(signup.cookie?.token);

  const wrong = await signIn("ada@alphafreight.io", "WrongPassword!123");
  assert.equal(wrong.ok, false);

  const login = await signIn("ADA@ALPHAFREIGHT.IO", "StrongPassword!123");
  assert.equal(login.ok, true);
  if (!login.ok) return;
  assert.equal(login.user.email, "ada@alphafreight.io");
  assert.equal(login.user.orgName, "Alpha Freight Ltd");

  const sessionUser = await verifyActiveSessionToken(login.cookie?.token);
  assert.ok(sessionUser);
  assert.equal(sessionUser.id, login.user.id);
});

test("Google sign-in accepts any arbitrary Google email/domain and provisions isolated workspaces", async () => {
  resetLocalStoreForTests();

  const googleAccounts = [
    { email: "alice.operator@gmail.com", name: "Alice Operator", company: "Alice Logistics" },
    { email: "bob@acmecargo.co.uk", name: "Bob Cargo", company: "Acme Cargo UK" },
    { email: "carol.dispatch@logistics.ng", name: "Carol Dispatch", company: null },
  ];

  const orgIds = new Set<string>();
  for (const acc of googleAccounts) {
    const res = await signInWithGoogle({
      email: acc.email,
      name: acc.name,
      companyName: acc.company,
    });
    assert.equal(res.ok, true, `Expected ${acc.email} to sign in with Google`);
    if (!res.ok) continue;
    assert.equal(res.user.email, acc.email);
    orgIds.add(res.user.orgId);

    // Signing in a second time reuses the same user and workspace
    const again = await signInWithGoogle({
      email: acc.email.toUpperCase(),
      name: acc.name,
    });
    assert.equal(again.ok, true);
    if (again.ok) {
      assert.equal(again.user.id, res.user.id);
      assert.equal(again.user.orgId, res.user.orgId);
    }
  }

  assert.equal(orgIds.size, 3);
});

test("forgot password and reset password flow updates credentials, revokes prior sessions, and respects single-use tokens", async () => {
  resetLocalStoreForTests();

  const created = await signUp({
    companyName: "Recovery Freight Co",
    name: "Grace Hopper",
    email: "grace@recoveryfreight.com",
    password: "OldPassword!123",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const oldSessionToken = created.cookie?.token;
  assert.ok(oldSessionToken);

  await withEnv(
    {
      NODE_ENV: "development",
      VERCEL_ENV: undefined,
      SMTP_HOST: undefined,
      RESEND_API_KEY: undefined,
    },
    async () => {
      const resetReq = await requestPasswordReset("grace@recoveryfreight.com", {
        origin: "https://preview.example.run.app",
      });
      assert.equal(resetReq.ok, true);
      if (!resetReq.ok) return;
      assert.equal(resetReq.delivery, "preview");
      if (!resetReq.previewResetUrl) {
        assert.fail("Expected previewResetUrl to be returned in development preview mode");
      }
      assert.ok(
        resetReq.previewResetUrl.startsWith(
          "https://preview.example.run.app/reset-password?token=",
        ),
      );

      const url = new URL(resetReq.previewResetUrl);
      const token = url.searchParams.get("token") ?? "";
      assert.ok(token.length > 10);

      const applied = await resetPassword(token, "NewSecurePass!456");
      assert.equal(applied.ok, true);

      // Reusing the same token fails
      const reused = await resetPassword(token, "AnotherPass!789");
      assert.equal(reused.ok, false);

      // Old session was revoked
      const oldSession = await verifyActiveSessionToken(oldSessionToken);
      assert.equal(oldSession, null);

      // Old password fails, new password succeeds
      const oldLogin = await signIn("grace@recoveryfreight.com", "OldPassword!123");
      assert.equal(oldLogin.ok, false);

      const newLogin = await signIn("grace@recoveryfreight.com", "NewSecurePass!456");
      assert.equal(newLogin.ok, true);

      // Unknown email reveals nothing (suppressed, no previewResetUrl)
      const unknownReq = await requestPasswordReset("nobody@example.com", {
        origin: "https://preview.example.run.app",
      });
      assert.equal(unknownReq.ok, true);
      if (unknownReq.ok) {
        assert.equal(unknownReq.previewResetUrl, undefined);
      }
    },
  );

  // Production without mail provider configured fails cleanly without leaking reset links
  await withEnv(
    {
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      SMTP_HOST: undefined,
      RESEND_API_KEY: undefined,
    },
    async () => {
      const prodRes = await requestPasswordReset("grace@recoveryfreight.com", {
        origin: "https://prod.vercel.app",
      });
      assert.equal(prodRes.ok, false);
      if (!prodRes.ok) {
        assert.equal(prodRes.delivery, "unconfigured");
      }
    },
  );
});
