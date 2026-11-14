"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { signUpAction, type SignUpState } from "./actions";

const MIN_PASSWORD_LENGTH = 10;

// Disabled only while genuinely submitting. Gating the button on validation
// instead produces a dead control with no explanation of what is wrong — and
// with `cursor: progress` on it, one that looks like it is already working.
// The inline hints below, the native minLength, and signUp()'s own checks all
// still catch a bad password; none of them require a button that cannot be
// pressed.
function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="auth-submit"
      data-pending={pending}
      disabled={pending}
    >
      {pending ? "Creating your workspace…" : "Create workspace"}
    </button>
  );
}

export function SignUpForm() {
  const [state, action] = useActionState<SignUpState, FormData>(signUpAction, {
    error: null,
  });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  return (
    <form action={action} className="auth-form">
      <div className="auth-field">
        <label htmlFor="signup-company">Company name</label>
        <input
          id="signup-company"
          name="companyName"
          type="text"
          autoComplete="organization"
          autoFocus
          required
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

      {state.error ? (
        <p className="auth-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}
