import type { LatLngPoint } from "@/lib/maps-grounding";

export type WeatherSeverity = "EXTREME" | "SEVERE" | "MODERATE" | "ADVISORY" | "CLEAR";

export interface MapLayerVisibility {
  warehouses: boolean;
  gateways: boolean;
  routes: boolean;
  weather: boolean;
}

export const DEFAULT_MAP_LAYERS: MapLayerVisibility = {
  warehouses: true,
  gateways: true,
  routes: true,
  weather: true,
};

export interface WeatherAlertItem {
  id: string;
  title: string;
  eventType: string;
  severity: WeatherSeverity;
  areaName?: string;
  description?: string;
  polygons: LatLngPoint[][];
  dataSource: {
    name: string;
    authorityUri: string;
  };
}

export interface WeatherStationReading {
  siteId: string;
  siteName: string;
  city: string | null;
  lat: number;
  lng: number;
  provider: "google-weather" | "open-meteo";
  severity: WeatherSeverity;
  conditionLabel: string;
  temperatureC: number | null;
  windSpeedKmh: number | null;
  windGustsKmh: number | null;
  precipitationMm: number | null;
  observedAt: string | null;
  advisoryReasons: string[];
  alerts: WeatherAlertItem[];
  attribution: {
    name: string;
    authorityUri: string;
  };
}

export interface LayerSiteLike {
  id: string;
  type: string;
}

export function filterPointsByLayers<T extends LayerSiteLike>(
  points: T[],
  layers: MapLayerVisibility,
): T[] {
  return points.filter((p) => {
    if (p.type === "WAREHOUSE") return layers.warehouses;
    return layers.gateways;
  });
}

export function isSiteTypeWarehouse(type: string): boolean {
  return type === "WAREHOUSE";
}

export function parseGeoJsonPolygonRings(geojsonStr?: string | null): LatLngPoint[][] {
  if (!geojsonStr || typeof geojsonStr !== "string") return [];
  try {
    const parsed = JSON.parse(geojsonStr) as {
      type?: string;
      coordinates?: unknown;
    };
    if (!parsed || !Array.isArray(parsed.coordinates)) return [];

    const ringToLatLng = (ring: unknown): LatLngPoint[] => {
      if (!Array.isArray(ring)) return [];
      const out: LatLngPoint[] = [];
      for (const coord of ring) {
        if (Array.isArray(coord) && coord.length >= 2) {
          const lng = Number(coord[0]);
          const lat = Number(coord[1]);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            out.push({ lat, lng });
          }
        }
      }
      return out.length >= 3 ? out : [];
    };

    if (parsed.type === "Polygon") {
      return parsed.coordinates
        .map(ringToLatLng)
        .filter((r) => r.length >= 3);
    }

    if (parsed.type === "MultiPolygon") {
      const rings: LatLngPoint[][] = [];
      for (const poly of parsed.coordinates) {
        if (Array.isArray(poly)) {
          for (const ring of poly) {
            const pts = ringToLatLng(ring);
            if (pts.length >= 3) rings.push(pts);
          }
        }
      }
      return rings;
    }

    return [];
  } catch {
    return [];
  }
}

export function describeWmoWeatherCode(code?: number | null): string {
  if (typeof code !== "number" || !Number.isFinite(code)) return "Clear / Nominal";
  if (code === 0) return "Clear sky";
  if (code === 1 || code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog / visibility reduced";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 65) return code === 65 ? "Heavy rain" : "Rain";
  if (code >= 66 && code <= 67) return "Freezing rain";
  if (code >= 71 && code <= 77) return "Snow / ice";
  if (code >= 80 && code <= 82) return code === 82 ? "Violent rain showers" : "Rain showers";
  if (code >= 95 && code <= 99) return "Thunderstorm";
  return `Weather code ${code}`;
}

export function classifyWeatherHazard(input: {
  wmoCode?: number | null;
  windSpeedKmh?: number | null;
  windGustsKmh?: number | null;
  precipitationMm?: number | null;
  temperatureC?: number | null;
}): {
  severity: WeatherSeverity;
  wmoLabel: string;
  hazardReasons: string[];
} {
  const code = typeof input.wmoCode === "number" ? input.wmoCode : 0;
  const wind = typeof input.windSpeedKmh === "number" ? input.windSpeedKmh : 0;
  const gusts = typeof input.windGustsKmh === "number" ? input.windGustsKmh : 0;
  const precip = typeof input.precipitationMm === "number" ? input.precipitationMm : 0;
  const temp = typeof input.temperatureC === "number" ? input.temperatureC : null;

  const wmoLabel = describeWmoWeatherCode(code);
  const reasons: string[] = [];
  let severity: WeatherSeverity = "CLEAR";

  const upgrade = (next: WeatherSeverity) => {
    const rank: Record<WeatherSeverity, number> = {
      CLEAR: 0,
      ADVISORY: 1,
      MODERATE: 2,
      SEVERE: 3,
      EXTREME: 4,
    };
    if (rank[next] > rank[severity]) severity = next;
  };

  if (code >= 95) {
    upgrade("SEVERE");
    reasons.push("Active thunderstorm activity near corridor");
  } else if (code === 65 || code === 82 || precip >= 10) {
    upgrade("SEVERE");
    reasons.push(`Heavy precipitation (${precip.toFixed(1)} mm)`);
  } else if (code === 45 || code === 48) {
    upgrade("MODERATE");
    reasons.push("Reduced visibility due to fog");
  } else if ((code >= 61 && code <= 64) || (code >= 80 && code <= 81) || precip >= 2) {
    upgrade("MODERATE");
    reasons.push(`Wet road / rainfall (${precip.toFixed(1)} mm)`);
  }

  if (gusts >= 55 || wind >= 42) {
    upgrade("SEVERE");
    reasons.push(`High cargo wind gusts (${Math.round(Math.max(gusts, wind))} km/h)`);
  } else if (gusts >= 38 || wind >= 28) {
    upgrade("ADVISORY");
    reasons.push(`Elevated crosswinds (${Math.round(Math.max(gusts, wind))} km/h gusts)`);
  }

  if (temp !== null && temp >= 38) {
    upgrade("ADVISORY");
    reasons.push(`High ambient heat (${temp.toFixed(1)}°C — cold-chain watch)`);
  }

  return { severity, wmoLabel, hazardReasons: reasons };
}

export function computeWeatherSummary(stations: WeatherStationReading[]): {
  totalStations: number;
  alertCount: number;
  activeAlerts: WeatherStationReading[];
} {
  const activeAlerts = stations.filter((s) => s.severity !== "CLEAR");
  return {
    totalStations: stations.length,
    alertCount: activeAlerts.length,
    activeAlerts,
  };
}
