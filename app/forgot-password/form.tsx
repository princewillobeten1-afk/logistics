"use client";

import { useState, type FormEvent } from "react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [previewResetUrl, setPreviewResetUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError("Enter a valid email address.");
      return;
    }

    setPending(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({ email: trimmed }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        previewResetUrl?: string;
      };

      if (!res.ok || !data.ok) {
        setError(data.error ?? "Unable to process your reset request.");
        setPending(false);
        return;
      }

      setPreviewResetUrl(
        typeof data.previewResetUrl === "string" && data.previewResetUrl
          ? data.previewResetUrl
          : null,
      );
      setSubmitted(true);
      setPending(false);
    } catch {
      setError("Unable to reach the recovery service. Please try again.");
      setPending(false);
    }
  }

  if (submitted) {
    return (
      <div className="auth-notice" role="status">
        <p style={{ margin: 0 }}>
          {previewResetUrl
            ? "Outbound email delivery is not configured in this preview environment. Use the one-time reset link below:"
            : "If an account exists for that email, a reset link is on its way. It expires in an hour and works once."}
        </p>
        {previewResetUrl ? (
          <div style={{ marginTop: "0.6rem" }}>
            <a href={previewResetUrl} className="auth-link">
              Open password reset link →
            </a>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="auth-form">
      <div className="auth-field">
        <label htmlFor="forgot-email">Email</label>
        <input
          id="forgot-email"
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
          aria-describedby={error ? "forgot-error" : undefined}
        />
      </div>

      {error ? (
        <p id="forgot-error" className="auth-error" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        className="auth-submit"
        data-pending={pending}
        disabled={pending}
      >
        {pending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
