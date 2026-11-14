import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { Live } from "@/app/live";
import { relative } from "@/lib/format";
import { listShipments, openExceptions } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Exceptions() {
  let exceptions, inException;
  try {
    [exceptions, inException] = await Promise.all([
      openExceptions(),
      listShipments("EXCEPTION"),
    ]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Exception control centre</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>Exception control centre</h1>
        <p>
          Detection is deterministic — ETA drift, SLA breach, allocation
          shortfall. A reasoning agent wakes only once something here fires.
        </p>
      </div>

      <Live label="detections and exceptions" />

      <Panel
        title="Shipments in exception"
        hint={`${inException.length} shipment(s)`}
        flush
      >
        {inException.length === 0 ? (
          <Empty
            message="Nothing in exception"
            hint="Shipments land here when allocation falls short or a deadline cannot be met."
          />
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Shipments in exception">
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Entered</th>
                </tr>
              </thead>
              <tbody>
                {inException.map((s) => (
                  <tr key={s.id}>
                    <td className="ref">
                      <ShipmentLink reference={s.reference} />
                    </td>
                    <td>{s.customer_ref ?? "—"}</td>
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

      <Panel
        title="Exception records"
        hint="written by the detection engine"
        flush
      >
        {exceptions.length === 0 ? (
          <Empty
            message="No exception records"
            hint="The tracking and detection engine that writes these is the next phase; shipment-level exceptions above already work."
          />
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Exception records">
            <table>
              <thead>
                <tr>
                  <th scope="col">Severity</th>
                  <th scope="col">Shipment</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Detected by</th>
                  <th scope="col">Raised</th>
                </tr>
              </thead>
              <tbody>
                {exceptions.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Pill
                        state={
                          e.severity === "CRITICAL" || e.severity === "HIGH"
                            ? "EXCEPTION"
                            : e.severity
                        }
                      />
                    </td>
                    <td className="ref">
                      <ShipmentLink reference={e.reference} />
                    </td>
                    <td>{e.kind}</td>
                    <td className="num">{e.detected_by}</td>
                    <td className="num text-faint">
                      {relative(e.created_at)}
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
