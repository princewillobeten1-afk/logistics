import { decideApproval } from "@/app/approvals/actions";
import { Empty, Offline, Panel, ShipmentLink } from "@/app/components";
import { PaginationBar } from "@/components/pagination-bar";
import { TableSearchBar } from "@/components/table-search-bar";
import { may, requireUser } from "@/lib/auth";
import { money, relative, when } from "@/lib/format";
import { paginateArray } from "@/lib/pagination";
import { openApprovals } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Approvals({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; pageSize?: string }>;
}) {
  // The buttons are hidden from anyone who cannot use them, but the action
  // checks the role again on its own — hiding a control is presentation, not
  // authorisation, and a form can be submitted without the page.
  const [user, sp] = await Promise.all([requireUser(), searchParams]);
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

  const pagedApprovals = paginateArray(approvals, {
    q: sp.q,
    page: sp.page,
    pageSize: sp.pageSize,
    matcher: (a, q) =>
      (a.reference ?? "").toLowerCase().includes(q) ||
      a.summary.toLowerCase().includes(q) ||
      (a.rationale ?? "").toLowerCase().includes(q) ||
      a.currency.toLowerCase().includes(q),
  });

  const queryParams = { q: pagedApprovals.query || undefined };

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

      <TableSearchBar
        basePath="/approvals"
        initialQuery={pagedApprovals.query}
        pageSize={pagedApprovals.pageSize}
        placeholder="Filter approvals by shipment reference, summary, or rationale…"
        label="Search pending approvals"
        summaryText={`${pagedApprovals.total} pending approval(s)`}
      />

      <Panel
        title="Pending"
        hint={`${pagedApprovals.total} awaiting a decision`}
        flush
      >
        {pagedApprovals.items.length === 0 ? (
          <Empty
            message={
              pagedApprovals.query
                ? `No approvals matching "${pagedApprovals.query}"`
                : "Nothing awaiting approval"
            }
            hint="Bookings that would spend more than your approval limit allows appear here for a decision."
          />
        ) : (
          <div className="body stack-md">
            {pagedApprovals.items.map((a) => (
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
                      Deciding as <strong>{user.email}</strong>. Approving
                      authorises and queues the carrier booking once.
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
        <PaginationBar
          basePath="/approvals"
          page={pagedApprovals.page}
          pageSize={pagedApprovals.pageSize}
          total={pagedApprovals.total}
          totalPages={pagedApprovals.totalPages}
          startIndex={pagedApprovals.startIndex}
          endIndex={pagedApprovals.endIndex}
          queryParams={queryParams}
          itemLabel="approvals"
        />
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
