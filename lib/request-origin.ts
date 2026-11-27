import type { NextRequest } from "next/server";

/**
 * Verifies that a state-changing auth request originated from the app itself.
 * Accepts either a matching Origin/Host pair (honoring X-Forwarded-Host on
 * reverse-proxied Cloud Run previews) or our explicit X-Requested-With header,
 * which browsers forbid cross-origin without explicit CORS opt-in.
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
      const originHost = new URL(origin).host.toLowerCase();
      if (originHost === forwardedHost || originHost === host) {
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
