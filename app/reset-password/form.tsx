"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { resetPasswordAction, type ResetState } from "./actions";

const MIN_PASSWORD_LENGTH = 10;

// Disabled only while submitting — see the note in app/signup/form.tsx.
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="auth-submit"
      data-pending={pending}
      disabled={pending}
    >
      {pending ? "Setting password…" : "Set new password"}
    </button>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState<ResetState, FormData>(
    resetPasswordAction,
    { error: null },
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  return (
    <form action={action} className="auth-form">
      <input type="hidden" name="token" value={token} />

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

      {state.error ? (
        <p className="auth-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}
