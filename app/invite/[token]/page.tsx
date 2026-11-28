import Image from "next/image";
import Link from "next/link";
import { inspectTeamInvitation } from "@/lib/workspace-admin";
import { AcceptInviteForm } from "./accept-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Workspace Invitation · Control Tower" };

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const info = await inspectTeamInvitation(token);

  return (
    <main className="auth-page">
      <div className="auth-shell">
        <aside className="auth-showcase" aria-label="Workspace isolation details">
          <div className="auth-showcase-head">
            <div className="lp-auth-logo-lock">
              <span className="lp-brand-mark lp-brand-mark-sm">
                <Image
                  src="/images/landing/control-tower-logo.jpg"
                  alt="Control Tower logo"
                  width={26}
                  height={26}
                  className="lp-brand-mark-img"
                  referrerPolicy="no-referrer"
                />
              </span>
              <span>Control Tower</span>
            </div>
            <h2>Private Company Workspace</h2>
            <p>
              Every organisation operates inside an isolated data and AI agent
              boundary. Your account is bound exclusively to the workspace that
              invited you.
            </p>
          </div>
        </aside>

        <div className="auth-card">
          <div className="auth-brand">
            <div className="lp-auth-brand-row">
              <div className="lp-auth-logo-lock">
                <span className="lp-brand-mark lp-brand-mark-sm">
                  <Image
                    src="/images/landing/control-tower-logo.jpg"
                    alt="Control Tower logo"
                    width={24}
                    height={24}
                    className="lp-brand-mark-img"
                    referrerPolicy="no-referrer"
                  />
                </span>
                <span>Control Tower</span>
              </div>
              <Link href="/login" className="auth-link">
                Sign in →
              </Link>
            </div>
            <h1>
              {info ? `Join ${info.orgName}` : "Workspace invitation"}
            </h1>
          </div>

          {!info ? (
            <div className="space-y-3">
              <p className="auth-error" role="alert">
                This invitation link is invalid or does not exist.
              </p>
              <Link href="/login" className="auth-link">
                Return to sign in
              </Link>
            </div>
          ) : !info.valid ? (
            <div className="space-y-3">
              <p className="auth-error" role="alert">
                {info.reason ?? "This invitation is no longer valid."}
              </p>
              <Link href="/login" className="auth-link">
                Return to sign in
              </Link>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded border border-[var(--border)] p-3 text-xs space-y-1">
                <div>
                  <span className="text-[var(--fg-muted)]">Workspace: </span>
                  <strong>{info.orgName}</strong>
                </div>
                <div>
                  <span className="text-[var(--fg-muted)]">Assigned role: </span>
                  <strong className="font-mono">{info.role}</strong>
                </div>
                {info.role !== "ADMIN" && (
                  <>
                    <div>
                      <span className="text-[var(--fg-muted)]">Departments: </span>
                      <span>
                        {info.departments.length > 0
                          ? info.departments.join(", ")
                          : "All workspace departments"}
                      </span>
                    </div>
                    <div>
                      <span className="text-[var(--fg-muted)]">Branches: </span>
                      <span>
                        {info.branchCodes.length > 0
                          ? info.branchCodes.join(", ")
                          : "All workspace branches"}
                      </span>
                    </div>
                  </>
                )}
              </div>

              <AcceptInviteForm token={token} email={info.email} />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
