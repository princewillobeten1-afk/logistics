import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  classifyWeatherHazard,
  parseGeoJsonPolygonRings,
  type WeatherAlertItem,
  type WeatherSeverity,
  type WeatherStationReading,
} from "@/lib/map-layers";
import { getServerMapsApiKey } from "@/lib/maps-config";
import { isQuotaErrorMessage } from "@/lib/maps-grounding";

interface WeatherPointInput {
  id: string;
  name: string;
  city?: string | null;
  lat: number;
  lng: number;
}

interface GooglePublicAlertRaw {
  alertId?: string;
  alertTitle?: { text?: string };
  eventType?: string;
  areaName?: string;
  polygon?: string;
  description?: string;
  severity?: string;
  dataSource?: {
    name?: string;
    publisher?: string;
    authorityUri?: string;
  };
}

interface GoogleCurrentConditionsRaw {
  currentTime?: string;
  weatherCondition?: { description?: { text?: string } };
  temperature?: { degrees?: number };
  wind?: {
    speed?: { value?: number };
    gust?: { value?: number };
  };
  precipitation?: {
    qpf?: { quantity?: number };
  };
}

interface OpenMeteoEntry {
  current?: {
    time?: string;
    temperature_2m?: number;
    precipitation?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    wind_gusts_10m?: number;
  };
}

function normalizeSeverity(raw?: string): WeatherSeverity {
  switch (raw) {
    case "EXTREME":
    case "SEVERE":
    case "MODERATE":
      return raw;
    case "MINOR":
      return "ADVISORY";
    default:
      return "ADVISORY";
  }
}

async function fetchGoogleWeatherForPoint(
  point: WeatherPointInput,
  apiKey: string,
): Promise<{
  reading?: WeatherStationReading;
  quotaExceeded?: boolean;
  unsupported?: boolean;
}> {
  const headers = {
    "X-Goog-Maps-Solution-ID": "gmp_mcp_codeassist_v1_aistudio",
  };

  const alertsUrl = new URL("https://weather.googleapis.com/v1/publicAlerts:lookup");
  alertsUrl.searchParams.set("key", apiKey);
  alertsUrl.searchParams.set("location.latitude", String(point.lat));
  alertsUrl.searchParams.set("location.longitude", String(point.lng));
  alertsUrl.searchParams.set("languageCode", "en");

  const condUrl = new URL("https://weather.googleapis.com/v1/currentConditions:lookup");
  condUrl.searchParams.set("key", apiKey);
  condUrl.searchParams.set("location.latitude", String(point.lat));
  condUrl.searchParams.set("location.longitude", String(point.lng));

  const [alertsRes, condRes] = await Promise.all([
    fetch(alertsUrl.toString(), { headers, signal: AbortSignal.timeout(5000) }),
    fetch(condUrl.toString(), { headers, signal: AbortSignal.timeout(5000) }),
  ]);

  if (alertsRes.status === 429 || condRes.status === 429) {
    return { quotaExceeded: true };
  }

  if (
    alertsRes.status === 403 ||
    alertsRes.status === 401 ||
    alertsRes.status === 404 ||
    condRes.status === 403 ||
    condRes.status === 401 ||
    condRes.status === 404
  ) {
    return { unsupported: true };
  }

  const alertsJson = alertsRes.ok
    ? ((await alertsRes.json()) as { weatherAlerts?: GooglePublicAlertRaw[] })
    : {};
  const condJson = condRes.ok ? ((await condRes.json()) as GoogleCurrentConditionsRaw) : {};

  if (
    isQuotaErrorMessage((alertsJson as { error?: { message?: string } })?.error?.message) ||
    isQuotaErrorMessage((condJson as { error?: { message?: string } })?.error?.message)
  ) {
    return { quotaExceeded: true };
  }

  const alerts: WeatherAlertItem[] = (alertsJson.weatherAlerts ?? []).map((a, idx) => ({
    id: a.alertId ?? `${point.id}-alert-${idx}`,
    title: a.alertTitle?.text?.trim() || a.eventType || "Weather Alert",
    eventType: a.eventType ?? "WEATHER_ALERT",
    severity: normalizeSeverity(a.severity),
    areaName: a.areaName,
    description: a.description,
    polygons: parseGeoJsonPolygonRings(a.polygon),
    dataSource: {
      name: a.dataSource?.name ?? a.dataSource?.publisher ?? "National Weather Authority",
      authorityUri: a.dataSource?.authorityUri ?? "https://mapsplatform.google.com/",
    },
  }));

  const tempC = condJson.temperature?.degrees ?? null;
  const windSpeedKmh = condJson.wind?.speed?.value ?? null;
  const windGustsKmh = condJson.wind?.gust?.value ?? null;
  const precipitationMm = condJson.precipitation?.qpf?.quantity ?? null;

  const topAlertSeverity = alerts[0]?.severity;
  const localHazard = classifyWeatherHazard({
    windSpeedKmh,
    windGustsKmh,
    precipitationMm,
    temperatureC: tempC,
  });
  const severity = topAlertSeverity ?? localHazard.severity;

  return {
    reading: {
      siteId: point.id,
      siteName: point.name,
      city: point.city ?? null,
      lat: point.lat,
      lng: point.lng,
      provider: "google-weather",
      severity,
      conditionLabel:
        alerts[0]?.title ??
        condJson.weatherCondition?.description?.text ??
        localHazard.wmoLabel,
      temperatureC: tempC,
      windSpeedKmh,
      windGustsKmh,
      precipitationMm,
      observedAt: condJson.currentTime ?? null,
      advisoryReasons:
        alerts.length > 0
          ? alerts.map((a) => `${a.title}${a.areaName ? ` (${a.areaName})` : ""}`)
          : localHazard.hazardReasons,
      alerts,
      attribution: alerts[0]?.dataSource ?? {
        name: "Google Maps Weather API",
        authorityUri:
          "https://developers.google.com/maps/documentation/weather?utm_campaign=gmp_mcp_codeassist_v1_aistudio",
      },
    },
  };
}

