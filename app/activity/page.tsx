import Link from "next/link";
import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { Live } from "@/app/live";
import { relative } from "@/lib/format";
import {
  activityFeed,
  auditLogs,
  modelUsage,
  type ActivityRow,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

const KINDS = ["MODEL", "EVENT", "TOOL", "GATE"] as const;

const KIND_LABEL: Record<string, string> = {
  MODEL: "Model call",
  EVENT: "Shipment event",
  TOOL: "Tool call",
  GATE: "Policy decision",
};

/** What each row is worth noticing for. Distinct from status colour: a DENY is
 *  the gate working, not a failure. */
function toneFor(row: ActivityRow): string {
  const result = row.result ?? "";
  if (row.kind === "GATE") {
    if (result.startsWith("DENY")) return "crit";
    if (result.startsWith("REQUIRE_APPROVAL")) return "warn";
    return "ok";
  }
  if (row.kind === "TOOL") {
    if (result.startsWith("FAILED")) return "crit";
    if (result.startsWith("INTENT")) return "warn"; // no result: the crash window
    return "ok";
  }
  if (row.kind === "MODEL") return result.startsWith("OK") ? "ok" : "crit";
  return "neutral";
}

export default async function Activity({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { kind } = await searchParams;
  const selected = KINDS.includes(kind as (typeof KINDS)[number]) ? kind : undefined;

  let feed, usage, audit;
  try {
    [feed, usage, audit] = await Promise.all([
      activityFeed(120, selected ? [selected] : undefined),
      modelUsage(),
      auditLogs(),
    ]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Activity</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>Activity</h1>
        <p>
          What the system did, in order — what the assistant was asked, what
          happened to each shipment, what was sent out to carriers and
          customers, and what your spending rules allowed or held back. Shown
          as one timeline, because the useful question is almost always what
          happened next.
        </p>
      </div>

      <Live label="agent and system activity" />

      <div className="filters">
        <Link href="/activity" data-active={!selected}>
          All
        </Link>
        {KINDS.map((k) => (
          <Link key={k} href={`/activity?kind=${k}`} data-active={selected === k}>
            {KIND_LABEL[k]}
          </Link>
        ))}
      </div>

      <Panel
        title="Timeline"
        hint={`${feed.length} most recent${selected ? ` · ${KIND_LABEL[selected]}` : ""}`}
        flush
      >
        {feed.length === 0 ? (
          <Empty
            message="Nothing recorded yet"
            hint="Deterministic steps still write events — an empty feed means nothing has run."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Activity timeline"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Shipment</th>
                  <th scope="col">Why</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {feed.map((row, i) => (
                  <tr key={`${row.kind}-${row.at}-${i}`}>
                    <td className="num text-faint">
                      {relative(row.at)}
                    </td>
                    <td>
                      <span className="kind" data-kind={row.kind}>
                        {row.kind}
                      </span>
                    </td>
                    <td className="text-muted">{row.actor}</td>
                    <td className="num">{row.action}</td>
                    <td className="ref">
                      <ShipmentLink reference={row.reference} />
                    </td>
                    <td className="text-faint text-xs" style={{ maxWidth: 280 }}>
                      {row.reason ?? "—"}
                    </td>
                    <td>
                      {row.result ? (
                        <span className="status-tag" data-tone={toneFor(row)}>
                          {row.result}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Assistant usage, last 24h" hint="calls, latency, and token output" flush>
        {usage.length === 0 ? (
          <Empty
            message="No model calls in the last 24 hours"
            hint="Standard allocation and planning run deterministically without AI calls."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Model usage"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Model</th>
                  <th scope="col">Calls</th>
                  <th scope="col">Avg latency</th>
                  <th scope="col">Output tokens</th>
                  <th scope="col">Failures</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((row) => (
                  <tr key={`${row.job}-${row.model}`}>
                    <td>{row.job}</td>
                    <td className="num text-muted">
                      {row.model.replace("nvidia/", "")}
                    </td>
                    <td className="num">{row.calls}</td>
                    <td className="num">
                      {row.avg_latency ? `${row.avg_latency} ms` : "—"}
                    </td>
                    <td className="num">{row.total_out ?? "—"}</td>
                    <td
                      className={`num${Number(row.failures) > 0 ? " text-crit" : ""}`}
                    >
                      {row.failures}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Audit log"
        hint="what a person did to the system, not what the system did"
        flush
      >
        {audit.length === 0 ? (
          <Empty
            message="No audited actions yet"
            hint="Sign-ins, approval decisions and channel changes land here."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Audit log"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Type</th>
                  <th scope="col">Action</th>
                  <th scope="col">Entity</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((row) => (
                  <tr key={row.id}>
                    <td className="num text-faint">
                      {relative(row.created_at)}
                    </td>
                    <td>{row.actor}</td>
                    <td>
                      <Pill state={row.actor_type} />
                    </td>
                    <td className="num">{row.action}</td>
                    <td className="num text-muted">
                      {row.entity_type ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
