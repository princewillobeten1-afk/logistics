"use client";

import { useState, type FormEvent } from "react";
import { GoogleSignInButton } from "@/components/google-sign-in-button";

const MIN_PASSWORD_LENGTH = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignUpForm() {
  const [companyName, setCompanyName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTabUrl, setNewTabUrl] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);
    setNewTabUrl(null);

    const trimmedCompany = companyName.trim();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();

    if (trimmedCompany.length < 2) {
      setError("Enter your company name (at least 2 characters).");
      return;
    }
    if (!trimmedName) {
      setError("Enter your name.");
      return;
    }
    if (!EMAIL_RE.test(trimmedEmail)) {
      setError("Enter a valid email address.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setPending(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          companyName: trimmedCompany,
          name: trimmedName,
          email: trimmedEmail,
          password,
          confirm,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        redirectTo?: string;
      };

      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not create workspace. Please try again.");
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
        setNewTabUrl(window.location.href);
        setError(
          "Your browser blocked session cookies inside this embedded preview.",
        );
        setPending(false);
        return;
      }

      window.location.assign(data.redirectTo ?? "/");
    } catch {
      setError("Unable to reach the workspace service. Please try again.");
      setPending(false);
    }
  }

  return (
    <div className="auth-stack">
      <GoogleSignInButton
        label="Sign up with Google"
        companyName={companyName}
      />

      <div className="auth-divider" role="separator">
        <span>or create with email</span>
      </div>

      <form onSubmit={handleSubmit} noValidate className="auth-form">
        <div className="auth-field">
          <label htmlFor="signup-company">Company name</label>
          <input
            id="signup-company"
            name="companyName"
            type="text"
            autoComplete="organization"
            autoFocus
            required
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
          />
        </div>

        <div className="auth-field">
          <label htmlFor="signup-name">Your name</label>
          <input
            id="signup-name"
            name="name"
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="auth-field">
          <label htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            name="email"
            type="email"
            autoComplete="username"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="auth-field">
          <label htmlFor="signup-password">Password</label>
          <div className="password-wrap">
            <input
              id="signup-password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby={tooShort ? "signup-password-hint" : undefined}
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
        {tooShort ? (
          <p id="signup-password-hint" className="auth-hint">
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        ) : null}

        <div className="auth-field">
          <label htmlFor="signup-confirm">Confirm password</label>
          <input
            id="signup-confirm"
            name="confirm"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-describedby={mismatch ? "signup-confirm-hint" : undefined}
          />
        </div>
        {mismatch ? (
          <p id="signup-confirm-hint" className="auth-hint" data-tone="warn">
            Passwords do not match.
          </p>
        ) : null}

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
                  Open in a new tab to create workspace →
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
          {pending ? "Creating your workspace…" : "Create workspace"}
        </button>
      </form>
    </div>
  );
}
