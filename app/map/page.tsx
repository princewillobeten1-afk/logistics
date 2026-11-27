import { Offline } from "@/app/components";
import { MapViewClient } from "@/components/map-view-client";
import { buildMapDriverPins, buildMapNetworkData } from "@/lib/map-data";
import { getServerMapsApiKey } from "@/lib/maps-config";
import { listDrivers, listLocations, listShipments } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function MapPage() {
  let locations, shipments, drivers;
  try {
    [locations, shipments, drivers] = await Promise.all([
      listLocations(),
      listShipments(),
      listDrivers(),
    ]);
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
  const driverPins = buildMapDriverPins(drivers, locations);
  const mapsApiKey = getServerMapsApiKey();

  return (
    <>
      <div className="page-head">
        <h1>Active shipments map</h1>
        <p>
          Interactive regional network of hubs, ports, live road corridors,
          nearby GPS-tracked drivers, and Google Maps place intelligence. Select
          any site, driver, or lane to inspect.
        </p>
      </div>

      <MapViewClient
        apiKey={mapsApiKey}
        initialPoints={points}
        initialLanes={lanes}
        initialActive={active}
        initialDrivers={driverPins}
      />
    </>
  );
}
