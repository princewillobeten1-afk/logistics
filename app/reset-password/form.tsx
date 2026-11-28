"use client";

import { useState, type FormEvent } from "react";

const MIN_PASSWORD_LENGTH = 10;

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);

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
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          token: token.trim(),
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
        setError(data.error ?? "Unable to reset password. Please try again.");
        setPending(false);
        return;
      }

      window.location.assign(data.redirectTo ?? "/login?reset=1");
    } catch {
      setError("Unable to reach the recovery service. Please try again.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="auth-form">
      <div className="auth-field">
        <label htmlFor="reset-password">New password</label>
        <div className="password-wrap">
          <input
            id="reset-password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={tooShort ? "reset-password-hint" : undefined}
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
        <p id="reset-password-hint" className="auth-hint">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      ) : null}

      <div className="auth-field">
        <label htmlFor="reset-confirm">Confirm new password</label>
        <input
          id="reset-confirm"
          name="confirm"
          type={showPassword ? "text" : "password"}
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-describedby={mismatch ? "reset-confirm-hint" : undefined}
        />
      </div>
      {mismatch ? (
        <p id="reset-confirm-hint" className="auth-hint" data-tone="warn">
          Passwords do not match.
        </p>
      ) : null}

      {error ? (
        <p className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        className="auth-submit"
        data-pending={pending}
        disabled={pending}
      >
        {pending ? "Setting password…" : "Set new password"}
      </button>
    </form>
  );
}
