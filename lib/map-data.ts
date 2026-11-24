import type { GoogleMapLane, GoogleMapPoint } from "@/components/google-network-map";
import type { MapShipmentItem } from "@/components/network-map";
import { city } from "@/lib/format";

export type LocationRecord = {
  id: string;
  type: string;
  name: string;
  code: string | null;
  city: string | null;
  country: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
};

export type ShipmentRecord = {
  id: string;
  reference: string;
  state: string;
  customer_ref: string | null;
  origin: Record<string, unknown>;
  destination: Record<string, unknown>;
  cargo: Record<string, unknown>;
  updated_at: Date | string;
};

const W = 900;
const H = 520;
const PAD = 56;
const INACTIVE_STATES = new Set(["CLOSED", "CANCELLED", "FAILED"]);
const ALERT_STATES = new Set(["EXCEPTION", "NEEDS_INFO", "AWAITING_APPROVAL"]);

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

  return (lat: number, lon: number): { x: number; y: number } => ({
    x: W / 2 + (lon - cLon) * scale,
    y: H / 2 - (lat - cLat) * scale,
  });
}

function serializeShipment(s: ShipmentRecord): MapShipmentItem {
  return {
    id: s.id,
    reference: s.reference,
    state: s.state,
    customer_ref: s.customer_ref,
    origin: s.origin,
    destination: s.destination,
    cargo: s.cargo,
    updated_at:
      s.updated_at instanceof Date
        ? s.updated_at.toISOString()
        : String(s.updated_at),
  };
}

export function buildMapNetworkData(
  locations: LocationRecord[],
  shipments: ShipmentRecord[],
): {
  points: GoogleMapPoint[];
  lanes: GoogleMapLane[];
  active: MapShipmentItem[];
} {
  const placed = locations
    .filter(
      (l) =>
        l.latitude !== null &&
        l.longitude !== null &&
        String(l.latitude).trim() !== "" &&
        String(l.longitude).trim() !== "",
    )
    .map((l) => ({
      ...l,
      lat: Number(l.latitude),
      lon: Number(l.longitude),
    }))
    .filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lon));

  const active = shipments
    .filter((s) => !INACTIVE_STATES.has(s.state))
    .map(serializeShipment);

  if (placed.length === 0) {
    return { points: [], lanes: [], active };
  }

  const project = projector(
    placed.map((l) => l.lat),
    placed.map((l) => l.lon),
  );
  const points: GoogleMapPoint[] = placed.map((l) => ({
    id: l.id,
    type: l.type,
    name: l.name,
    code: l.code,
    city: l.city,
    country: l.country,
    lat: l.lat,
    lon: l.lon,
    ...project(l.lat, l.lon),
  }));

  const byCity = new Map<string, GoogleMapPoint>();
  for (const p of points) {
    if (p.city && !byCity.has(p.city)) byCity.set(p.city, p);
  }

  const lanes: GoogleMapLane[] = active
    .map((shipment) => {
      const from = byCity.get(city(shipment.origin));
      const to = byCity.get(city(shipment.destination));
      if (!from || !to || from === to) return null;
      return {
        shipment,
        from,
        to,
        alert: ALERT_STATES.has(shipment.state),
      };
    })
    .filter((lane): lane is GoogleMapLane => lane !== null);

  return { points, lanes, active };
}
