import { Offline } from "@/app/components";
import { MapViewClient } from "@/components/map-view-client";
import { buildMapNetworkData } from "@/lib/map-data";
import { getServerMapsApiKey } from "@/lib/maps-config";
import { listLocations, listShipments } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function MapPage() {
  let locations, shipments;
  try {
    [locations, shipments] = await Promise.all([listLocations(), listShipments()]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Active shipments map</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const { points, lanes, active } = buildMapNetworkData(locations, shipments);
  const mapsApiKey = getServerMapsApiKey();

  return (
    <>
      <div className="page-head">
        <h1>Active shipments map</h1>
        <p>
          Interactive regional network of hubs, ports, live road corridors, and
          Google Maps place intelligence. Select any site or lane to inspect.
        </p>
      </div>

      <MapViewClient
        apiKey={mapsApiKey}
        initialPoints={points}
        initialLanes={lanes}
        initialActive={active}
      />
    </>
  );
}
