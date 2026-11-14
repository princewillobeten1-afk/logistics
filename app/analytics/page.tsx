import { Empty, Offline, Panel, Pill } from "@/app/components";
import {
  legStats,
  modelUsage,
  overviewStats,
  shipmentCounts,
  throughput,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Analytics() {
  let counts, stats, legs, usage, daily;
  try {
    [counts, stats, legs, usage, daily] = await Promise.all([
      shipmentCounts(),
      overviewStats(),
      legStats(),
      modelUsage(),
      throughput(),
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
  const maxDaily = Math.max(1, ...daily.map((d) => Number(d.created)));
  const totalCo2e = legs.reduce((a, l) => a + Number(l.total_co2e ?? 0), 0);
  const totalKm = legs.reduce((a, l) => a + Number(l.total_km ?? 0), 0);
  const modelCalls = usage.reduce((a, r) => a + Number(r.calls), 0);

  // The cost thesis, measured: model calls per shipment should stay near 1.
  const callsPerShipment = total > 0 ? modelCalls / total : 0;

  return (
    <>
      <div className="page-head">
        <h1>Analytics and reports</h1>
        <p>
          Operational and model economics from the same event stream the agents
          run on. Carrier cost trends and on-time rates arrive once bookings
          and tracking produce history worth analysing.
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
          <dt>Model calls</dt>
          <dd>{modelCalls}</dd>
          <small>last 24h</small>
        </div>
        <div className="tile">
          <dt>Calls / shipment</dt>
          <dd>{callsPerShipment.toFixed(2)}</dd>
          <small>deterministic steps cost nothing</small>
        </div>
      </dl>

      <div className="grid-2">
        <Panel title="Intake, last 14 days" hint="shipments created per day">
          {daily.length === 0 ? (
            <Empty message="No history yet" />
          ) : (
            <>
              <div className="spark">
                {daily.map((d) => {
                  const n = Number(d.created);
                  return (
                    <div
                      key={d.day}
                      data-empty={n === 0}
                      style={{ height: `${Math.max(2, (n / maxDaily) * 100)}%` }}
                      title={`${d.day}: ${n}`}
                    />
                  );
                })}
              </div>
              <div className="spark-labels">
                {daily.map((d, i) => (
                  <div key={d.day}>{i % 3 === 0 ? d.day.split(" ")[1] : ""}</div>
                ))}
              </div>
            </>
          )}
        </Panel>

        <Panel title="Shipments by state">
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

      <Panel title="Model economics, last 24h" hint="the hot-loop rule, measured" flush>
        {usage.length === 0 ? (
          <Empty
            message="No model calls"
            hint="Allocation, planning and detection are deterministic and never call one."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Model economics"
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

      <Panel title="Not yet measurable">
        <p className="prose">
          On-time delivery rate, cost per kilometre, detention, empty miles,
          claims and carrier cost trends all need booking and tracking history
          that does not exist yet. Showing them as zeroes would be worse than
          not showing them — a dashboard that lies about having data is harder
          to trust than one that says what it cannot yet answer.
        </p>
      </Panel>
    </>
  );
}
