import Link from "next/link";
import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { city, relative, when } from "@/lib/format";
import { listShipments, shipmentCounts } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Shipments({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;

  let shipments, counts;
  try {
    [shipments, counts] = await Promise.all([
      listShipments(state),
      shipmentCounts(),
    ]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Shipments</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const states = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <div className="page-head">
        <h1>Shipments</h1>
        <p>Every shipment the system knows about, newest activity first.</p>
      </div>

      <nav className="filters" aria-label="Filter shipments by state">
        <Link href="/shipments" data-active={!state}>
          All
        </Link>
        {states.map(([s, n]) => (
          <Link
            key={s}
            href={`/shipments?state=${s}`}
            data-active={state === s}
          >
            <span>{s.replace(/_/g, " ")}</span>
            <span className="font-semibold">{n}</span>
          </Link>
        ))}
      </nav>

      <Panel
        title={state ? `${state.replace(/_/g, " ")} shipments` : "All shipments"}
        hint={`${shipments.length} shown`}
        flush
      >
        {shipments.length === 0 ? (
          <Empty
            message={state ? `Nothing in ${state.replace(/_/g, " ")}` : "No shipments yet"}
            hint={
              state
                ? "Nothing is at this stage right now."
                : "Shipments appear here once a customer's order is confirmed."
            }
            action={
              state
                ? { label: "Show all shipments", href: "/shipments" }
                : { label: "Set up a channel", href: "/settings" }
            }
          />
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Shipments list">
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">State</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Lane</th>
                  <th scope="col">Cargo</th>
                  <th scope="col">Deadline</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {shipments.map((s) => (
                  <tr key={s.id}>
                    <td className="ref">
                      <ShipmentLink reference={s.reference} />
                    </td>
                    <td>
                      <Pill state={s.state} />
                    </td>
                    <td>{s.customer_ref ?? "—"}</td>
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
