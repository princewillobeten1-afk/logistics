"use client";

import { useState, type FormEvent } from "react";
import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { markOnboardingPendingAfterAuth } from "@/lib/onboarding";

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTabUrl, setNewTabUrl] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);
    setNewTabUrl(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Enter your email and password.");
      return;
    }

    setPending(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          email: trimmedEmail,
          password,
          next,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        redirectTo?: string;
      };

      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not sign in. Please try again.");
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
        let embedded = false;
        try {
          embedded = window.self !== window.top;
        } catch {
          embedded = true;
        }
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
    } catch {
      setError("Unable to reach the sign-in service. Please try again.");
      setPending(false);
    }
  }

  return (
    <div className="auth-stack">
      <GoogleSignInButton next={next} />

      <div className="auth-divider" role="separator">
        <span>or continue with email</span>
      </div>

      <form onSubmit={handleSubmit} noValidate className="auth-form">
        <div className="auth-field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="username"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={error ? "login-error" : undefined}
          />
        </div>

        <div className="auth-field">
          <label htmlFor="login-password">Password</label>
          <div className="password-wrap">
            <input
              id="login-password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={error ? "login-error" : undefined}
            />
            <button
              type="button"
              className="password-toggle"
              aria-pressed={showPassword}
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((prev) => !prev)}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        {error ? (
          <div id="login-error" className="auth-error" role="alert">
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

        <button
          type="submit"
          className="auth-submit"
          data-pending={pending}
          disabled={pending}
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
