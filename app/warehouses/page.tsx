import { Empty, Offline, Panel } from "@/app/components";
import { PaginationBar } from "@/components/pagination-bar";
import { TableSearchBar } from "@/components/table-search-bar";
import { InventoryReservationChart } from "@/components/warehouses/inventory-reservation-chart";
import { ThirdPartyClientsPanel } from "@/components/warehouses/third-party-clients-panel";
import { currentUser, may } from "@/lib/auth";
import { paginateArray } from "@/lib/pagination";
import { listInventory, listShipments, listWarehouses } from "@/lib/queries";
import { computeClientFulfillmentReports } from "@/lib/verticals/freight-and-3pl";
import { listThirdPartyClients } from "@/lib/verticals/store";

export const dynamic = "force-dynamic";

export default async function Warehouses({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; pageSize?: string }>;
}) {
  const { q, page, pageSize } = await searchParams;
  const user = await currentUser();
  const canEdit3pl = Boolean(
    user && (may(user.role, "EDIT_SHIPMENT") || may(user.role, "ADMINISTER")),
  );

  let warehouses, inventory, shipments, thirdPartyClients;
  try {
    [warehouses, inventory, shipments, thirdPartyClients] = await Promise.all([
      listWarehouses(),
      listInventory(),
      listShipments(),
      user ? listThirdPartyClients(user.orgId) : Promise.resolve([]),
    ]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Warehouse operations</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const totalOnHand = inventory.reduce((a, r) => a + r.on_hand, 0);
  const totalReserved = inventory.reduce((a, r) => a + r.reserved, 0);
  const generatedAtIso = new Date().toISOString();

  const trendWarehouses = warehouses.map((w) => ({
    code: w.code,
    name: w.name,
    active: w.active,
  }));

  const trendShipments = shipments.map((s) => ({
    id: s.id,
    reference: s.reference,
    state: s.state,
    cargo: s.cargo,
    allocation: s.allocation,
    origin: s.origin,
    created_at:
      s.created_at instanceof Date
        ? s.created_at.toISOString()
        : String(s.created_at),
    updated_at:
      s.updated_at instanceof Date
        ? s.updated_at.toISOString()
        : s.updated_at
          ? String(s.updated_at)
          : null,
  }));

  const clientReports = computeClientFulfillmentReports(
    thirdPartyClients,
    inventory,
    shipments,
  );

  const pagedWarehouses = paginateArray(warehouses, {
    q,
    page,
    pageSize,
    matcher: (w, needle) =>
      `${w.code} ${w.name} ${w.city ?? ""} ${w.country ?? ""}`
        .toLowerCase()
        .includes(needle),
  });

  const pagedInventory = paginateArray(inventory, {
    q,
    page,
    pageSize,
    matcher: (row, needle) =>
      `${row.warehouse} ${row.sku}`.toLowerCase().includes(needle),
  });

  return (
    <>
      <div className="page-head">
        <h1>Warehouse operations</h1>
        <p>
          Stock and dispatch capability. <strong>Dispatch lead time</strong> is
          what makes allocation deadline-aware rather than merely stock-aware —
          the nearest warehouse is not the fastest when it takes twice as long
          to get goods onto a vehicle.
        </p>
      </div>

      <dl className="tiles">
        <div className="tile">
          <dt>Sites</dt>
          <dd>{warehouses.length}</dd>
          <small>{warehouses.filter((w) => w.active).length} active</small>
        </div>
        <div className="tile">
          <dt>Units on hand</dt>
          <dd>{totalOnHand.toLocaleString("en-US")}</dd>
        </div>
        <div className="tile warn">
          <dt>Reserved</dt>
          <dd>{totalReserved.toLocaleString("en-US")}</dd>
          <small>held against open shipments</small>
        </div>
        <div className="tile">
          <dt>Available</dt>
          <dd>{(totalOnHand - totalReserved).toLocaleString("en-US")}</dd>
        </div>
      </dl>

      <Panel
        title="Inventory vs. reservations (30 days)"
        hint="on-hand levels compared with reservation demand"
      >
        <InventoryReservationChart
          warehouses={trendWarehouses}
          inventory={inventory}
          shipments={trendShipments}
          generatedAtIso={generatedAtIso}
        />
      </Panel>

      <TableSearchBar
        basePath="/warehouses"
        initialQuery={pagedWarehouses.query}
        pageSize={pagedWarehouses.pageSize}
        placeholder="Filter warehouses or inventory by site code, city, or SKU…"
        label="Search warehouses and inventory"
        summaryText={`${pagedWarehouses.total.toLocaleString()} sites · ${pagedInventory.total.toLocaleString()} SKU lines`}
      />

      <Panel
        title="Sites"
        hint={`${pagedWarehouses.total.toLocaleString()} matching · page ${pagedWarehouses.page} of ${pagedWarehouses.totalPages}`}
        flush
      >
        {pagedWarehouses.items.length === 0 ? (
          <Empty
            message={pagedWarehouses.query ? "No matching warehouses" : "No warehouses yet"}
            hint={
              pagedWarehouses.query
                ? "Clear your filter to view all warehouse sites."
                : "Your sites and their stock are set up by an administrator."
            }
          />
        ) : (
          <>
            <div
              className="scroller"
              tabIndex={0}
              role="region"
              aria-label="Warehouse sites"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Location</th>
                    <th scope="col">Dispatch lead</th>
                    <th scope="col">SKUs</th>
                    <th scope="col">On hand</th>
                    <th scope="col">Reserved</th>
                    <th scope="col">Handling</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedWarehouses.items.map((w) => {
                    const lead = Number(w.dispatch_lead_hours);
                    return (
                      <tr key={w.id}>
                        <td className="ref">{w.code}</td>
                        <td>{w.name}</td>
                        <td className="num">
                          {w.city ?? "—"}
                          {w.country ? `, ${w.country}` : ""}
                        </td>
                        <td
                          className={`num${lead >= 16 ? " text-warn" : ""}`}
                        >
                          {lead} h
                        </td>
                        <td className="num">{w.skus ?? 0}</td>
                        <td className="num">{w.on_hand ?? 0}</td>
                        <td className="num">{w.reserved ?? 0}</td>
                        <td className="num text-faint">
                          {[
                            w.handles_hazmat ? "hazmat" : null,
                            w.handles_reefer ? "reefer" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "standard"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <PaginationBar
              basePath="/warehouses"
              page={pagedWarehouses.page}
              pageSize={pagedWarehouses.pageSize}
              total={pagedWarehouses.total}
              totalPages={pagedWarehouses.totalPages}
              startIndex={pagedWarehouses.startIndex}
              endIndex={pagedWarehouses.endIndex}
              queryParams={{ q: pagedWarehouses.query || undefined }}
              itemLabel="warehouses"
            />
          </>
        )}
      </Panel>

      <Panel
        title="Inventory"
        hint={`${pagedInventory.total.toLocaleString()} matching lines · page ${pagedInventory.page} of ${pagedInventory.totalPages}`}
        flush
      >
        {pagedInventory.items.length === 0 ? (
          <Empty
            message={pagedInventory.query ? "No matching stock lines" : "No stock recorded"}
          />
        ) : (
          <>
            <div
              className="scroller"
              tabIndex={0}
              role="region"
              aria-label="Warehouse inventory"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Warehouse</th>
                    <th scope="col">SKU</th>
                    <th scope="col">On hand</th>
                    <th scope="col">Reserved</th>
                    <th scope="col">Available</th>
                    <th scope="col">Utilisation</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedInventory.items.map((row) => {
                    const used = row.on_hand > 0 ? row.reserved / row.on_hand : 0;
                    return (
                      <tr key={`${row.warehouse}-${row.sku}`}>
                        <td className="ref">{row.warehouse}</td>
                        <td className="num">{row.sku}</td>
                        <td className="num">{row.on_hand}</td>
                        <td className="num">{row.reserved}</td>
                        <td className="num">{row.available}</td>
                        <td style={{ width: 160 }}>
                          <span
                            className="bar"
                            data-tone={used > 0.9 ? "alert" : used > 0.7 ? "warn" : undefined}
                          >
                            <span style={{ width: `${used * 100}%` }} />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <PaginationBar
              basePath="/warehouses"
              page={pagedInventory.page}
              pageSize={pagedInventory.pageSize}
              total={pagedInventory.total}
              totalPages={pagedInventory.totalPages}
              startIndex={pagedInventory.startIndex}
              endIndex={pagedInventory.endIndex}
              queryParams={{ q: pagedInventory.query || undefined }}
              itemLabel="inventory lines"
            />
          </>
        )}
      </Panel>

      <Panel
        title="3PL multi-client operations & segregated reporting"
        hint="manage client accounts, SKU segregation, SLAs, and monthly billing"
      >
        <ThirdPartyClientsPanel
          initialClients={thirdPartyClients}
          initialReports={clientReports}
          warehouseCodes={warehouses.map((w) => w.code)}
          canEdit={canEdit3pl}
        />
      </Panel>

      <Panel title="Picking and packing" hint="warehouse floor tasks">
        <Empty
          message="No open picking tasks"
          hint="Stock is reserved against a shipment as soon as it is allocated. Picking instructions for the warehouse floor are not issued from here yet."
        />
      </Panel>
    </>
  );
}
