import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { relative } from "@/lib/format";
import { query } from "@/lib/db";
import { deadWork, queueStats } from "@/lib/queries";
import { formatStateLabel } from "@/lib/view-helpers";

export const dynamic = "force-dynamic";

type PendingRow = {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  run_after: Date;
  reference: string | null;
};

export default async function Queue() {
  let stats, dead, pending;
  try {
    [stats, dead, pending] = await Promise.all([
      queueStats(),
      deadWork(),
      query<PendingRow>(
        `SELECT w.id, w.kind, w.state, w.attempts, w.run_after, s.reference
           FROM work_items w
           LEFT JOIN shipments s ON s.id = w.shipment_id
          WHERE w.state IN ('PENDING','RUNNING')
          ORDER BY w.run_after
          LIMIT 50`,
      ),
    ]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Work queue</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>Work queue</h1>
        <p>
          Every step the system still has to carry out, and anything that
          failed. Work is never lost: if something is interrupted part-way, it
          is picked up again automatically rather than leaving a shipment
          stuck.
        </p>
      </div>

      <dl className="tiles">
        {["PENDING", "RUNNING", "DONE", "DEAD"].map((state) => (
          <div
            key={state}
            className={`tile${state === "DEAD" && (stats[state] ?? 0) > 0 ? " alert" : ""}`}
          >
            <dt>{formatStateLabel(state)}</dt>
            <dd>{stats[state] ?? 0}</dd>
          </div>
        ))}
      </dl>

      {dead.length > 0 ? (
        <Panel title="Dead letters" hint="retries exhausted — needs a human" flush>
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Dead letters"
          >
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
                    <td className="text-crit text-xs">
                      {row.last_error}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel title="Scheduled and in flight" hint={`${pending.length} item(s)`} flush>
        {pending.length === 0 ? (
          <Empty
            message="Queue is clear"
            hint="Every scheduled step has finished. New work is added automatically as shipments progress."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Scheduled and in-flight work items"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Shipment</th>
                  <th scope="col">Step</th>
                  <th scope="col">State</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Runs</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((row) => (
                  <tr key={row.id}>
                    <td className="ref">
                      <ShipmentLink reference={row.reference} />
                    </td>
                    <td className="num">{row.kind}</td>
                    <td>
                      <Pill state={row.state} />
                    </td>
                    <td className="num">{row.attempts}</td>
                    <td className="num text-faint">
                      {relative(row.run_after)}
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
