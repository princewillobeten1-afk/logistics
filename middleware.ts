import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "logistics_session";

/**
 * Redirects anyone without a session cookie to the sign-in form.
 *
 * This is the first line, not the boundary. Middleware runs on the Edge
 * runtime with no database, so it can see that a cookie exists but not that
 * it is valid — a forged one gets past here. Two things stop it after:
 * the root layout resolves the session properly and redirects, and every
 * tenant-scoped query runs with no organisation set, which under RLS returns
 * zero rows rather than someone else's data.
 *
 * Its real job is saving a database round trip on the common case, and
 * landing signed-out visitors on /login instead of an empty dashboard.
 */
// Routes that render without a session. Must match the PUBLIC set in
// app/layout.tsx, which is what actually skips requireUser() — this set only
// decides the redirect, so the two drifting apart would either strand a
// signed-out visitor in a loop or let a page render past the layout thinking
// it is protected when middleware already let it through unauthenticated.
const PUBLIC_PATHS = new Set([
  "/",
  "/welcome",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/google",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/session",
  "/api/webhooks/whatsapp",
  "/api/webhooks/telegram",
  "/api/channels/telegram/sync",
  "/api/intake/external",
  "/api/v1/ingest",
  "/api/v1/shipments",
]);

// Routes that may carry ?expired to clear a stale session cookie.
const AUTH_ENTRY_PATHS = new Set(["/login", "/signup"]);

export function middleware(request: NextRequest) {
  const { pathname, search, searchParams } = request.nextUrl;

  // The layout needs to know which route it is rendering so it can let the
  // sign-in page through; layouts do not otherwise receive the pathname.
  const headers = new Headers(request.headers);
  headers.set("x-pathname", pathname);

  const isPublic =
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/invite/") ||
    pathname.startsWith("/api/workspace/invites/");
  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (!isPublic && !hasCookie) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Authentication required." },
        { status: 401 },
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Come back to where they were headed once they have signed in.
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (AUTH_ENTRY_PATHS.has(pathname) && hasCookie && searchParams.has("expired")) {
    const res = NextResponse.next({ request: { headers } });
    const proto = (request.headers.get("x-forwarded-proto") ?? "")
      .split(",")[0]
      ?.trim()
      .toLowerCase() ?? "";
    const origin = (request.headers.get("origin") ?? "").trim().toLowerCase();
    const rawHost = (
      request.headers.get("x-forwarded-host") ??
      request.headers.get("host") ??
      ""
    )
      .split(",")[0]
      ?.trim()
      .toLowerCase() ?? "";
    const hostname = rawHost.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    const isLoopback =
      proto === "http" ||
      origin.startsWith("http://") ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1";
    const isHttps =
      proto === "https" ||
      origin.startsWith("https://") ||
      (!isLoopback &&
        (hostname.endsWith(".run.app") ||
          hostname.endsWith(".vercel.app") ||
          request.nextUrl.protocol === "https:"));
    res.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: isHttps ? "none" : "lax",
      secure: isHttps,
      partitioned: isHttps,
      path: "/",
      maxAge: 0,
    });
    return res;
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Everything except Next's own assets, static images, and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|images/|assets/).*)"],
};
