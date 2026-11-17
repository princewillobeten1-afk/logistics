import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { GoogleNetworkMap } from "@/components/google-network-map";
import { city, relative } from "@/lib/format";
import { getServerMapsApiKey } from "@/lib/maps-config";
import { listLocations, listShipments } from "@/lib/queries";

export const dynamic = "force-dynamic";

const W = 900;
const H = 520;
const PAD = 56;

type Point = { x: number; y: number };

function projector(lats: number[], lons: number[]) {
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  const latSpan = Math.max(maxLat - minLat, 1) * 1.25;
  const lonSpan = Math.max(maxLon - minLon, 1) * 1.25;
  const cLat = (minLat + maxLat) / 2;
  const cLon = (minLon + maxLon) / 2;

  const scale = Math.min((W - PAD * 2) / lonSpan, (H - PAD * 2) / latSpan);

  return (lat: number, lon: number): Point => ({
    x: W / 2 + (lon - cLon) * scale,
    y: H / 2 - (lat - cLat) * scale,
  });
}

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

  const placed = locations
    .map((l) => ({
      ...l,
      lat: Number(l.latitude),
      lon: Number(l.longitude),
    }))
    .filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lon));

  const active = shipments.filter(
    (s) => !["CLOSED", "CANCELLED", "FAILED"].includes(s.state),
  );

  if (placed.length === 0) {
    return (
      <>
        <div className="page-head">
          <h1>Active shipments map</h1>
        </div>
        <Panel title="Network" flush>
          <Empty
            message="No locations yet"
            hint="The map draws itself once your warehouses, ports and airports are configured."
          />
        </Panel>
      </>
    );
  }

  const project = projector(placed.map((l) => l.lat), placed.map((l) => l.lon));
  const points = placed.map((l) => ({ ...l, ...project(l.lat, l.lon) }));

  const byCity = new Map<string, (typeof points)[number]>();
  for (const p of points) {
    if (p.city && !byCity.has(p.city)) byCity.set(p.city, p);
  }

  const lanes = active
    .map((s) => {
      const from = byCity.get(city(s.origin));
      const to = byCity.get(city(s.destination));
      if (!from || !to || from === to) return null;
      const alert = ["EXCEPTION", "NEEDS_INFO", "AWAITING_APPROVAL"].includes(
        s.state,
      );
      return { shipment: s, from, to, alert };
    })
    .filter((l): l is NonNullable<typeof l> => l !== null);

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

      <Panel
        title="Network"
        hint={`${points.length} sites · ${lanes.length} active lane(s)`}
      >
        <GoogleNetworkMap apiKey={mapsApiKey} points={points} lanes={lanes} />
      </Panel>

      <Panel title="Active shipments" hint={`${active.length} moving`} flush>
        {active.length === 0 ? (
          <Empty
            message="Nothing active"
            hint="Submit a shipment to see it on the map."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Active shipments on map"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Status</th>
                  <th scope="col">Lane</th>
                  <th scope="col">Coordinates</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {active.map((s) => {
                  const drawn = lanes.some((l) => l.shipment.id === s.id);
                  return (
                    <tr key={s.id}>
                      <td className="ref">
                        <ShipmentLink reference={s.reference} />
                      </td>
                      <td>
                        <Pill state={s.state} />
                      </td>
                      <td className="num">
                        {city(s.origin)} → {city(s.destination)}
                      </td>
                      <td className="num text-faint">
                        {drawn ? "Mapped" : "Pending coordinates"}
                      </td>
                      <td className="num text-faint">
                        {relative(s.updated_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
