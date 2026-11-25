import { Empty, Offline, Panel, Pill } from "@/app/components";
import { ThroughputChart } from "@/components/throughput-chart";
import { relative } from "@/lib/format";
import {
  legStats,
  modelUsage,
  overviewStats,
  recentInsights,
  shipmentCounts,
  throughput,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Analytics() {
  let counts, stats, legs, usage, daily, insights;
  try {
    [counts, stats, legs, usage, daily, insights] = await Promise.all([
      shipmentCounts(),
      overviewStats(),
      legStats(),
      modelUsage(),
      throughput(),
      recentInsights(),
    ]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Analytics and reports</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const states = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const totalCo2e = legs.reduce((a, l) => a + Number(l.total_co2e ?? 0), 0);
  const totalKm = legs.reduce((a, l) => a + Number(l.total_km ?? 0), 0);
  const modelCalls = usage.reduce((a, r) => a + Number(r.calls), 0);
  const callsPerShipment = total > 0 ? modelCalls / total : 0;

  return (
    <>
      <div className="page-head">
        <h1>Analytics and reports</h1>
        <p>
          Operational volume, mode mix, carbon intensity, and AI usage metrics
          computed directly from live shipment records.
        </p>
      </div>

      <dl className="tiles">
        <div className="tile">
          <dt>Shipments</dt>
          <dd>{total}</dd>
          <small>{stats.active} active</small>
        </div>
        <div className="tile">
          <dt>Distance planned</dt>
          <dd>{totalKm.toLocaleString()}</dd>
          <small>km across all legs</small>
        </div>
        <div className="tile">
          <dt>Emissions</dt>
          <dd>{totalCo2e.toFixed(1)}</dd>
          <small>kg CO2e planned</small>
        </div>
        <div className="tile">
          <dt>AI decisions</dt>
          <dd>{modelCalls}</dd>
          <small>last 24h</small>
        </div>
        <div className="tile">
          <dt>Calls / shipment</dt>
          <dd>{callsPerShipment.toFixed(2)}</dd>
          <small>rule-based routing uses zero</small>
        </div>
      </dl>

      <div className="grid-2">
        <Panel title="Intake and closures, last 14 days" hint="hover or tap a day">
          {daily.length === 0 ? (
            <Empty message="No history yet" />
          ) : (
            <ThroughputChart daily={daily} />
          )}
        </Panel>

        <Panel title="Shipments by status">
          {states.length === 0 ? (
            <Empty message="No shipments yet" />
          ) : (
            <div className="weights">
              {states.map(([state, n]) => (
                <div className="weight-row" key={state}>
                  <span className="label">
                    <Pill state={state} />
                  </span>
                  <span className="bar">
                    <span style={{ width: `${(n / total) * 100}%` }} />
                  </span>
                  <span className="val">{n}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Transport mix" hint="legs, distance and emissions by mode" flush>
        {legs.length === 0 ? (
          <Empty message="Nothing planned yet" />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Transport mix"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Mode</th>
                  <th scope="col">Legs</th>
                  <th scope="col">Distance</th>
                  <th scope="col">CO2e</th>
                  <th scope="col">Intensity</th>
                </tr>
              </thead>
              <tbody>
                {legs.map((l) => {
                  const km = Number(l.total_km ?? 0);
                  const co2e = Number(l.total_co2e ?? 0);
                  return (
                    <tr key={l.mode}>
                      <td>
                        <Pill state={l.mode} />
                      </td>
                      <td className="num">{l.legs}</td>
                      <td className="num">{km.toLocaleString()} km</td>
                      <td className="num">{co2e.toFixed(1)} kg</td>
                      <td className="num text-muted">
                        {km > 0 ? `${((co2e / km) * 1000).toFixed(1)} g/km` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Assistant activity, last 24h" hint="usage and response latency" flush>
        {usage.length === 0 ? (
          <Empty
            message="No assistant calls"
            hint="Standard allocation and route planning run deterministically without AI calls."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Assistant activity"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Workflow</th>
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
                    <td>{row.job.replace(/[._]/g, " ")}</td>
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
        title="AI operational briefings"
        hint="written autonomously by the Analytics Agent over SQL facts"
        flush
      >
        {insights.length === 0 ? (
          <Empty
            message="No briefings yet"
            hint="The Analytics Agent generates daily briefings automatically once at least 5 shipments exist in the current 7-day window."
          />
        ) : (
          <div className="body stack-md">
            {insights.map((ins) => (
              <article key={ins.id} className="approval">
                <header>
                  <div className="row-center" style={{ gap: 8 }}>
                    <Pill state={ins.severity} />
                    <span className="ref">{ins.topic}</span>
                    <strong>{ins.headline}</strong>
                  </div>
                  <span className="expiry">{relative(ins.created_at)}</span>
                </header>
                <p className="summary">{ins.narrative}</p>
                {ins.recommendation ? (
                  <p className="rationale">
                    <strong>Recommended:</strong> {ins.recommendation}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Data completeness">
        <p className="prose">
          Longitudinal carrier cost trends, detention benchmarks, and empty-mile
          ratios will appear here automatically once enough closed bookings and
          verified proofs of delivery accumulate for statistical comparison.
        </p>
      </Panel>
    </>
  );
}
