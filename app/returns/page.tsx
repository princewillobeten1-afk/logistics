import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { CreateRmaForm, RmaLifecycleActions } from "@/components/lifecycle-panels";
import { money, relative } from "@/lib/format";
import { listReturnAuthorizations, listWarehouses } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ReturnsPage() {
  let rmas, warehouses;
  try {
    [rmas, warehouses] = await Promise.all([
      listReturnAuthorizations(),
      listWarehouses(),
    ]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Returns &amp; Product Lifecycle (RMA)</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const openCount = rmas.filter((r) => !["CLOSED", "REJECTED"].includes(r.state)).length;
  const restockedUnits = rmas
    .filter((r) => r.state === "RESTOCKED" || r.disposition === "RESTOCK")
    .reduce((sum, r) => sum + Number(r.quantity || 0), 0);
  const recallsCount = rmas.filter((r) => r.reason === "RECALL" || r.state === "RECALLED").length;
  const totalRefundMinor = rmas.reduce((sum, r) => sum + Number(r.refund_minor || 0), 0);

  return (
    <>
      <div className="page-head">
        <h1>Returns &amp; Product Lifecycle (RMA)</h1>
        <p>
          Reverse logistics, warranty returns, lot/serial recalls, quality
          inspection, and closed-loop warehouse restocking or end-of-life
          disposition.
        </p>
      </div>

      <dl className="tiles">
        <div className="tile">
          <dt>Total RMAs</dt>
          <dd>{rmas.length}</dd>
        </div>
        <div className="tile warn">
          <dt>Open RMAs</dt>
          <dd>{openCount}</dd>
        </div>
        <div className="tile">
          <dt>Units restocked</dt>
          <dd>{restockedUnits}</dd>
        </div>
        <div className="tile">
          <dt>Recalls / Credits</dt>
          <dd>{recallsCount}</dd>
          <small>{money(totalRefundMinor, "NGN")} issued</small>
        </div>
      </dl>

      <Panel
        title="Issue Return Merchandise Authorization (RMA)"
        hint="intake, lot/serial traceability & reverse pickup"
      >
        <CreateRmaForm warehouses={warehouses.map((w) => w.code)} />
      </Panel>

      <Panel title="Active & historical RMAs" hint={`${rmas.length} authorizations`} flush>
        {rmas.length === 0 ? (
          <Empty
            message="No return authorizations recorded"
            hint="Issue an RMA above to track damaged returns, warranty repairs, recalls, or restocking."
          />
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Return authorizations">
            <table>
              <thead>
                <tr>
                  <th scope="col">RMA</th>
                  <th scope="col">State</th>
                  <th scope="col">Reason / Notes</th>
                  <th scope="col">SKU &amp; Qty</th>
                  <th scope="col">Traceability</th>
                  <th scope="col">Return DC</th>
                  <th scope="col">Shipment</th>
                  <th scope="col">Credit</th>
                  <th scope="col">Disposition</th>
                  <th scope="col">Created</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rmas.map((r) => (
                  <tr key={r.id}>
                    <td className="ref">{r.rma_number}</td>
                    <td>
                      <Pill state={r.state} />
                    </td>
                    <td>
                      <div>{r.reason}</div>
                      {r.condition_notes ? (
                        <div className="text-faint text-xs">{r.condition_notes}</div>
                      ) : null}
                    </td>
                    <td className="num">
                      {r.sku} × {r.quantity}
                    </td>
                    <td className="num text-xs">
                      {r.lot_number ? <div>Lot: {r.lot_number}</div> : null}
                      {r.serial_number ? <div>SN: {r.serial_number}</div> : null}
                      {!r.lot_number && !r.serial_number ? "—" : null}
                    </td>
                    <td className="num">{r.warehouse_code ?? "—"}</td>
                    <td className="ref">
                      <ShipmentLink reference={r.shipment_reference} />
                    </td>
                    <td className="num">{money(r.refund_minor, r.currency)}</td>
                    <td className="num">{r.disposition ?? "—"}</td>
                    <td className="num text-faint">{relative(r.created_at)}</td>
                    <td>
                      <RmaLifecycleActions id={r.id} state={r.state} />
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
