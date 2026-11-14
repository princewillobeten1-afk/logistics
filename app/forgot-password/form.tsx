"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { requestResetAction, type ForgotState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="auth-submit"
      data-pending={pending}
      disabled={pending}
    >
      {pending ? "Sending…" : "Send reset link"}
    </button>
  );
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState<ForgotState, FormData>(
    requestResetAction,
    { submitted: false, error: null },
  );

  if (state.submitted) {
    return (
      <p className="auth-notice" role="status">
        If an account exists for that email, a reset link is on its way. It
        expires in an hour and works once.
      </p>
    );
  }

  return (
    <form action={action} className="auth-form">
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
          aria-describedby={state.error ? "forgot-error" : undefined}
        />
      </div>

      {state.error ? (
        <p id="forgot-error" className="auth-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}
