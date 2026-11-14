import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { city, relative } from "@/lib/format";
import { listLocations, listShipments } from "@/lib/queries";

export const dynamic = "force-dynamic";

const W = 900;
const H = 520;
const PAD = 56;

type Point = { x: number; y: number };

/** Equirectangular projection over the bounding box of the data.
 *  Honest for a regional view and needs no tile server, key, or network. */
function projector(lats: number[], lons: number[]) {
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);

  // Pad the box so markers never sit on the frame edge.
  const latSpan = Math.max(maxLat - minLat, 1) * 1.25;
  const lonSpan = Math.max(maxLon - minLon, 1) * 1.25;
  const cLat = (minLat + maxLat) / 2;
  const cLon = (minLon + maxLon) / 2;

  // One scale for both axes keeps the aspect ratio truthful.
  const scale = Math.min((W - PAD * 2) / lonSpan, (H - PAD * 2) / latSpan);

  return (lat: number, lon: number): Point => ({
    x: W / 2 + (lon - cLon) * scale,
    y: H / 2 - (lat - cLat) * scale,
  });
}

const MARKERS: Record<string, { r: number; className: string }> = {
  WAREHOUSE: { r: 6, className: "m-warehouse" },
  PORT: { r: 5, className: "m-gateway" },
  AIRPORT: { r: 5, className: "m-gateway" },
  RAIL_TERMINAL: { r: 5, className: "m-gateway" },
};

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
            hint="The map draws itself once your warehouses, ports and airports are set up."
          />
        </Panel>
      </>
    );
  }

  const project = projector(placed.map((l) => l.lat), placed.map((l) => l.lon));
  const points = placed.map((l) => ({ ...l, ...project(l.lat, l.lon) }));

  // Match a shipment's origin/destination city to a located site.
  const byCity = new Map<string, (typeof points)[number]>();
  for (const p of points) {
    if (p.city && !byCity.has(p.city)) byCity.set(p.city, p);
  }

  const lanes = active
    .map((s) => {
      const from = byCity.get(city(s.origin));
      const to = byCity.get(city(s.destination));
      if (!from || !to || from === to) return null;
      return { shipment: s, from, to };
    })
    .filter((l): l is NonNullable<typeof l> => l !== null);

  return (
    <>
      <div className="page-head">
        <h1>Active shipments map</h1>
        <p>
          Your network and every shipment currently moving through it. Sites
          are plotted from their recorded coordinates; vehicle positions update
          as carriers report them.
        </p>
      </div>

      <Panel
        title="Network"
        hint={`${points.length} sites · ${lanes.length} active lane(s)`}
      >
        <div className="mapwrap">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="map"
            role="img"
            aria-label="Map of the logistics network"
          >
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="lane-head" />
              </marker>
            </defs>

            {/* Graticule: a faint sense of scale without pretending to be a basemap. */}
            <g className="grid">
              {Array.from({ length: 7 }, (_, i) => (
                <line key={`v${i}`} x1={(W / 6) * i} y1="0" x2={(W / 6) * i} y2={H} />
              ))}
              {Array.from({ length: 5 }, (_, i) => (
                <line key={`h${i}`} x1="0" y1={(H / 4) * i} x2={W} y2={(H / 4) * i} />
              ))}
            </g>

            {/* Lanes drawn as arcs so overlapping routes stay distinguishable. */}
            {lanes.map(({ shipment, from, to }, i) => {
              const mx = (from.x + to.x) / 2;
              const my = (from.y + to.y) / 2;
              const dx = to.x - from.x;
              const dy = to.y - from.y;
              const len = Math.hypot(dx, dy) || 1;
              const lift = Math.min(70, len * 0.22);
              const cx = mx + (-dy / len) * lift;
              const cy = my + (dx / len) * lift;
              const alert = ["EXCEPTION", "NEEDS_INFO", "AWAITING_APPROVAL"].includes(
                shipment.state,
              );
              return (
                <path
                  key={`${shipment.id}-${i}`}
                  d={`M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`}
                  className={alert ? "lane lane-alert" : "lane"}
                  markerEnd="url(#arrow)"
                />
              );
            })}

            {points.map((p) => {
              const marker = MARKERS[p.type] ?? { r: 4, className: "m-other" };
              return (
                <g key={p.id} className={`marker ${marker.className}`}>
                  <circle className="halo" cx={p.x} cy={p.y} r={marker.r + 5} />
                  <circle className="core" cx={p.x} cy={p.y} r={marker.r} />
                  <text x={p.x} y={p.y - marker.r - 7} textAnchor="middle">
                    {p.code ?? p.name}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        <div className="legend">
          <span><i className="dot m-warehouse" /> warehouse</span>
          <span><i className="dot m-gateway" /> port / airport</span>
          <span><i className="line" /> active lane</span>
          <span><i className="line alert" /> needs attention</span>
        </div>
      </Panel>

      <Panel title="Active shipments" hint={`${active.length} moving`} flush>
        {active.length === 0 ? (
          <Empty message="Nothing active" hint="Submit a shipment to see it on the map." />
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Active shipments on map">
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">State</th>
                  <th scope="col">Lane</th>
                  <th scope="col">On map</th>
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
                      <td><Pill state={s.state} /></td>
                      <td className="num">
                        {city(s.origin)} → {city(s.destination)}
                      </td>
                      <td className="num text-faint">
                        {drawn ? "yes" : "no coordinates"}
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
