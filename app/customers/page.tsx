import Link from "next/link";
import { Empty, Offline, Panel, Pill } from "@/app/components";
import { AddCustomerForm } from "@/components/network-crud";
import { PaginationBar } from "@/components/pagination-bar";
import { TableSearchBar } from "@/components/table-search-bar";
import { relative } from "@/lib/format";
import { listCustomersPaginated } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Customers({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; pageSize?: string }>;
}) {
  const { q, page, pageSize } = await searchParams;

  let paged;
  try {
    paged = await listCustomersPaginated({ q, page, pageSize });
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

  const customers = paged.items;
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

      <Panel title="Add customer account" hint="contractual SLA drives carrier scoring">
        <AddCustomerForm />
      </Panel>

      <TableSearchBar
        basePath="/customers"
        initialQuery={q ?? ""}
        pageSize={paged.pageSize}
        label="Search customers by code, name, or payment terms"
        placeholder="Search customer code, account name, or payment terms…"
        summaryText={
          paged.total === 0
            ? "0 matching customers"
            : `Showing ${paged.startIndex}–${paged.endIndex} of ${paged.total.toLocaleString()} customers`
        }
      />

      <Panel
        title="All customers"
        hint={`${paged.total.toLocaleString()} on file · page ${paged.page} of ${paged.totalPages}`}
        flush
      >
        {customers.length === 0 ? (
          <Empty
            message={q ? "No matching customers" : "No customers yet"}
            hint={
              q
                ? "Try clearing your search to view all customer accounts."
                : "Your customer accounts are set up by an administrator. Each one carries the delivery promise their shipments are measured against."
            }
            action={q ? { label: "Reset search", href: "/customers" } : undefined}
          />
        ) : (
          <>
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

            <PaginationBar
              basePath="/customers"
              page={paged.page}
              pageSize={paged.pageSize}
              total={paged.total}
              totalPages={paged.totalPages}
              startIndex={paged.startIndex}
              endIndex={paged.endIndex}
              queryParams={{ q: q || undefined }}
              itemLabel="customers"
            />
          </>
        )}
      </Panel>
    </>
  );
}
