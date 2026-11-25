import Link from "next/link";
import { LoginForm } from "./form";

export const metadata = { title: "Sign in · Control Tower" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string; expired?: string }>;
}) {
  const { next, reset, expired } = await searchParams;

  return (
    <main className="auth-page">
      <div className="auth-shell">
        <aside className="auth-showcase" aria-label="Platform capabilities">
          <div className="auth-showcase-head">
            <span>Control Tower</span>
            <h2>Autonomous Logistics Operations</h2>
            <p>
              Deterministic planning and carrier scoring paired with policy-gated
              AI exception handling.
            </p>
          </div>

          <ul className="auth-features">
            <li>
              <span className="feat-dot" aria-hidden="true">01</span>
              <div>
                <strong>Deterministic Core</strong>
                Stock allocation, corridor planning, and carrier scoring run
                reproducibly in code.
              </div>
            </li>
            <li>
              <span className="feat-dot" aria-hidden="true">02</span>
                <div>
                <strong>Policy-Gated Spend</strong>
                Every booking passes through versioned spend caps and human
                approval gates.
              </div>
            </li>
            <li>
              <span className="feat-dot" aria-hidden="true">03</span>
              <div>
                <strong>Tenant-Isolated by Design</strong>
                Row-level isolation scopes every record and workflow to your
                organisation.
              </div>
            </li>
          </ul>
        </aside>

        <div className="auth-card">
          <div className="auth-brand">
            <div className="lp-auth-brand-row">
              <span>Control Tower</span>
              <Link href="/" className="auth-link">
                ← Back to overview
              </Link>
            </div>
            <h1>Sign in to your workspace</h1>
          </div>
          {reset ? (
            <p className="auth-notice" role="status">
              Your password has been changed. Sign in with your new password.
            </p>
          ) : expired ? (
            <p className="auth-notice" role="status">
              Your previous session expired. Sign in to continue.
            </p>
          ) : null}
          <LoginForm next={next ?? "/"} />
          <div className="auth-links">
            <Link href="/forgot-password" className="auth-link">
              Forgot password?
            </Link>
            <Link href="/signup" className="auth-link">
              Create a workspace →
            </Link>
          </div>
          <p className="auth-foot">
            Joining an existing workspace? Ask its administrator to provision
            your account.
          </p>
        </div>
      </div>
    </main>
  );
}
