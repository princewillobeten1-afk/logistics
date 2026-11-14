import Link from "next/link";
import { Empty, Offline, Panel, Pill } from "@/app/components";
import { relative } from "@/lib/format";
import { listCustomers } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Customers() {
  let customers;
  try {
    customers = await listCustomers();
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Customers</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const withLate = customers.filter((c) => Number(c.late) > 0);

  return (
    <>
      <div className="page-head">
        <h1>Customers</h1>
        <p>
          Who the shipments are for, and the contractual SLA each one is
          measured against. The SLA is not decoration — it sets how much slack a
          lane has, and thin slack turns on-time performance from a preference
          into a floor when carriers are scored.
        </p>
      </div>

      {withLate.length > 0 ? (
        <div className="banner" data-tone="warn">
          <strong>{withLate.length}</strong>{" "}
          {withLate.length === 1 ? "customer has" : "customers have"} shipments
          past their promised time:{" "}
          {withLate.map((c) => c.code).join(", ")}
        </div>
      ) : null}

      <Panel title="All customers" hint={`${customers.length} on file`} flush>
        {customers.length === 0 ? (
          <Empty
            message="No customers yet"
            hint="Your customer accounts are set up by an administrator. Each one carries the delivery promise their shipments are measured against."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Customers"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Name</th>
                  <th scope="col">SLA</th>
                  <th scope="col">Terms</th>
                  <th scope="col">Shipments</th>
                  <th scope="col">Open</th>
                  <th scope="col">Late</th>
                  <th scope="col">Last shipment</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td className="ref">
                      <Link href={`/customers/${encodeURIComponent(c.code)}`}>
                        {c.code}
                      </Link>
                    </td>
                    <td>
                      {c.name}
                      {!c.active ? (
                        <span className="text-faint"> (inactive)</span>
                      ) : null}
                    </td>
                    <td className="num">
                      {c.sla_hours ? `${c.sla_hours} h` : "—"}
                    </td>
                    <td className="text-muted">
                      {c.payment_terms ?? "—"}
                    </td>
                    <td className="num">{c.total}</td>
                    <td className="num">{c.open}</td>
                    <td className="num">
                      {Number(c.late) > 0 ? (
                        <Pill state="ALERT" />
                      ) : (
                        <span className="text-faint">0</span>
                      )}
                    </td>
                    <td className="num text-faint">
                      {c.last_shipment_at ? relative(c.last_shipment_at) : "never"}
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
