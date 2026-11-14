import Link from "next/link";
import { SignUpForm } from "./form";

export const metadata = { title: "Create your workspace · Control Tower" };

export default function SignUpPage() {
  return (
    <main className="auth-page">
      <div className="auth-shell">
        <aside className="auth-showcase" aria-label="Workspace features">
          <div className="auth-showcase-head">
            <span>Control Tower</span>
            <h2>Launch Your Operations Floor</h2>
            <p>
              Set up a dedicated multi-tenant workspace for your logistics
              network in seconds.
            </p>
          </div>

          <ul className="auth-features">
            <li>
              <span className="feat-dot" aria-hidden="true">01</span>
              <div>
                <strong>Full Administrator Control</strong>
                Configure customer channels, spend caps, and carrier networks
                from one place.
              </div>
            </li>
            <li>
              <span className="feat-dot" aria-hidden="true">02</span>
              <div>
                <strong>Live Event Stream</strong>
                Track every shipment transition, quote, and policy gate in real
                time.
              </div>
            </li>
            <li>
              <span className="feat-dot" aria-hidden="true">03</span>
              <div>
                <strong>Audited Decisions</strong>
                Every human approval and AI recommendation is recorded in an
                immutable timeline.
              </div>
            </li>
          </ul>
        </aside>

        <div className="auth-card">
          <div className="auth-brand">
            <span>Control Tower</span>
            <h1>Create your workspace</h1>
          </div>
          <p className="auth-lede">
            Create a workspace for your company. You will be its first
            administrator, and can add the rest of your team afterwards.
          </p>
          <SignUpForm />
          <div className="auth-links">
            <span className="text-faint">Already have a workspace?</span>
            <Link href="/login" className="auth-link">
              Sign in →
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
