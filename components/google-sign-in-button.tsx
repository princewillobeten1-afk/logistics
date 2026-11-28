"use client";

import { useCallback, useEffect, useState } from "react";
import {
  consumeGoogleRedirectResult,
  googleSignIn,
} from "@/lib/google-auth";
import { markOnboardingPendingAfterAuth } from "@/lib/onboarding";

function isEmbeddedIframe(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function formatGoogleAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code;
  const rawMessage = err instanceof Error ? err.message : "";
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Google sign-in was cancelled before completing.";
    case "auth/popup-blocked":
      return isEmbeddedIframe()
        ? "The embedded preview blocked the Google sign-in popup. Allow popups or open sign-in in a new tab."
        : "Your browser blocked the Google sign-in popup. Allow popups for this site and try again.";
    case "auth/web-storage-unsupported":
      return isEmbeddedIframe()
        ? "Browser storage is blocked inside this embedded preview. Open sign-in in a new tab to continue."
        : "Your browser has third-party storage or cookies disabled. Enable storage for this site and try again.";
    case "auth/unauthorized-domain":
      return `Google sign-in is not authorized for ${typeof window !== "undefined" ? window.location.hostname : "this domain"}. Add this domain under Firebase Authentication → Settings → Authorized domains, or sign in with email below.`;
    case "auth/operation-not-allowed":
      return "Google sign-in provider is not enabled for this Firebase project.";
    case "auth/network-request-failed":
      return "Network error while contacting Google. Check your connection and try again.";
    default:
      if (/access_denied|403|testing|verification/i.test(rawMessage)) {
        return "Google rejected this account because the app's Google OAuth consent screen is still in Testing mode. Publish the OAuth consent screen to Production in Google Cloud Console so any Google account can sign in.";
      }
      return rawMessage || "Could not complete Google sign-in.";
  }
}

export function GoogleSignInButton({
  next = "/",
  label = "Sign in with Google",
  companyName,
  includeGmailScopes = false,
}: {
  next?: string;
  label?: string;
  companyName?: string;
  includeGmailScopes?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTabUrl, setNewTabUrl] = useState<string | null>(null);

  const exchangeIdToken = useCallback(
    async (idToken: string) => {
      const res = await fetch("/api/auth/google", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          companyName: companyName?.trim() || undefined,
          next,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        redirectTo?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Google sign-in failed. Please try again.");
        setPending(false);
        return;
      }

      const checkRes = await fetch("/api/auth/session", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const checkData = (await checkRes.json().catch(() => ({}))) as {
        authenticated?: boolean;
      };
      if (!checkData.authenticated) {
        const embedded = isEmbeddedIframe();
        if (embedded) {
          setNewTabUrl(window.location.href);
        }
        setError(
          embedded
            ? "Your browser blocked session cookies inside this embedded preview."
            : "Your browser blocked the session cookie. Enable cookies for this site and try again.",
        );
        setPending(false);
        return;
      }

      markOnboardingPendingAfterAuth();
      window.location.assign(data.redirectTo ?? "/");
    },
    [companyName, next],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const redirectPayload = await consumeGoogleRedirectResult();
        if (!active || !redirectPayload) return;
        setPending(true);
        await exchangeIdToken(redirectPayload.idToken);
      } catch (err) {
        if (!active) return;
        setError(formatGoogleAuthError(err));
        setPending(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [exchangeIdToken]);

  async function handleClick() {
    setError(null);
    setNewTabUrl(null);
    setPending(true);
    try {
      const { idToken } = await googleSignIn({ includeGmailScopes });
      await exchangeIdToken(idToken);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (
        isEmbeddedIframe() &&
        code !== "auth/popup-closed-by-user" &&
        code !== "auth/cancelled-popup-request"
      ) {
        setNewTabUrl(window.location.href);
      }
      setError(formatGoogleAuthError(err));
      setPending(false);
    }
  }

  return (
    <div className="gsi-wrap">
      <button
        type="button"
        className="gsi-material-button"
        onClick={handleClick}
        disabled={pending}
        aria-busy={pending}
      >
        <div className="gsi-material-button-state" />
        <div className="gsi-material-button-content-wrapper">
          <div className="gsi-material-button-icon">
            <svg
              version="1.1"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 48 48"
              style={{ display: "block" }}
              aria-hidden="true"
            >
              <path
                fill="#EA4335"
                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
              />
              <path
                fill="#4285F4"
                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
              />
              <path
                fill="#FBBC05"
                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
              />
              <path
                fill="#34A853"
                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
              />
              <path fill="none" d="M0 0h48v48H0z" />
            </svg>
          </div>
          <span className="gsi-material-button-contents">
            {pending ? "Signing in with Google…" : label}
          </span>
          <span style={{ display: "none" }}>{label}</span>
        </div>
      </button>

      {error ? (
        <div className="auth-error" role="alert">
          <span>{error}</span>
          {newTabUrl ? (
            <div style={{ marginTop: "0.35rem" }}>
              <a
                href={newTabUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="auth-link"
              >
                Open in a new tab to sign in →
              </a>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
