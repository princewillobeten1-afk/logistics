import Link from "next/link";
import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { OrderIntakeForm } from "@/app/orders/order-intake-form";
import { PaginationBar } from "@/components/pagination-bar";
import { TableSearchBar } from "@/components/table-search-bar";
import { city, relative, when } from "@/lib/format";
import { buildPageHref } from "@/lib/pagination";
import { listOrders, listOrdersPaginated, listShipments } from "@/lib/queries";

export const dynamic = "force-dynamic";

// Every channel the platform is meant to accept intake from.
const SOURCES = ["API", "ERP", "CRM", "EMAIL", "WHATSAPP", "CSV", "PORTAL", "MANUAL"];
const LIVE_SOURCES = new Set(["API", "CSV", "MANUAL", "PORTAL", "WHATSAPP", "EMAIL"]);

export default async function Orders({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; source?: string; page?: string; pageSize?: string }>;
}) {
  const { q, source, page, pageSize } = await searchParams;
  const activeSource = source?.trim().toUpperCase() || "";

  let allForChannelCounts, pagedOrders, intake;
  try {
    [allForChannelCounts, pagedOrders, intake] = await Promise.all([
      listOrders(),
      listOrdersPaginated({ q, source: activeSource || undefined, page, pageSize }),
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

  const bySource = allForChannelCounts.reduce<Record<string, number>>((acc, o) => {
    acc[o.source] = (acc[o.source] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <div className="page-head">
        <h1>Orders and shipment requests</h1>
        <p>
          Submit new shipment orders directly or review requests arriving from
          connected intake channels. Incoming orders are automatically validated,
          allocated, and scheduled for fulfillment.
        </p>
      </div>

      <Panel title="New order & shipment request" hint="automated validation & dispatch">
        <OrderIntakeForm />
      </Panel>

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
              {SOURCES.map((src) => (
                <tr key={src}>
                  <td className="ref">
                    <Link
                      href={buildPageHref("/orders", {
                        source: activeSource === src ? undefined : src,
                        q,
                        page: 1,
                        pageSize: pagedOrders.pageSize,
                      })}
                    >
                      {src}
                    </Link>
                  </td>
                  <td>
                    <Pill state={LIVE_SOURCES.has(src) ? "OK" : "PENDING"} />
                  </td>
                  <td className="num">
                    {bySource[src] ?? 0}
                    {!LIVE_SOURCES.has(src) ? (
                      <span className="text-faint">
                        {" "}
                        — connector standby
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <TableSearchBar
        basePath="/orders"
        initialQuery={q ?? ""}
        pageSize={pagedOrders.pageSize}
        extraParams={{ source: activeSource || undefined }}
        label="Search orders by reference, customer, source, or state"
        placeholder="Search order reference, customer, source, or status…"
        summaryText={
          pagedOrders.total === 0
            ? "0 matching orders"
            : `Showing ${pagedOrders.startIndex}–${pagedOrders.endIndex} of ${pagedOrders.total.toLocaleString()} orders`
        }
      />

      {activeSource ? (
        <div className="filters" role="group" aria-label="Active source filter">
          <Link
            href={buildPageHref("/orders", { q, page: 1, pageSize: pagedOrders.pageSize })}
            className="rounded border border-[var(--border)] px-3 py-1 text-xs font-medium hover:bg-[var(--surface)]"
          >
            Clear source filter: {activeSource} ×
          </Link>
        </div>
      ) : null}

      <Panel
        title={activeSource ? `${activeSource} orders` : "Orders"}
        hint={`${pagedOrders.total.toLocaleString()} recorded · page ${pagedOrders.page} of ${pagedOrders.totalPages}`}
        flush
      >
        {pagedOrders.items.length === 0 ? (
          <Empty
            message={q || activeSource ? "No matching orders" : "No orders recorded"}
            hint={
              q || activeSource
                ? "Try clearing your search or channel filter to view all orders."
                : "Orders placed through your channels currently become shipments directly, so they appear under Shipments rather than here."
            }
            action={
              q || activeSource
                ? { label: "Reset filters", href: "/orders" }
                : { label: "Go to shipments", href: "/shipments" }
            }
          />
        ) : (
          <>
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
                  {pagedOrders.items.map((o) => (
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

            <PaginationBar
              basePath="/orders"
              page={pagedOrders.page}
              pageSize={pagedOrders.pageSize}
              total={pagedOrders.total}
              totalPages={pagedOrders.totalPages}
              startIndex={pagedOrders.startIndex}
              endIndex={pagedOrders.endIndex}
              queryParams={{ q: q || undefined, source: activeSource || undefined }}
              itemLabel="orders"
            />
          </>
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
