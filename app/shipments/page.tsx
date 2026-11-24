import { Offline } from "@/app/components";
import { ShipmentsBoard } from "@/components/shipments-board";
import { listShipments, shipmentCounts } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Shipments({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; q?: string }>;
}) {
  const { state, q } = await searchParams;

  let shipments, counts;
  try {
    [shipments, counts] = await Promise.all([
      listShipments(),
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

  return (
    <>
      <div className="page-head">
        <h1>Shipments</h1>
        <p>
          Active and completed shipments across your network, newest updates
          first. Search by reference, customer, lane, or cargo.
        </p>
      </div>

      <ShipmentsBoard
        shipments={shipments}
        counts={counts}
        initialState={state}
        initialQuery={q}
      />
    </>
  );
}
