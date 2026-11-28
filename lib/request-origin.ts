import type { NextRequest } from "next/server";

function stripDefaultPort(host: string): string {
  return host.trim().toLowerCase().replace(/:(80|443)$/, "");
}

/**
 * Verifies that a state-changing auth request originated from the app itself.
 * Accepts either a matching Origin/Host pair (honoring X-Forwarded-Host on
 * reverse-proxied Cloud Run / Vercel previews) or our explicit X-Requested-With
 * header, which browsers forbid cross-origin without explicit CORS opt-in.
 */
export function verifySameOriginMutation(req: NextRequest): boolean {
  const origin = req.headers.get("origin")?.trim();
  const forwardedHost = req.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  const host = req.headers.get("host")?.trim().toLowerCase();
  const xRequestedWith = req.headers.get("x-requested-with")?.trim();

  if (origin) {
    try {
      const originHost = stripDefaultPort(new URL(origin).host);
      if (
        (forwardedHost && originHost === stripDefaultPort(forwardedHost)) ||
        (host && originHost === stripDefaultPort(host))
      ) {
        return true;
      }
      // Behind some Cloud Run / local proxies, X-Forwarded-Host may be omitted
      // while Host stays 127.0.0.1:3000. Require custom header in that case.
      if (xRequestedWith === "XMLHttpRequest") {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  return xRequestedWith === "XMLHttpRequest";
}

const SAFE_HOST_RE = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

/**
 * Resolves the external base URL (e.g. https://app.vercel.app or http://localhost:3000)
 * from verified request headers before falling back to APP_URL / VERCEL_URL.
 */
export function resolvePublicOrigin(
  head: Pick<Headers, "get">,
  isHttps: boolean,
): string {
  const origin = head.get("origin")?.trim();
  const forwardedHost = head
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const host = head.get("host")?.split(",")[0]?.trim();

  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        const parsedHost = stripDefaultPort(parsed.host);
        if (
          (forwardedHost && parsedHost === stripDefaultPort(forwardedHost)) ||
          (host && parsedHost === stripDefaultPort(host)) ||
          parsed.hostname === "localhost" ||
          parsed.hostname === "127.0.0.1" ||
          parsed.hostname.endsWith(".run.app") ||
          parsed.hostname.endsWith(".vercel.app")
        ) {
          return parsed.origin.replace(/\/$/, "");
        }
      }
    } catch {
      // Fall through to host header
    }
  }

  const candidateHost = forwardedHost || host;
  if (candidateHost && SAFE_HOST_RE.test(candidateHost)) {
    const scheme = isHttps ? "https" : "http";
    return `${scheme}://${candidateHost}`;
  }

  const envAppUrl = process.env.APP_URL?.trim();
  if (envAppUrl) {
    return envAppUrl.replace(/\/$/, "");
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    return `https://${vercelUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  }

  return "http://localhost:3000";
}

const AUTH_ENTRY_PREFIXES = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
];

/**
 * Ensures post-login redirects stay on an internal non-auth route and never
 * open-redirect or loop back onto /login or /signup.
 */
export function sanitizeAuthRedirectTarget(next?: string | null): string {
  const raw = next?.trim() ?? "";
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return "/";
  }
  const pathOnly = raw.split(/[?#]/)[0]?.toLowerCase() ?? "/";
  if (
    AUTH_ENTRY_PREFIXES.some(
      (prefix) => pathOnly === prefix || pathOnly.startsWith(`${prefix}/`),
    )
  ) {
    return "/";
  }
  return raw;
}

