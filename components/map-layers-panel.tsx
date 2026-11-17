"use client";

import {
  Anchor,
  CloudLightning,
  Loader2,
  RotateCcw,
  Route as RouteIcon,
  Sun,
  Warehouse,
} from "lucide-react";
import {
  computeWeatherSummary,
  DEFAULT_MAP_LAYERS,
  type MapLayerVisibility,
  type WeatherStationReading,
} from "@/lib/map-layers";

export function MapLayersPanel({
  layers,
  onToggle,
  onReset,
  counts,
  weatherStations,
  weatherLoading,
  weatherError,
  selectedWeatherSiteId,
  onSelectWeatherSite,
}: {
  layers: MapLayerVisibility;
  onToggle: (key: keyof MapLayerVisibility) => void;
  onReset: () => void;
  counts: {
    warehouses: number;
    gateways: number;
    routes: number;
  };
  weatherStations: WeatherStationReading[];
  weatherLoading: boolean;
  weatherError: string | null;
  selectedWeatherSiteId: string | null;
  onSelectWeatherSite: (station: WeatherStationReading) => void;
}) {
  const weatherSummary = computeWeatherSummary(weatherStations);
  const activeCount = Object.values(layers).filter(Boolean).length;
  const isDefault =
    layers.warehouses === DEFAULT_MAP_LAYERS.warehouses &&
    layers.gateways === DEFAULT_MAP_LAYERS.gateways &&
    layers.routes === DEFAULT_MAP_LAYERS.routes &&
    layers.weather === DEFAULT_MAP_LAYERS.weather;

  const primaryAttribution =
    weatherStations.find((s) => s.severity !== "CLEAR")?.attribution ??
    weatherStations[0]?.attribution;

  return (
    <section className="map-layers-panel" aria-label="Map layer controls">
      <div className="map-layers-head">
        <div className="map-layers-title">
          <strong>Map Layers</strong>
          <span className="font-mono text-xs text-faint">
            {activeCount} of 4 enabled
          </span>
        </div>
        {!isDefault ? (
          <button type="button" className="btn-ghost-sm" onClick={onReset}>
            <RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
            <span>Reset layers</span>
          </button>
        ) : null}
      </div>

      <div className="map-layers-grid" role="group" aria-label="Toggle map layer visibility">
        <button
          type="button"
          role="switch"
          aria-checked={layers.warehouses}
          className="layer-toggle"
          data-active={layers.warehouses}
          onClick={() => onToggle("warehouses")}
        >
          <span className="layer-toggle-main">
            <span className="layer-swatch layer-swatch-warehouse" aria-hidden="true" />
            <Warehouse size={14} strokeWidth={2} aria-hidden="true" />
            <span className="layer-toggle-label">Warehouse hubs</span>
          </span>
          <span className="layer-toggle-count">{counts.warehouses}</span>
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={layers.gateways}
          className="layer-toggle"
          data-active={layers.gateways}
          onClick={() => onToggle("gateways")}
        >
          <span className="layer-toggle-main">
            <span className="layer-swatch layer-swatch-gateway" aria-hidden="true" />
            <Anchor size={14} strokeWidth={2} aria-hidden="true" />
            <span className="layer-toggle-label">Ports &amp; airports</span>
          </span>
          <span className="layer-toggle-count">{counts.gateways}</span>
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={layers.routes}
          className="layer-toggle"
          data-active={layers.routes}
          onClick={() => onToggle("routes")}
        >
          <span className="layer-toggle-main">
            <span className="layer-swatch layer-swatch-route" aria-hidden="true" />
            <RouteIcon size={14} strokeWidth={2} aria-hidden="true" />
            <span className="layer-toggle-label">Active routes</span>
          </span>
          <span className="layer-toggle-count">{counts.routes}</span>
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={layers.weather}
          className="layer-toggle"
          data-active={layers.weather}
          onClick={() => onToggle("weather")}
        >
          <span className="layer-toggle-main">
            <span className="layer-swatch layer-swatch-weather" aria-hidden="true" />
            <CloudLightning size={14} strokeWidth={2} aria-hidden="true" />
            <span className="layer-toggle-label">Weather alerts</span>
          </span>
          <span className="layer-toggle-count">
            {weatherLoading
              ? "Sync"
              : layers.weather && weatherStations.length > 0
                ? weatherSummary.alertCount > 0
                  ? `${weatherSummary.alertCount} alert${weatherSummary.alertCount === 1 ? "" : "s"}`
                  : `${weatherSummary.totalStations} clear`
                : "Off"}
          </span>
        </button>
      </div>

      {layers.weather ? (
        <div className="weather-strip" aria-live="polite">
          {weatherLoading ? (
            <div className="weather-strip-status">
              <Loader2 size={13} strokeWidth={2} className="spin" aria-hidden="true" />
              <span>Fetching live meteorological conditions across network sites…</span>
            </div>
          ) : weatherError ? (
            <div className="weather-strip-status text-crit" role="alert">
              <span>{weatherError}</span>
            </div>
          ) : weatherStations.length > 0 ? (
            <>
              <div className="weather-strip-items">
                {(weatherSummary.activeAlerts.length > 0
                  ? weatherSummary.activeAlerts
                  : weatherStations.slice(0, 4)
                ).map((st) => (
                  <button
                    key={st.siteId}
                    type="button"
                    className={`weather-chip${
                      selectedWeatherSiteId === st.siteId ? " is-selected" : ""
                    }`}
                    data-severity={st.severity}
                    onClick={() => onSelectWeatherSite(st)}
                  >
                    {st.severity === "CLEAR" ? (
                      <Sun size={12} strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <CloudLightning size={12} strokeWidth={2} aria-hidden="true" />
                    )}
                    <span className="font-semibold">{st.city ?? st.siteName}</span>
                    <span className="font-mono">
                      {st.temperatureC !== null ? `${Math.round(st.temperatureC)}°C` : st.conditionLabel}
                    </span>
                    <span className="weather-chip-badge">
                      {st.severity === "CLEAR" ? "Nominal" : st.severity}
                    </span>
                  </button>
                ))}
              </div>
              {primaryAttribution ? (
                <div className="weather-attribution">
                  <span>Source:</span>
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
      ) : null}
    </section>
  );
}
