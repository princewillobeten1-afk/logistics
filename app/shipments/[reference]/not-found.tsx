import { Empty, Panel } from "@/app/components";

export default function ShipmentNotFound() {
  return (
    <>
      <div className="page-head">
        <h1>Shipment not found</h1>
        <p>No shipment in your workspace matches that tracking reference.</p>
      </div>
      <Panel title="Not found">
        <Empty
          message="Shipment not found"
          hint="Check the tracking reference or verify you are signed into the right workspace."
          action={{ label: "Back to shipments", href: "/shipments" }}
        />
      </Panel>
    </>
  );
}
