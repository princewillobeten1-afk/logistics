import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { city, relative, when } from "@/lib/format";
import { listOrders, listShipments } from "@/lib/queries";

export const dynamic = "force-dynamic";

// Every channel the platform is meant to accept intake from.
const SOURCES = ["API", "ERP", "CRM", "EMAIL", "WHATSAPP", "CSV", "PORTAL", "MANUAL"];
const LIVE_SOURCES = new Set(["API", "CSV", "MANUAL"]);

export default async function Orders() {
  let orders, intake;
  try {
    [orders, intake] = await Promise.all([
      listOrders(),
      listShipments("DRAFT"),
    ]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Orders and shipment requests</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const bySource = orders.reduce<Record<string, number>>((acc, o) => {
    acc[o.source] = (acc[o.source] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <div className="page-head">
        <h1>Orders and shipment requests</h1>
        <p>
          Intake, before validation turns a request into a shipment. The Order
          Agent runs deterministic checks first and only calls a model for the
          judgment those cannot make — is this address deliverable, is this
          deadline plausible.
        </p>
      </div>

      <Panel title="Intake channels" hint="where orders arrive from" flush>
        <div className="scroller" tabIndex={0} role="region" aria-label="Order intake channels">
          <table>
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Status</th>
                <th scope="col">Orders received</th>
              </tr>
            </thead>
            <tbody>
              {SOURCES.map((source) => (
                <tr key={source}>
                  <td className="ref">{source}</td>
                  <td>
                    <Pill state={LIVE_SOURCES.has(source) ? "OK" : "PENDING"} />
                  </td>
                  <td className="num">
                    {bySource[source] ?? 0}
                    {!LIVE_SOURCES.has(source) ? (
                      <span className="text-faint">
                        {" "}
                        — connector not built
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Orders" hint={`${orders.length} recorded`} flush>
        {orders.length === 0 ? (
          <Empty
            message="No orders recorded"
            hint="Orders placed through your channels currently become shipments directly, so they appear under Shipments rather than here."
            action={{ label: "Go to shipments", href: "/shipments" }}
          />
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Recorded orders">
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Source</th>
                  <th scope="col">State</th>
                  <th scope="col">Items</th>
                  <th scope="col">Required by</th>
                  <th scope="col">Received</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="ref">{o.reference}</td>
                    <td>{o.customer ?? "—"}</td>
                    <td>
                      <Pill state={o.source} />
                    </td>
                    <td>
                      <Pill state={o.state} />
                    </td>
                    <td className="num">{o.items}</td>
                    <td className="num">{when(o.required_by)}</td>
                    <td className="num text-faint">
                      {relative(o.ordered_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Awaiting validation"
        hint="shipments still in DRAFT"
        flush
      >
        {intake.length === 0 ? (
          <Empty
            message="Nothing awaiting validation"
            hint="Requests land in DRAFT and leave it as soon as the worker picks them up."
          />
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Shipments awaiting validation">
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Lane</th>
                  <th scope="col">Cargo</th>
                  <th scope="col">Deadline</th>
                  <th scope="col">Waiting</th>
                </tr>
              </thead>
              <tbody>
                {intake.map((s) => (
                  <tr key={s.id}>
                    <td className="ref">
                      <ShipmentLink reference={s.reference} />
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
                      {relative(s.created_at)}
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
