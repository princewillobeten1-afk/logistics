"use client";

import {
  AlertTriangle,
  Clock,
  CloudLightning,
  Loader2,
  RefreshCw,
  Route as RouteIcon,
  Sun,
  Truck,
  Wind,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MapsGroundingPanel } from "@/components/maps-grounding-panel";
import { dispatchQuotaExceeded } from "@/components/maps-quota-banner";
import {
  ShipmentCorridorMap,
  haversineDistanceKm,
  type CorridorPathOption,
} from "@/components/shipment-corridor-map";
import {
  computeWeatherSummary,
  type WeatherSeverity,
  type WeatherStationReading,
} from "@/lib/map-layers";
import type { LatLngPoint } from "@/lib/maps-grounding";

function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "—";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  const wholeHrs = Math.floor(hours);
  const mins = Math.round((hours - wholeHrs) * 60);
  return mins > 0 ? `${wholeHrs}h ${mins}m` : `${wholeHrs}h`;
}

function severityLabel(severity: WeatherSeverity): string {
  switch (severity) {
    case "EXTREME":
      return "Extreme";
    case "SEVERE":
      return "Severe";
    case "MODERATE":
      return "Moderate";
    case "ADVISORY":
      return "Advisory";
    default:
      return "Nominal";
  }
}

