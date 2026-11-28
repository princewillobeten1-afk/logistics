import { Offline, Panel } from "@/app/components";
import { ShipmentsBoard } from "@/components/shipments-board";
import { InternationalFreightPanel } from "@/components/shipments/international-freight-panel";
import { currentUser, may } from "@/lib/auth";
import { listShipmentsPaginated, shipmentCounts } from "@/lib/queries";
import { listInternationalFreightRecords } from "@/lib/verticals/store";

export const dynamic = "force-dynamic";

export default async function Shipments({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; q?: string; page?: string; pageSize?: string }>;
}) {
  const { state, q, page, pageSize } = await searchParams;
  const user = await currentUser();
  const canEditCustoms = Boolean(
    user && (may(user.role, "EDIT_SHIPMENT") || may(user.role, "ADMINISTER")),
  );

  let paged, counts, intlRecords;
  try {
    [paged, counts, intlRecords] = await Promise.all([
      listShipmentsPaginated({ state, q, page, pageSize }),
      shipmentCounts(),
      user ? listInternationalFreightRecords(user.orgId) : Promise.resolve([]),
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
        shipments={paged.items}
        counts={counts}
        initialState={state}
        initialQuery={q}
        pagination={{
          page: paged.page,
          pageSize: paged.pageSize,
          total: paged.total,
          totalPages: paged.totalPages,
          startIndex: paged.startIndex,
          endIndex: paged.endIndex,
        }}
      />

      <Panel
        title="International freight & customs clearance"
        hint="HS tariff codes, Incoterms, ISO containers, IATA Air Waybills, and border status"
      >
        <InternationalFreightPanel
          initialRecords={intlRecords}
          shipmentReferences={paged.items.map((s) => s.reference)}
          canEdit={canEditCustoms}
        />
      </Panel>
    </>
  );
}
