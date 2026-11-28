import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { Live } from "@/app/live";
import { PaginationBar } from "@/components/pagination-bar";
import { TableSearchBar } from "@/components/table-search-bar";
import { relative } from "@/lib/format";
import { paginateArray } from "@/lib/pagination";
import { listShipments, openExceptions } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Exceptions({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; pageSize?: string }>;
}) {
  const sp = await searchParams;
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

  const pagedShipments = paginateArray(inException, {
    q: sp.q,
    page: sp.page,
    pageSize: sp.pageSize,
    matcher: (s, q) =>
      s.reference.toLowerCase().includes(q) ||
      (s.customer_ref ?? "").toLowerCase().includes(q),
  });

  const pagedExceptions = paginateArray(exceptions, {
    q: sp.q,
    page: sp.page,
    pageSize: sp.pageSize,
    matcher: (e, q) =>
      (e.reference ?? "").toLowerCase().includes(q) ||
      e.kind.toLowerCase().includes(q) ||
      e.severity.toLowerCase().includes(q) ||
      e.detected_by.toLowerCase().includes(q),
  });

  const queryParams = { q: pagedExceptions.query || undefined };

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

      <TableSearchBar
        basePath="/exceptions"
        initialQuery={pagedExceptions.query}
        pageSize={pagedExceptions.pageSize}
        placeholder="Filter exceptions by shipment, issue, severity, or detector…"
        label="Search exceptions"
        summaryText={`${pagedExceptions.total} open exception(s) · ${pagedShipments.total} shipment(s) in exception`}
      />

      <Panel
        title="Shipments in exception"
        hint={`${pagedShipments.total} shipment(s)`}
        flush
      >
        {pagedShipments.items.length === 0 ? (
          <Empty
            message={
              pagedShipments.query
                ? `No exception shipments matching "${pagedShipments.query}"`
                : "Nothing in exception"
            }
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
                {pagedShipments.items.map((s) => (
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
        <PaginationBar
          basePath="/exceptions"
          page={pagedShipments.page}
          pageSize={pagedShipments.pageSize}
          total={pagedShipments.total}
          totalPages={pagedShipments.totalPages}
          startIndex={pagedShipments.startIndex}
          endIndex={pagedShipments.endIndex}
          queryParams={queryParams}
          itemLabel="exception shipments"
        />
      </Panel>

      <Panel
        title="Exception records"
        hint={`${pagedExceptions.total} open · raised by automated monitoring`}
        flush
      >
        {pagedExceptions.items.length === 0 ? (
          <Empty
            message={
              pagedExceptions.query
                ? `No exception records matching "${pagedExceptions.query}"`
                : "No open exception records"
            }
            hint="All active shipments are currently operating within SLA thresholds."
          />
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Exception records">
            <table>
              <thead>
                <tr>
                  <th scope="col">Severity</th>
                  <th scope="col">Shipment</th>
                  <th scope="col">Issue</th>
                  <th scope="col">Detected by</th>
                  <th scope="col">Raised</th>
                </tr>
              </thead>
              <tbody>
                {pagedExceptions.items.map((e) => (
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
                    <td>{e.kind.replace(/_/g, " ")}</td>
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
        <PaginationBar
          basePath="/exceptions"
          page={pagedExceptions.page}
          pageSize={pagedExceptions.pageSize}
          total={pagedExceptions.total}
          totalPages={pagedExceptions.totalPages}
          startIndex={pagedExceptions.startIndex}
          endIndex={pagedExceptions.endIndex}
          queryParams={queryParams}
          itemLabel="exception records"
        />
      </Panel>
    </>
  );
}
