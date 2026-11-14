import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { Live } from "@/app/live";
import { city, relative, when } from "@/lib/format";
import {
  deadWork,
  listShipments,
  modelUsage,
  overviewStats,
  queueStats,
  shipmentCounts,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Overview() {
  let stats, counts, queue, dead, usage, recent;
  try {
    [stats, counts, queue, dead, usage, recent] = await Promise.all([
      overviewStats(),
      shipmentCounts(),
      queueStats(),
      deadWork(),
      modelUsage(),
      listShipments(),
    ]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Operations overview</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const totalShipments = Object.values(counts).reduce((a, b) => a + b, 0);
  const modelCalls = usage.reduce((a, r) => a + Number(r.calls), 0);
  const modelFailures = usage.reduce((a, r) => a + Number(r.failures), 0);

  return (
    <>
      <div className="page-head">
        <h1>Operations overview</h1>
        <p>
          What the floor still owns, and what is waiting on someone. Everything
          here is live from the same Postgres the worker writes to.
        </p>
      </div>

      <Live />

      <dl className="tiles">
        <div className="tile">
          <dt>Active shipments</dt>
          <dd>{stats.active}</dd>
          <small>{totalShipments} total, all states</small>
        </div>
        <div className="tile warn">
          <dt>Waiting on customer</dt>
          <dd>{stats.waitingOnCustomer}</dd>
          <small>blocked at NEEDS_INFO</small>
        </div>
        <div className="tile alert">
          <dt>In exception</dt>
          <dd>{stats.inException}</dd>
          <small>detection fired, needs a decision</small>
        </div>
        <div className="tile alert">
          <dt>Awaiting approval</dt>
          <dd>{stats.awaitingApproval}</dd>
          <small>a human must decide</small>
        </div>
        <div className="tile warn">
          <dt>Deadline &lt; 24h</dt>
          <dd>{stats.deadlineAtRisk}</dd>
          <small>active and due soon</small>
        </div>
      </dl>

      {dead.length > 0 ? (
        <Panel
          title="Stalled work"
          hint="retries exhausted — each one is a shipment going nowhere"
          flush
        >
          <div className="scroller" tabIndex={0} role="region" aria-label="Stalled work items">
            <table>
              <thead>
                <tr>
                  <th scope="col">Shipment</th>
                  <th scope="col">Step</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Last error</th>
                </tr>
              </thead>
              <tbody>
                {dead.map((row) => (
                  <tr key={row.id}>
                    <td className="ref">
                      <ShipmentLink reference={row.reference} />
                    </td>
                    <td className="num">{row.kind}</td>
                    <td className="num">{row.attempts}</td>
                    <td className="text-crit">{row.last_error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <div className="grid-2">
        <Panel title="Work queue" hint="durable steps in Postgres">
          {Object.keys(queue).length === 0 ? (
            <Empty
              message="Nothing in progress"
              hint="Steps appear here as shipments move through planning, sourcing and delivery."
            />
          ) : (
            <dl className="kv">
              {Object.entries(queue).map(([state, n]) => (
                <div key={state} className="contents">
                  <dt>{state}</dt>
                  <dd className="row-center">
                    <Pill state={state} /> <span className="font-mono">{n}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Panel>

        <Panel title="Model usage, last 24h" hint="the cost thesis, measured">
          {usage.length === 0 ? (
            <Empty
              message="No AI activity yet"
              hint="The assistant is only consulted for exceptions and customer replies, so a quiet day shows nothing here."
            />
          ) : (
            <>
              <dl className="kv">
                {usage.map((row) => (
                  <div key={`${row.job}-${row.model}`} className="contents">
                    <dt>{row.job}</dt>
                    <dd>
                      <span className="font-mono">{row.calls} calls</span>
                      {row.avg_latency ? (
                        <span className="text-faint">
                          {" · "}
                          {row.avg_latency}ms avg
                        </span>
                      ) : null}
                      {Number(row.failures) > 0 ? (
                        <span className="text-crit">
                          {" · "}
                          {row.failures} failed
                        </span>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="prose-note">
                {modelCalls} calls across {stats.active} active shipments
                {modelFailures > 0 ? ` · ${modelFailures} failures` : ""}
              </p>
            </>
          )}
        </Panel>
      </div>

      <Panel title="Recent shipments" hint="most recently updated first" flush>
        {recent.length === 0 ? (
          <Empty
            message="No shipments yet"
            hint="Shipments appear here once a customer's order is confirmed. Customers reach you through the channels you connect."
            action={{ label: "Set up a channel", href: "/settings" }}
          />
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Recent shipments">
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">State</th>
                  <th scope="col">Lane</th>
                  <th scope="col">Cargo</th>
                  <th scope="col">Deadline</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {recent.slice(0, 12).map((s) => (
                  <tr key={s.id}>
                    <td className="ref">
                      <ShipmentLink reference={s.reference} />
                    </td>
                    <td>
                      <Pill state={s.state} />
                    </td>
                    <td className="num">
                      {city(s.origin)} → {city(s.destination)}
                    </td>
                    <td className="num">
                      {(s.cargo?.quantity as number) ?? "—"} ×{" "}
                      {(s.cargo?.weight_kg as number) ?? "—"}kg
                    </td>
                    <td className="num">{when(s.deadline)}</td>
                    <td className="num text-faint">
                      {relative(s.updated_at)}
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
