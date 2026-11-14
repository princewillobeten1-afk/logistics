"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { loginAction, type LoginState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="auth-submit"
      data-pending={pending}
      disabled={pending}
    >
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState<LoginState, FormData>(loginAction, {
    error: null,
  });
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={action} className="auth-form">
      <input type="hidden" name="next" value={next} />

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
          aria-describedby={state.error ? "login-error" : undefined}
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
            aria-describedby={state.error ? "login-error" : undefined}
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

      {state.error ? (
        <p id="login-error" className="auth-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}
