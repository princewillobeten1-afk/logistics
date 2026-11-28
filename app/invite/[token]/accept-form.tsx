"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AcceptInviteForm({
  token,
  email,
}: {
  token: string;
  email: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/workspace/invites/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not accept invitation.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Network error while activating your account.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="auth-form">
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <label className="auth-field">
        <span>Work email</span>
        <input type="email" value={email} disabled readOnly />
      </label>
      <label className="auth-field">
        <span>Full name</span>
        <input
          type="text"
          required
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jordan Mensah"
        />
      </label>
      <label className="auth-field">
        <span>Create password (min 10 characters)</span>
        <input
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label className="auth-field">
        <span>Confirm password</span>
        <input
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      <button type="submit" disabled={submitting} className="auth-submit">
        {submitting ? "Activating workspace access..." : "Accept invitation & sign in"}
      </button>
    </form>
  );
}
