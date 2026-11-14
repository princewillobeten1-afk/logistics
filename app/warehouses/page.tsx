import { Empty, Offline, Panel, Pill } from "@/app/components";
import { listInventory, listWarehouses } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Warehouses() {
  let warehouses, inventory;
  try {
    [warehouses, inventory] = await Promise.all([
      listWarehouses(),
      listInventory(),
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
          <dd>{totalOnHand.toLocaleString()}</dd>
        </div>
        <div className="tile warn">
          <dt>Reserved</dt>
          <dd>{totalReserved.toLocaleString()}</dd>
          <small>held against open shipments</small>
        </div>
        <div className="tile">
          <dt>Available</dt>
          <dd>{(totalOnHand - totalReserved).toLocaleString()}</dd>
        </div>
      </dl>

      <Panel title="Sites" hint="dispatch lead drives allocation" flush>
        {warehouses.length === 0 ? (
          <Empty
            message="No warehouses yet"
            hint="Your sites and their stock are set up by an administrator."
          />
        ) : (
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
                {warehouses.map((w) => {
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
        )}
      </Panel>

      <Panel title="Inventory" hint={`${inventory.length} lines`} flush>
        {inventory.length === 0 ? (
          <Empty message="No stock recorded" />
        ) : (
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
                {inventory.map((row) => {
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
        )}
      </Panel>

      <Panel title="Picking and packing" hint="written by warehouse.allocate">
        <Empty
          message="No open picking tasks"
          hint="Stock is reserved against a shipment as soon as it is allocated. Picking instructions for the warehouse floor are not issued from here yet."
        />
      </Panel>
    </>
  );
}