export function ShipmentCorridorSection({
  apiKey,
  origin,
  destination,
  originCity,
  destinationCity,
  originLabel,
  destinationLabel,
  alert,
  plannedDistanceKm,
  plannedTransitHours,
  plannedModes,
  plannedLegsCount,
  plannedVehicle,
  plannedCo2eKg,
  meetsDeadline,
}: {
  apiKey: string;
  origin: LatLngPoint | null;
  destination: LatLngPoint | null;
  originCity: string;
  destinationCity: string;
  originLabel: string;
  destinationLabel: string;
  alert: boolean;
  plannedDistanceKm: number | null;
  plannedTransitHours: number | null;
  plannedModes: string[];
  plannedLegsCount: number | null;
  plannedVehicle: string | null;
  plannedCo2eKg: number | null;
  meetsDeadline: boolean | null;
}) {
  const [paths, setPaths] = useState<CorridorPathOption[]>([]);
  const [selectedPathIndex, setSelectedPathIndex] = useState(0);
  const [weatherStations, setWeatherStations] = useState<WeatherStationReading[]>([]);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [weatherNonce, setWeatherNonce] = useState(0);

  const handlePathsResolved = useCallback((nextPaths: CorridorPathOption[]) => {
    setPaths(nextPaths);
    setSelectedPathIndex((prev) =>
      prev >= 0 && prev < nextPaths.length ? prev : 0,
    );
  }, []);

  const selectedPath = useMemo(() => {
    if (paths.length === 0) return null;
    return paths[selectedPathIndex] ?? paths[0];
  }, [paths, selectedPathIndex]);

  const directDistanceKm = useMemo(() => {
    if (!origin || !destination) return null;
    return Math.max(1, Math.round(haversineDistanceKm(origin, destination)));
  }, [origin, destination]);

  // Midpoint tracks the selected route polyline when available, otherwise geometric midpoint
  const selectedMidpoint = useMemo<LatLngPoint | null>(() => {
    if (selectedPath?.midpoint) return selectedPath.midpoint;
    if (origin && destination) {
      return {
        lat: (origin.lat + destination.lat) / 2,
        lng: (origin.lng + destination.lng) / 2,
      };
    }
    return null;
  }, [selectedPath, origin, destination]);

  const originLat = origin?.lat ?? null;
  const originLng = origin?.lng ?? null;
  const destLat = destination?.lat ?? null;
  const destLng = destination?.lng ?? null;
  const midLat = selectedMidpoint ? Number(selectedMidpoint.lat.toFixed(2)) : null;
  const midLng = selectedMidpoint ? Number(selectedMidpoint.lng.toFixed(2)) : null;

  useEffect(() => {
    const samplePoints: Array<{
      id: string;
      name: string;
      city: string | null;
      lat: number;
      lng: number;
    }> = [];

    if (originLat !== null && originLng !== null) {
      samplePoints.push({
        id: "corridor-origin",
        name: `Origin · ${originCity}`,
        city: originCity,
        lat: originLat,
        lng: originLng,
      });
    }
    if (
      midLat !== null &&
      midLng !== null &&
      originLat !== null &&
      destLat !== null
    ) {
      samplePoints.push({
        id: "corridor-midpoint",
        name: "Mid-Corridor",
        city: null,
        lat: midLat,
        lng: midLng,
      });
    }
    if (destLat !== null && destLng !== null) {
      samplePoints.push({
        id: "corridor-destination",
        name: `Destination · ${destinationCity}`,
        city: destinationCity,
        lat: destLat,
        lng: destLng,
      });
    }

    if (samplePoints.length === 0) {
      setWeatherStations([]);
      setWeatherError(null);
      return;
    }

    const controller = new AbortController();
    setWeatherLoading(true);
    setWeatherError(null);

    fetch("/api/maps-weather", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: samplePoints }),
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          stations?: WeatherStationReading[];
          error?: string;
          quotaSource?: "maps";
        };
        if (res.status === 429 || data.quotaSource === "maps") {
          dispatchQuotaExceeded();
        }
        if (!res.ok) {
          throw new Error(data.error || "Unable to fetch corridor weather.");
        }
        if (!controller.signal.aborted) {
          setWeatherStations(Array.isArray(data.stations) ? data.stations : []);
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setWeatherError(
          err instanceof Error ? err.message : "Unable to load weather alerts.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setWeatherLoading(false);
        }
      });

    return () => controller.abort();
  }, [
    originCity,
    destinationCity,
    originLat,
    originLng,
    midLat,
    midLng,
    destLat,
    destLng,
    weatherNonce,
  ]);

  const weatherSummary = useMemo(
    () => computeWeatherSummary(weatherStations),
    [weatherStations],
  );

  // Derived key metrics for selected path
  const distanceValue = useMemo(() => {
    if (selectedPath?.source === "routes-api" && selectedPath.distanceKm !== null) {
      return selectedPath.distanceLabel;
    }
    if (plannedDistanceKm !== null && plannedDistanceKm > 0) {
      return `${Math.round(plannedDistanceKm)} km`;
    }
    if (directDistanceKm !== null) {
      return `~${directDistanceKm} km`;
    }
    return "Pending";
  }, [selectedPath, plannedDistanceKm, directDistanceKm]);

  const distanceSubtitle = useMemo(() => {
    if (selectedPath?.source === "routes-api") {
      return selectedPath.description
        ? `Via ${selectedPath.description}`
        : "Google Routes API";
    }
    if (plannedDistanceKm !== null && plannedDistanceKm > 0) {
      return "Planned corridor";
    }
    if (directDistanceKm !== null) {
      return "Direct corridor";
    }
    return "Awaiting coordinates";
  }, [selectedPath, plannedDistanceKm, directDistanceKm]);

  const transitValue = useMemo(() => {
    if (selectedPath?.source === "routes-api" && selectedPath.durationMs !== null) {
      return selectedPath.durationLabel;
    }
    if (plannedTransitHours !== null && plannedTransitHours > 0) {
      return formatHours(plannedTransitHours);
    }
    return "Pending";
  }, [selectedPath, plannedTransitHours]);

  const transitSubtitle = useMemo(() => {
    if (
      selectedPath?.source === "routes-api" &&
      plannedTransitHours !== null &&
      plannedTransitHours > 0
    ) {
      return `Planned SLA: ${formatHours(plannedTransitHours)}`;
    }
    if (selectedPath?.source === "routes-api") {
      return "Est. drive time";
    }
    if (plannedTransitHours !== null && plannedTransitHours > 0) {
      return "Planned transit";
    }
    return "Awaiting route";
  }, [selectedPath, plannedTransitHours]);

  const weatherMetricTone: "ok" | "warn" | "crit" | "neutral" = useMemo(() => {
    if (weatherLoading && weatherStations.length === 0) return "neutral";
    if (weatherError) return "warn";
    if (
      weatherSummary.activeAlerts.some(
        (s) => s.severity === "SEVERE" || s.severity === "EXTREME",
      )
    ) {
      return "crit";
    }
    if (weatherSummary.alertCount > 0) return "warn";
    if (weatherStations.length > 0) return "ok";
    return "neutral";
  }, [weatherLoading, weatherError, weatherSummary, weatherStations]);

  const weatherHeadline = useMemo(() => {
    if (weatherLoading && weatherStations.length === 0) return "Checking…";
    if (weatherError) return "Unavailable";
    if (weatherStations.length === 0) return "Pending";
    if (weatherSummary.alertCount === 0) return "All Clear";
    return `${weatherSummary.alertCount} Active`;
  }, [weatherLoading, weatherError, weatherSummary, weatherStations]);

  const weatherSubline = useMemo(() => {
    if (weatherStations.length === 0 && !weatherLoading) {
      return "No GPS checkpoints";
    }
    if (weatherLoading && weatherStations.length === 0) {
      return "Sampling path";
    }
    if (weatherError) return "Retry weather";
    if (weatherSummary.alertCount === 0) {
      return `${weatherSummary.totalStations} checkpoints nominal`;
    }
    const highest = weatherSummary.activeAlerts[0];
    return `${severityLabel(highest.severity)} · ${highest.siteName}`;
  }, [weatherStations, weatherLoading, weatherError, weatherSummary]);

  const primaryAttribution =
    weatherStations.find((s) => s.severity !== "CLEAR")?.attribution ??
    weatherStations[0]?.attribution;

  const focusPoint = useMemo(() => {
    if (selectedMidpoint) return selectedMidpoint;
    return origin ?? destination ?? undefined;
  }, [selectedMidpoint, origin, destination]);

  return (
    <div className="corridor-stack">
      <div className="corridor-grid">
        <div className="corridor-map-col">
          <ShipmentCorridorMap
            apiKey={apiKey}
            origin={origin}
            destination={destination}
            originLabel={originLabel}
            destinationLabel={destinationLabel}
            alert={alert}
            selectedPathIndex={selectedPathIndex}
            onSelectPathIndex={setSelectedPathIndex}
            onPathsResolved={handlePathsResolved}
            weatherStations={weatherStations}
          />
        </div>

        {/* Summary Section Directly Next to the Corridor Map */}
        <aside
          className="corridor-summary-card"
          aria-label="Selected path route and weather summary"
          data-testid="corridor-route-summary"
        >
          <div className="corridor-summary-head">
            <div>
              <h3>Selected path summary</h3>
              <p className="corridor-summary-path">
                {originCity} → {destinationCity}
              </p>
            </div>

            {paths.length > 1 ? (
              <div
                className="corridor-path-tabs"
                role="tablist"
                aria-label="Select route path"
              >
                {paths.map((p) => (
                  <button
                    key={p.index}
                    type="button"
                    role="tab"
                    aria-selected={selectedPathIndex === p.index}
                    className={`corridor-path-tab${
                      selectedPathIndex === p.index ? " is-active" : ""
                    }`}
                    onClick={() => setSelectedPathIndex(p.index)}
                  >
                    {p.index === 0 ? "Primary" : `Alt ${p.index}`}
                  </button>
                ))}
              </div>
            ) : (
              <span className="corridor-source-tag">
                {selectedPath?.source === "routes-api"
                  ? "Live Road Route"
                  : plannedDistanceKm
                    ? "Planned Path"
                    : "Direct Path"}
              </span>
            )}
          </div>

          {/* Key Route Metrics Grid */}
          <div className="corridor-metrics-grid">
            <div className="corridor-metric-tile">
              <div className="corridor-metric-label">
                <RouteIcon size={13} strokeWidth={2} aria-hidden="true" />
                <span>Total distance</span>
              </div>
              <div className="corridor-metric-value font-mono">{distanceValue}</div>
              <div className="corridor-metric-sub">{distanceSubtitle}</div>
            </div>

            <div className="corridor-metric-tile">
              <div className="corridor-metric-label">
                <Clock size={13} strokeWidth={2} aria-hidden="true" />
                <span>Est. transit time</span>
              </div>
              <div className="corridor-metric-value font-mono">{transitValue}</div>
              <div className="corridor-metric-sub">{transitSubtitle}</div>
            </div>

            <div
              className="corridor-metric-tile"
              data-tone={weatherMetricTone}
            >
              <div className="corridor-metric-label">
                {weatherMetricTone === "ok" ? (
                  <Sun size={13} strokeWidth={2} aria-hidden="true" />
                ) : (
                  <CloudLightning size={13} strokeWidth={2} aria-hidden="true" />
                )}
                <span>Weather alerts</span>
              </div>
              <div className="corridor-metric-value">{weatherHeadline}</div>
              <div className="corridor-metric-sub">{weatherSubline}</div>
            </div>
          </div>

          {/* Operational Path Specs */}
          <div className="corridor-specs-bar">
            <span>
              <Truck size={13} strokeWidth={1.9} aria-hidden="true" />
              <strong>
                {plannedModes.length > 0 ? plannedModes.join(" → ") : "ROAD"}
              </strong>
            </span>
            {plannedLegsCount !== null && plannedLegsCount > 0 ? (
              <span>
                {plannedLegsCount} leg{plannedLegsCount === 1 ? "" : "s"}
              </span>
            ) : null}
            {plannedVehicle ? <span>{plannedVehicle}</span> : null}
            {plannedCo2eKg !== null && plannedCo2eKg > 0 ? (
              <span className="font-mono">{Math.round(plannedCo2eKg)} kg CO2e</span>
            ) : null}
            {meetsDeadline !== null ? (
              <span
                className={
                  meetsDeadline ? "corridor-sla-ok" : "corridor-sla-alert"
                }
              >
                {meetsDeadline ? "On deadline" : "Deadline risk"}
              </span>
            ) : null}
          </div>

          {/* Weather Alerts & Path Conditions */}
          <div className="corridor-weather-box" aria-live="polite">
            <div className="corridor-weather-head">
              <strong>
                <Wind size={14} strokeWidth={2} aria-hidden="true" />
                <span>Path weather &amp; hazard alerts</span>
              </strong>
              {origin && destination ? (
                <button
                  type="button"
                  className="btn-ghost-sm"
                  onClick={() => setWeatherNonce((n) => n + 1)}
                  disabled={weatherLoading}
                  aria-label="Refresh weather alerts for selected path"
                >
                  <RefreshCw
                    size={12}
                    strokeWidth={2}
                    className={weatherLoading ? "spin" : undefined}
                    aria-hidden="true"
                  />
                  <span>{weatherLoading ? "Checking" : "Refresh"}</span>
                </button>
              ) : null}
            </div>

            {!origin || !destination ? (
              <p className="corridor-weather-empty">
                Geocode origin and destination coordinates to monitor live weather
                alerts along this corridor.
              </p>
            ) : weatherLoading && weatherStations.length === 0 ? (
              <div className="corridor-weather-loading">
                <Loader2 size={14} strokeWidth={2} className="spin" aria-hidden="true" />
                <span>Checking live weather conditions along selected path…</span>
              </div>
            ) : weatherError ? (
              <div className="corridor-weather-error" role="alert">
                <AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
                <span>{weatherError}</span>
              </div>
            ) : weatherStations.length > 0 ? (
              <>
                {weatherSummary.activeAlerts.length > 0 ? (
                  <ul className="corridor-alert-list" role="list">
                    {weatherSummary.activeAlerts.map((st) => (
                      <li
                        key={`alert-${st.siteId}`}
                        className="corridor-alert-item"
                        data-severity={st.severity}
                      >
                        <div className="corridor-alert-top">
                          <span className="corridor-alert-site">
                            <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
                            <strong>{st.siteName}</strong>
                          </span>
                          <span className="corridor-alert-badge">
                            {severityLabel(st.severity)}
                          </span>
                        </div>
                        <div className="corridor-alert-desc">
                          {st.advisoryReasons.length > 0
                            ? st.advisoryReasons.join(" · ")
                            : st.conditionLabel}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="corridor-weather-clear">
                    <Sun size={14} strokeWidth={2} aria-hidden="true" />
                    <span>
                      No active weather alerts across Origin, Mid-Corridor, or
                      Destination.
                    </span>
                  </div>
                )}

                <div className="corridor-stations-list">
                  {weatherStations.map((st) => (
                    <div
                      key={st.siteId}
                      className="corridor-station-row"
                      data-severity={st.severity}
                    >
                      <span className="corridor-station-name">{st.siteName}</span>
                      <span className="corridor-station-cond">{st.conditionLabel}</span>
                      <span className="corridor-station-stats font-mono">
                        {st.temperatureC !== null
                          ? `${Math.round(st.temperatureC)}°C`
                          : "—"}
                        {st.windSpeedKmh !== null
                          ? ` · ${Math.round(st.windSpeedKmh)} km/h`
                          : ""}
                        {st.precipitationMm !== null && st.precipitationMm > 0
                          ? ` · ${st.precipitationMm.toFixed(1)} mm`
                          : ""}
                      </span>
                    </div>
                  ))}
                </div>

                {primaryAttribution ? (
                  <div className="corridor-weather-attrib">
                    <span>Weather source:</span>
                    <a
                      href={primaryAttribution.authorityUri}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {primaryAttribution.name}
                    </a>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </aside>
      </div>

      <MapsGroundingPanel
        title="Live Maps Corridor Briefing"
        context={{
          label: `${originCity} → ${destinationCity}`,
          lat: focusPoint?.lat,
          lng: focusPoint?.lng,
          originCity,
          destinationCity,
          modes: plannedModes.length > 0 ? plannedModes : undefined,
        }}
      />
    </div>
  );
}
