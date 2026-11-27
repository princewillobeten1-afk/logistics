import { Empty, Offline, Panel, Pill } from "@/app/components";
import {
  InventoryPolicyForm,
  ReplenishmentOrderActions,
  ReplenishmentSweepButton,
} from "@/components/lifecycle-panels";
import { AddWarehouseForm, StarterNetworkButton } from "@/components/network-crud";
import { money, relative } from "@/lib/format";
import { computeInventoryEconomics } from "@/lib/planning";
import { listInventory, listReplenishmentOrders, listWarehouses } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Warehouses() {
  let warehouses, inventory, replenishments;
  try {
    [warehouses, inventory, replenishments] = await Promise.all([
      listWarehouses(),
      listInventory(),
      listReplenishmentOrders(),
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

  const enrichedInventory = inventory.map((row) => {
    const econ = computeInventoryEconomics({
      onHand: row.on_hand,
      reserved: row.reserved,
      safetyStock: Number(row.safety_stock ?? 20),
      reorderPoint: Number(row.reorder_point ?? 40),
      reorderQuantity: Number(row.reorder_quantity ?? 100),
      unitCostMinor: Number(row.unit_cost_minor ?? 0),
      annualHoldingRate: Number(row.annual_holding_rate ?? 0.2),
    });
    return { ...row, econ };
  });

  const totalStockValueMinor = enrichedInventory.reduce(
    (sum, r) => sum + r.econ.inventoryValueMinor,
    0,
  );
  const totalAnnualHoldingMinor = enrichedInventory.reduce(
    (sum, r) => sum + r.econ.annualHoldingCostMinor,
    0,
  );
  const lowStockCount = enrichedInventory.filter(
    (r) => r.econ.stockHealth !== "HEALTHY",
  ).length;

  return (
    <>
      <div
        className="page-head"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1>Warehouse operations</h1>
          <p>
            Stock, carrying cost control, and automated replenishment.{" "}
            <strong>Dispatch lead time</strong> makes allocation deadline-aware,
            while safety stock &amp; reorder points prevent stockouts without
            inflating holding expenses.
          </p>
        </div>
        {warehouses.length === 0 ? <StarterNetworkButton /> : <StarterNetworkButton compact />}
      </div>

      <Panel title="Add warehouse & stock" hint="create a fulfillment site with initial inventory">
        <AddWarehouseForm />
      </Panel>

      <dl className="tiles">
        <div className="tile">
          <dt>Sites</dt>
          <dd>{warehouses.length}</dd>
          <small>{warehouses.filter((w) => w.active).length} active</small>
        </div>
        <div className="tile">
          <dt>Available units</dt>
          <dd>{(totalOnHand - totalReserved).toLocaleString()}</dd>
          <small>
            {totalOnHand.toLocaleString()} on hand · {totalReserved.toLocaleString()} reserved
          </small>
        </div>
        <div className="tile">
          <dt>Stock valuation</dt>
          <dd>{money(totalStockValueMinor, "NGN")}</dd>
          <small>Carrying cost {money(totalAnnualHoldingMinor, "NGN")}/yr</small>
        </div>
        <div className={lowStockCount > 0 ? "tile warn" : "tile"}>
          <dt>Below reorder point</dt>
          <dd>{lowStockCount}</dd>
          <small>{replenishments.filter((r) => r.status !== "RECEIVED" && r.status !== "CANCELLED").length} open PO(s)</small>
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
                      <td className={`num${lead >= 16 ? " text-warn" : ""}`}>
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

      <Panel title="Inventory & carrying economics" hint={`${enrichedInventory.length} lines`} flush>
        {enrichedInventory.length === 0 ? (
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
                  <th scope="col">Health</th>
                  <th scope="col">Available</th>
                  <th scope="col">On hand / Res</th>
                  <th scope="col">Safety / ROP</th>
                  <th scope="col">Unit Cost</th>
                  <th scope="col">Annual Holding</th>
                  <th scope="col">Utilisation</th>
                </tr>
              </thead>
              <tbody>
                {enrichedInventory.map((row) => {
                  const used = row.on_hand > 0 ? row.reserved / row.on_hand : 0;
                  const tone =
                    row.econ.stockHealth === "CRITICAL"
                      ? "DEAD"
                      : row.econ.stockHealth === "REORDER"
                        ? "SOURCING"
                        : "OK";
                  return (
                    <tr key={`${row.warehouse}-${row.sku}`}>
                      <td className="ref">{row.warehouse}</td>
                      <td className="num">{row.sku}</td>
                      <td>
                        <Pill state={tone} />
                      </td>
                      <td className="num">{row.available}</td>
                      <td className="num">
                        {row.on_hand} / {row.reserved}
                      </td>
                      <td className="num text-faint">
                        {row.safety_stock} / {row.reorder_point}
                      </td>
                      <td className="num">
                        {money(row.unit_cost_minor, row.currency || "NGN")}
                      </td>
                      <td className="num">
                        {money(row.econ.annualHoldingCostMinor, row.currency || "NGN")}/yr
                      </td>
                      <td style={{ width: 140 }}>
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

      <Panel
        title="Configure safety stock & carrying cost policy"
        hint="tune reorder thresholds per SKU"
      >
        <InventoryPolicyForm warehouses={warehouses.map((w) => w.code)} />
      </Panel>

      <Panel
        title="Automated replenishment orders"
        hint="triggered when available stock falls at or below reorder point"
      >
        <div style={{ marginBottom: 14 }}>
          <ReplenishmentSweepButton />
        </div>
        {replenishments.length === 0 ? (
          <Empty
            message="No replenishment proposals"
            hint="Click Check Reorder Points to generate PO proposals for any low-stock SKUs."
          />
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Replenishment orders">
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Status</th>
                  <th scope="col">Warehouse / SKU</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Est. PO Cost</th>
                  <th scope="col">Trigger</th>
                  <th scope="col">Created</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {replenishments.map((r) => (
                  <tr key={r.id}>
                    <td className="ref">{r.reference}</td>
                    <td>
                      <Pill state={r.status} />
                    </td>
                    <td className="num">
                      {r.warehouse_code} / {r.sku}
                    </td>
                    <td className="num">{r.quantity}</td>
                    <td className="num">{money(r.estimated_cost_minor, r.currency)}</td>
                    <td>{r.reason ?? "—"}</td>
                    <td className="num text-faint">{relative(r.created_at)}</td>
                    <td>
                      <ReplenishmentOrderActions id={r.id} status={r.status} />
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
