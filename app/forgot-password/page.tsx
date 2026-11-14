import Link from "next/link";
import { ForgotPasswordForm } from "./form";

export const metadata = { title: "Reset your password · Control Tower" };

export default function ForgotPasswordPage() {
  return (
    <main className="auth-page">
      <div className="auth-shell">
        <aside className="auth-showcase" aria-label="Account recovery">
          <div className="auth-showcase-head">
            <span>Control Tower</span>
            <h2>Account Recovery</h2>
            <p>
              Enter your account email address to receive a one-time, time-bound
              password reset link.
            </p>
          </div>
          <ul className="auth-features">
            <li>
              <span className="feat-dot" aria-hidden="true">01</span>
              <div>
                <strong>Single-Use Reset Tokens</strong>
                Reset links expire automatically after 1 hour and can only be
                used once.
              </div>
            </li>
            <li>
              <span className="feat-dot" aria-hidden="true">02</span>
              <div>
                <strong>Session Revocation</strong>
                Completing a password reset immediately revokes all existing
                sessions for your account.
              </div>
            </li>
          </ul>
        </aside>

        <div className="auth-card">
          <div className="auth-brand">
            <span>Control Tower</span>
            <h1>Reset your password</h1>
          </div>
          <p className="auth-lede">
            Enter your email address and we will send you a link to set a new
            password.
          </p>
          <ForgotPasswordForm />
          <div className="auth-links">
            <Link href="/login" className="auth-link">
              ← Back to sign in
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