async function fetchOpenMeteoForPoints(
  points: WeatherPointInput[],
): Promise<WeatherStationReading[]> {
  const lats = points.map((p) => p.lat.toFixed(4)).join(",");
  const lngs = points.map((p) => p.lng.toFixed(4)).join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}&current=temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m&timezone=auto`;

  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) {
    throw new Error(`Open-Meteo HTTP ${res.status}`);
  }

  const raw = (await res.json()) as OpenMeteoEntry | OpenMeteoEntry[];
  const list = Array.isArray(raw) ? raw : [raw];

  return points.map((pt, idx) => {
    const entry = list[idx]?.current;
    const tempC = typeof entry?.temperature_2m === "number" ? entry.temperature_2m : null;
    const windSpeedKmh = typeof entry?.wind_speed_10m === "number" ? entry.wind_speed_10m : null;
    const windGustsKmh = typeof entry?.wind_gusts_10m === "number" ? entry.wind_gusts_10m : null;
    const precipitationMm = typeof entry?.precipitation === "number" ? entry.precipitation : null;
    const wmoCode = typeof entry?.weather_code === "number" ? entry.weather_code : null;

    const classified = classifyWeatherHazard({
      wmoCode,
      windSpeedKmh,
      windGustsKmh,
      precipitationMm,
      temperatureC: tempC,
    });

    return {
      siteId: pt.id,
      siteName: pt.name,
      city: pt.city ?? null,
      lat: pt.lat,
      lng: pt.lng,
      provider: "open-meteo",
      severity: classified.severity,
      conditionLabel: classified.wmoLabel,
      temperatureC: tempC,
      windSpeedKmh,
      windGustsKmh,
      precipitationMm,
      observedAt: entry?.time ?? null,
      advisoryReasons: classified.hazardReasons,
      alerts: [],
      attribution: {
        name: "Open-Meteo Live Weather Telemetry",
        authorityUri: "https://open-meteo.com/",
      },
    };
  });
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  let body: { points?: WeatherPointInput[] };
  try {
    body = (await req.json()) as { points?: WeatherPointInput[] };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const points = Array.isArray(body.points)
    ? body.points
        .filter(
          (p) =>
            p &&
            typeof p.id === "string" &&
            typeof p.lat === "number" &&
            typeof p.lng === "number" &&
            Number.isFinite(p.lat) &&
            Number.isFinite(p.lng),
        )
        .slice(0, 12)
    : [];

  if (points.length === 0) {
    return NextResponse.json({ stations: [], source: "none" });
  }

  const mapsApiKey = getServerMapsApiKey();
  if (mapsApiKey) {
    try {
      const probe = await fetchGoogleWeatherForPoint(points[0], mapsApiKey);
      if (probe.quotaExceeded) {
        return NextResponse.json(
          {
            error: "Google Maps Platform Weather quota reached.",
            quotaSource: "maps",
          },
          { status: 429 },
        );
      }

      if (!probe.unsupported && probe.reading) {
        const rest = await Promise.all(
          points.slice(1).map((pt) => fetchGoogleWeatherForPoint(pt, mapsApiKey)),
        );
        const readings: WeatherStationReading[] = [probe.reading];
        for (const r of rest) {
          if (r.quotaExceeded) {
            return NextResponse.json(
              {
                error: "Google Maps Platform Weather quota reached.",
                quotaSource: "maps",
              },
              { status: 429 },
            );
          }
          if (r.reading) readings.push(r.reading);
        }
        return NextResponse.json({
          stations: readings,
          source: "google-weather",
        });
      }
    } catch {
      // Fall through cleanly to live Open-Meteo telemetry if Google Weather call fails cleanly
    }
  }

  try {
    const stations = await fetchOpenMeteoForPoints(points);
    return NextResponse.json({
      stations,
      source: "open-meteo",
    });
  } catch {
    return NextResponse.json(
      { error: "Unable to load live corridor weather data right now." },
      { status: 502 },
    );
  }
}
