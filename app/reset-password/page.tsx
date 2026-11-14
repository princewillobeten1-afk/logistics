import Link from "next/link";
import { ResetPasswordForm } from "./form";

export const metadata = { title: "Set a new password · Control Tower" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <main className="auth-page">
      <div className="auth-shell">
        <aside className="auth-showcase" aria-label="Security notice">
          <div className="auth-showcase-head">
            <span>Control Tower</span>
            <h2>Choose a New Password</h2>
            <p>
              Use a strong passphrase of at least 10 characters. All active
              sessions on other devices will be signed out automatically.
            </p>
          </div>
        </aside>

        <div className="auth-card">
          <div className="auth-brand">
            <span>Control Tower</span>
            <h1>Set a new password</h1>
          </div>
          {token ? (
            <ResetPasswordForm token={token} />
          ) : (
            <p className="auth-notice" data-tone="warn" role="alert">
              This link is missing its token, so it cannot be used. Request a
              new one from the{" "}
              <Link href="/forgot-password" className="auth-link">
                password reset page
              </Link>
              .
            </p>
          )}
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
