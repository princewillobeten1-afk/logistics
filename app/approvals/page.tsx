import { decideApproval } from "@/app/approvals/actions";
import { Empty, Offline, Panel, ShipmentLink } from "@/app/components";
import { may, requireUser } from "@/lib/auth";
import { money, relative, when } from "@/lib/format";
import { openApprovals } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Approvals() {
  // The buttons are hidden from anyone who cannot use them, but the action
  // checks the role again on its own — hiding a control is presentation, not
  // authorisation, and a form can be submitted without the page.
  const user = await requireUser();
  const canApprove = may(user.role, "APPROVE");

  let approvals;
  try {
    approvals = await openApprovals();
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Approval queue</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>Approval queue</h1>
        <p>
          Spending decisions the system will not make on its own. Every booking
          that costs money currently reaches a person — the limits only rise
          once there is a track record showing the recommendations were sound.
        </p>
      </div>

      <Panel
        title="Pending"
        hint={`${approvals.length} awaiting a decision`}
        flush
      >
        {approvals.length === 0 ? (
          <Empty
            message="Nothing awaiting approval"
            hint="Bookings that would spend more than your approval limit allows appear here for a decision."
          />
        ) : (
          <div className="body stack-md">
            {approvals.map((a) => (
              <article key={a.id} className="approval">
                <header>
                  <div>
                    <span className="amount">
                      {money(a.amount_minor, a.currency)}
                    </span>
                    <span className="ref">
                      <ShipmentLink reference={a.reference} />
                    </span>
                  </div>
                  <span className="expiry">
                    requested {relative(a.requested_at)} · expires{" "}
                    {when(a.expires_at)}
                  </span>
                </header>

                <p className="summary">{a.summary}</p>

                {a.rationale && a.rationale !== a.summary ? (
                  <p className="rationale">{a.rationale}</p>
                ) : null}

                {canApprove ? (
                  <form action={decideApproval} className="decide">
                    <input type="hidden" name="token" value={a.token} />
                    <button type="submit" name="decision" value="approve" className="approve">
                      Approve
                    </button>
                    <button type="submit" name="decision" value="reject" className="reject">
                      Reject
                    </button>
                    <span className="note">
                      Deciding as <strong>{user.email}</strong>. Approving queues
                      the booking; the worker executes it through the idempotent
                      tool path.
                    </span>
                  </form>
                ) : (
                  <p className="prose-note">
                    Your role ({user.role}) cannot authorise spending. An
                    approver has to decide this one.
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="How this works">
        <p className="prose">
          The assistant can recommend a booking but never authorise one. Your
          spending limits are applied separately, where the assistant cannot
          change them, and only a person can approve. Each decision counts
          once — approving twice by accident cannot book twice or double the
          amount.
        </p>
      </Panel>
    </>
  );
}
