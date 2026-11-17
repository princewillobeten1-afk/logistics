"use client";

import {
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  Pin,
  useAdvancedMarkerRef,
  useMap,
  useMapsLibrary,
} from "@vis.gl/react-google-maps";
import { ArrowRight, Layers, MapPin, Navigation, Route as RouteIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapsGroundingPanel, type MapsGroundingContext } from "@/components/maps-grounding-panel";
import { MapLayersPanel } from "@/components/map-layers-panel";
import { dispatchQuotaExceeded } from "@/components/maps-quota-banner";
import { NetworkMap, type MapLane, type MapSitePoint } from "@/components/network-map";
import { city, relative, toneFor } from "@/lib/format";
import {
  DEFAULT_MAP_LAYERS,
  filterPointsByLayers,
  isSiteTypeWarehouse,
  type MapLayerVisibility,
  type WeatherStationReading,
} from "@/lib/map-layers";
import { isQuotaErrorMessage } from "@/lib/maps-grounding";
import { formatStateLabel } from "@/lib/view-helpers";

export type GoogleMapPoint = MapSitePoint & {
  lat: number;
  lon: number;
};

export type GoogleMapLane = {
  shipment: MapLane["shipment"];
  from: GoogleMapPoint;
  to: GoogleMapPoint;
  alert: boolean;
};

type LaneFilter = "ALL" | "ALERT" | "MOVING";

interface RouteMetrics {
  distanceKm: string;
  durationLabel: string;
  fallbackGeodesic: boolean;
}

function formatDurationMs(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function SitePinMarker({
  point,
  isSelected,
  hasAlertLane,
  laneCount,
  onSelect,
  onClear,
}: {
  point: GoogleMapPoint;
  isSelected: boolean;
  hasAlertLane: boolean;
  laneCount: number;
  onSelect: () => void;
  onClear: () => void;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();
  const isWarehouse = point.type === "WAREHOUSE";

  const background = isSelected
    ? "#111827"
    : hasAlertLane
      ? "#dc2626"
      : isWarehouse
        ? "#0f766e"
        : "#2563eb";
  const borderColor = isSelected
    ? "#0f766e"
    : hasAlertLane
      ? "#991b1b"
      : isWarehouse
        ? "#115e59"
        : "#1d4ed8";

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: point.lat, lng: point.lon }}
        title={`${point.name} (${point.code ?? point.type})`}
        onClick={() => (isSelected ? onClear() : onSelect())}
      >
        <Pin
          background={background}
          borderColor={borderColor}
          glyphColor="#ffffff"
          glyph={point.code ? point.code.slice(0, 3) : point.type.slice(0, 1)}
          scale={isSelected ? 1.25 : 1.0}
        />
      </AdvancedMarker>
      {isSelected && marker ? (
        <InfoWindow anchor={marker} onCloseClick={onClear} maxWidth={260}>
          <div className="gmap-infowindow">
            <strong>{point.name}</strong>
            <div className="gmap-infowindow-meta">
              {point.code ?? formatStateLabel(point.type)} ·{" "}
              {[point.city, point.country].filter(Boolean).join(", ")}
            </div>
            <div className="gmap-infowindow-lanes">
              {laneCount} active lane{laneCount === 1 ? "" : "s"} connected
            </div>
          </div>
        </InfoWindow>
      ) : null}
    </>
  );
}

function WeatherAlertPolygons({
  stations,
}: {
  stations: WeatherStationReading[];
}) {
  const map = useMap();
  const polysRef = useRef<google.maps.Polygon[]>([]);

  useEffect(() => {
    polysRef.current.forEach((p) => p.setMap(null));
    polysRef.current = [];
    if (!map) return;

    for (const station of stations) {
      for (const alert of station.alerts) {
        if (alert.polygons.length === 0) continue;
        const fillColor =
          alert.severity === "EXTREME" || alert.severity === "SEVERE"
            ? "#dc2626"
            : "#d97706";
        const poly = new google.maps.Polygon({
          paths: alert.polygons,
          strokeColor: fillColor,
          strokeOpacity: 0.85,
          strokeWeight: 2,
          fillColor,
          fillOpacity: 0.18,
          map,
        });
        polysRef.current.push(poly);
      }
    }

    return () => {
      polysRef.current.forEach((p) => p.setMap(null));
      polysRef.current = [];
    };
  }, [map, stations]);

  return null;
}

function WeatherStationPin({
  station,
  offsetPin,
  isSelected,
  onSelect,
  onClear,
}: {
  station: WeatherStationReading;
  offsetPin: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onClear: () => void;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();
  const isAlert = station.severity !== "CLEAR";
  const background =
    station.severity === "SEVERE" || station.severity === "EXTREME"
      ? "#b91c1c"
      : station.severity === "MODERATE" || station.severity === "ADVISORY"
        ? "#d97706"
        : "#0284c7";
  const borderColor =
    station.severity === "SEVERE" || station.severity === "EXTREME"
      ? "#7f1d1d"
      : station.severity === "MODERATE" || station.severity === "ADVISORY"
        ? "#92400e"
        : "#0369a1";

  const pos = offsetPin
    ? { lat: station.lat + 0.28, lng: station.lng + 0.30 }
    : { lat: station.lat, lng: station.lng };

  const glyphText = isAlert
    ? "!"
    : station.temperatureC !== null
      ? `${Math.round(station.temperatureC)}°`
      : "WX";

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={pos}
        zIndex={isSelected ? 40 : 20}
        title={`Weather at ${station.siteName}: ${station.conditionLabel}`}
        onClick={() => (isSelected ? onClear() : onSelect())}
      >
        <Pin
          background={background}
          borderColor={borderColor}
          glyphColor="#ffffff"
          glyph={glyphText}
          scale={isSelected ? 1.15 : 0.88}
        />
      </AdvancedMarker>
      {isSelected && marker ? (
        <InfoWindow anchor={marker} onCloseClick={onClear} maxWidth={280}>
          <div className="gmap-infowindow">
            <strong>
              {station.city ?? station.siteName} ·{" "}
              {station.severity === "CLEAR" ? "Nominal Weather" : `${station.severity} Alert`}
            </strong>
            <div className="gmap-infowindow-meta">
              {station.conditionLabel}
              {station.temperatureC !== null ? ` · ${station.temperatureC.toFixed(1)}°C` : ""}
              {station.windSpeedKmh !== null ? ` · Wind ${Math.round(station.windSpeedKmh)} km/h` : ""}
              {station.windGustsKmh !== null ? ` (gusts ${Math.round(station.windGustsKmh)})` : ""}
              {station.precipitationMm !== null && station.precipitationMm > 0
                ? ` · Rain ${station.precipitationMm.toFixed(1)} mm`
                : ""}
            </div>
            {station.advisoryReasons.length > 0 ? (
              <div className="gmap-infowindow-lanes" style={{ color: "#9a3412" }}>
                {station.advisoryReasons.join(" · ")}
              </div>
            ) : null}
            <div className="gmap-infowindow-meta" style={{ marginTop: "0.375rem" }}>
              Source:{" "}
              <a
                href={station.attribution.authorityUri}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "underline", color: "#0f766e" }}
              >
                {station.attribution.name}
              </a>
            </div>
          </div>
        </InfoWindow>
      ) : null}
    </>
  );
}

function MapFocusController({
  target,
}: {
  target: { lat: number; lng: number } | null;
}) {
  const map = useMap();

  useEffect(() => {
    if (!map || !target) return;
    map.panTo(target);
  }, [map, target]);

  return null;
}

function NetworkRoutesLayer({
  showRoutes,
  visibleLanes,
  selectedLane,
  onSelectLane,
  onMetrics,
}: {
  showRoutes: boolean;
  visibleLanes: GoogleMapLane[];
  selectedLane: GoogleMapLane | null;
  onSelectLane: (reference: string) => void;
  onMetrics: (metrics: RouteMetrics | null) => void;
}) {
  const map = useMap();
  const routesLib = useMapsLibrary("routes");
  const bgLinesRef = useRef<google.maps.Polyline[]>([]);
  const activeLinesRef = useRef<google.maps.Polyline[]>([]);
  const lastFittedRef = useRef<string | null>(null);

  // Background overview polylines for all visible lanes
  useEffect(() => {
    bgLinesRef.current.forEach((p) => p.setMap(null));
    bgLinesRef.current = [];
    if (!map || !showRoutes) return;

    for (const lane of visibleLanes) {
      if (selectedLane && lane.shipment.reference === selectedLane.shipment.reference) {
        continue;
      }
      const line = new google.maps.Polyline({
        path: [
          { lat: lane.from.lat, lng: lane.from.lon },
          { lat: lane.to.lat, lng: lane.to.lon },
        ],
        geodesic: true,
        strokeColor: lane.alert ? "#dc2626" : "#0f766e",
        strokeOpacity: 0.35,
        strokeWeight: 2,
        map,
      });
      line.addListener("click", () => {
        onSelectLane(lane.shipment.reference);
      });
      bgLinesRef.current.push(line);
    }

    return () => {
      bgLinesRef.current.forEach((p) => p.setMap(null));
      bgLinesRef.current = [];
    };
  }, [map, showRoutes, visibleLanes, selectedLane, onSelectLane]);

  // Selected lane computed with Routes API (Route.computeRoutes)
  useEffect(() => {
    activeLinesRef.current.forEach((p) => p.setMap(null));
    activeLinesRef.current = [];
    if (!map || !showRoutes || !selectedLane) {
      onMetrics(null);
      return;
    }

    let cancelled = false;
    const origin = { lat: selectedLane.from.lat, lng: selectedLane.from.lon };
    const destination = { lat: selectedLane.to.lat, lng: selectedLane.to.lon };
    const strokeColor = selectedLane.alert ? "#dc2626" : "#0f766e";

    const drawGeodesicFallback = () => {
      if (cancelled) return;
      const line = new google.maps.Polyline({
        path: [origin, destination],
        geodesic: true,
        strokeColor,
        strokeOpacity: 0.9,
        strokeWeight: 4,
        map,
      });
      activeLinesRef.current = [line];

      if (lastFittedRef.current !== selectedLane.shipment.reference) {
        lastFittedRef.current = selectedLane.shipment.reference;
        const bounds = new google.maps.LatLngBounds();
        bounds.extend(origin);
        bounds.extend(destination);
        map.fitBounds(bounds, 56);
      }
      onMetrics({
        distanceKm: "Direct corridor",
        durationLabel: "Multimodal",
        fallbackGeodesic: true,
      });
    };

    if (!routesLib || !routesLib.Route) {
      drawGeodesicFallback();
      return () => {
        cancelled = true;
        activeLinesRef.current.forEach((p) => p.setMap(null));
        activeLinesRef.current = [];
      };
    }

    const request = {
      origin,
      destination,
      travelMode: "DRIVING",
      fields: ["path", "distanceMeters", "durationMillis", "viewport", "legs"],
    };

    // Use modern Maps JS SDK Route.computeRoutes wrapper (bypasses browser CORS)
    (routesLib.Route as unknown as {
      computeRoutes: (req: typeof request) => Promise<{
        routes?: Array<{
          distanceMeters?: number;
          durationMillis?: number;
          viewport?: google.maps.LatLngBounds | google.maps.LatLngBoundsLiteral;
          createPolylines?: () => google.maps.Polyline[];
        }>;
      }>;
    })
      .computeRoutes(request)
      .then(({ routes }) => {
        if (cancelled) return;
        const primaryRoute = routes?.[0];
        if (!primaryRoute) {
          drawGeodesicFallback();
          return;
        }

        const polylines =
          typeof primaryRoute.createPolylines === "function"
            ? primaryRoute.createPolylines()
            : [];

        if (polylines.length > 0) {
          polylines.forEach((pl) => {
            pl.setOptions({
              strokeColor,
              strokeOpacity: 0.92,
              strokeWeight: 5,
            });
            pl.setMap(map);
          });
          activeLinesRef.current = polylines;
        } else {
          drawGeodesicFallback();
          return;
        }

        if (primaryRoute.viewport && lastFittedRef.current !== selectedLane.shipment.reference) {
          lastFittedRef.current = selectedLane.shipment.reference;
          map.fitBounds(primaryRoute.viewport, 56);
        }

        const distKm =
          typeof primaryRoute.distanceMeters === "number"
            ? `${(primaryRoute.distanceMeters / 1000).toFixed(0)} km`
            : "—";
        const durLabel =
          typeof primaryRoute.durationMillis === "number"
            ? formatDurationMs(primaryRoute.durationMillis)
            : "—";

        onMetrics({
          distanceKm: distKm,
          durationLabel: durLabel,
          fallbackGeodesic: false,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err ?? "");
        if (isQuotaErrorMessage(msg)) {
          dispatchQuotaExceeded();
        }
        drawGeodesicFallback();
      });

    return () => {
      cancelled = true;
      activeLinesRef.current.forEach((p) => p.setMap(null));
      activeLinesRef.current = [];
    };
  }, [map, routesLib, showRoutes, selectedLane, onMetrics]);

  return null;
}

export function GoogleNetworkMap({
  apiKey,
  points,
  lanes,
}: {
  apiKey: string;
  points: GoogleMapPoint[];
  lanes: GoogleMapLane[];
}) {
  const [viewMode, setViewMode] = useState<"google" | "schematic">(
    apiKey ? "google" : "schematic",
  );
  const [layers, setLayers] = useState<MapLayerVisibility>(DEFAULT_MAP_LAYERS);
  const [filter, setFilter] = useState<LaneFilter>("ALL");
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [selectedWeatherSiteId, setSelectedWeatherSiteId] = useState<string | null>(null);
  const [weatherStations, setWeatherStations] = useState<WeatherStationReading[]>([]);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const weatherFetchedRef = useRef(false);
  const [selectedRef, setSelectedRef] = useState<string | null>(
    () =>
      lanes.find((l) => l.alert)?.shipment.reference ??
      lanes[0]?.shipment.reference ??
      null,
  );
  const [routeMetrics, setRouteMetrics] = useState<RouteMetrics | null>(null);

  const layerCounts = useMemo(
    () => ({
      warehouses: points.filter((p) => isSiteTypeWarehouse(p.type)).length,
      gateways: points.filter((p) => !isSiteTypeWarehouse(p.type)).length,
      routes: lanes.length,
    }),
    [points, lanes],
  );

  const visiblePoints = useMemo(
    () => filterPointsByLayers(points, layers),
    [points, layers],
  );

  const visibleLanes = useMemo(() => {
    if (filter === "ALERT") return lanes.filter((l) => l.alert);
    if (filter === "MOVING") return lanes.filter((l) => !l.alert);
    return lanes;
  }, [lanes, filter]);

  const selectedSite = useMemo(
    () => visiblePoints.find((p) => p.id === selectedSiteId) ?? null,
    [visiblePoints, selectedSiteId],
  );

  useEffect(() => {
    if (!layers.weather) {
      setSelectedWeatherSiteId(null);
      return;
    }
    if (weatherFetchedRef.current || points.length === 0) return;

    const controller = new AbortController();
    weatherFetchedRef.current = true;
    setWeatherLoading(true);
    setWeatherError(null);

    fetch("/api/maps-weather", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: points.map((p) => ({
          id: p.id,
          name: p.name,
          city: p.city,
          lat: p.lat,
          lng: p.lon,
        })),
      }),
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
          throw new Error(data.error || "Unable to load live weather conditions.");
        }
        if (!controller.signal.aborted) {
          setWeatherStations(Array.isArray(data.stations) ? data.stations : []);
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        weatherFetchedRef.current = false;
        setWeatherError(
          err instanceof Error ? err.message : "Unable to load weather alerts.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setWeatherLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [layers.weather, points]);

  const handleToggleLayer = useCallback((key: keyof MapLayerVisibility) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleResetLayers = useCallback(() => {
    setLayers(DEFAULT_MAP_LAYERS);
  }, []);

  const handleSelectWeatherSite = useCallback((station: WeatherStationReading) => {
    setSelectedSiteId(null);
    setSelectedWeatherSiteId((prev) =>
      prev === station.siteId ? null : station.siteId,
    );
  }, []);

  const selectedLane = useMemo(
    () =>
      visibleLanes.find((l) => l.shipment.reference === selectedRef) ??
      visibleLanes[0] ??
      null,
    [visibleLanes, selectedRef],
  );

  const siteLanes = useMemo(() => {
    if (!selectedSite) return [];
    return visibleLanes.filter(
      (l) => l.from.id === selectedSite.id || l.to.id === selectedSite.id,
    );
  }, [selectedSite, visibleLanes]);

  const mapCenter = useMemo(() => {
    if (points.length === 0) return { lat: 6.5244, lng: 3.3792 };
    const avgLat = points.reduce((acc, p) => acc + p.lat, 0) / points.length;
    const avgLng = points.reduce((acc, p) => acc + p.lon, 0) / points.length;
    return { lat: avgLat, lng: avgLng };
  }, [points]);

  const weatherFocusTarget = useMemo(() => {
    if (!layers.weather || !selectedWeatherSiteId) return null;
    const st = weatherStations.find((w) => w.siteId === selectedWeatherSiteId);
    if (!st) return null;
    const hasMatchingPin = visiblePoints.some((vp) => vp.id === st.siteId);
    return {
      lat: st.lat + (hasMatchingPin ? 0.28 : 0),
      lng: st.lng + (hasMatchingPin ? 0.30 : 0),
    };
  }, [layers.weather, selectedWeatherSiteId, weatherStations, visiblePoints]);

  const groundingContext = useMemo<MapsGroundingContext>(() => {
    if (selectedSite) {
      return {
        label: `${selectedSite.name} (${selectedSite.city ?? selectedSite.code ?? "Hub"})`,
        lat: selectedSite.lat,
        lng: selectedSite.lon,
        hubName: selectedSite.name,
      };
    }
    if (selectedLane) {
      const midLat = (selectedLane.from.lat + selectedLane.to.lat) / 2;
      const midLng = (selectedLane.from.lon + selectedLane.to.lon) / 2;
      return {
        label: `${selectedLane.shipment.reference}: ${city(selectedLane.shipment.origin)} → ${city(selectedLane.shipment.destination)}`,
        lat: midLat,
        lng: midLng,
        originCity: city(selectedLane.shipment.origin),
        destinationCity: city(selectedLane.shipment.destination),
      };
    }
    return {
      label: points[0]?.name ?? "West Africa Freight Network",
      lat: mapCenter.lat,
      lng: mapCenter.lng,
      hubName: points[0]?.city ?? "Lagos",
    };
  }, [selectedSite, selectedLane, points, mapCenter]);

  const handleSelectLane = useCallback((reference: string) => {
    setSelectedSiteId(null);
    setSelectedRef(reference);
  }, []);

  const handleMetrics = useCallback((metrics: RouteMetrics | null) => {
    setRouteMetrics(metrics);
  }, []);

  if (viewMode === "schematic") {
    return (
      <div className="stack-md">
        <div className="map-mode-bar">
          {apiKey ? (
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={() => setViewMode("google")}
            >
              <Layers size={14} strokeWidth={2} aria-hidden="true" />
              <span>Switch to Google Maps view</span>
            </button>
          ) : (
            <span className="text-xs text-faint">
              Schematic topology view active (configure Google Maps API key for live map tiles & routing)
            </span>
          )}
        </div>
        <MapLayersPanel
          layers={layers}
          onToggle={handleToggleLayer}
          onReset={handleResetLayers}
          counts={layerCounts}
          weatherStations={weatherStations}
          weatherLoading={weatherLoading}
          weatherError={weatherError}
          selectedWeatherSiteId={selectedWeatherSiteId}
          onSelectWeatherSite={handleSelectWeatherSite}
        />
        <NetworkMap points={points} lanes={lanes} layers={layers} />
        <MapsGroundingPanel context={groundingContext} />
      </div>
    );
  }

  return (
    <div className="stack-md">
      <div className="map-controls-bar">
        <div className="filters" role="group" aria-label="Filter network lanes" style={{ marginBottom: 0 }}>
          <button
            type="button"
            data-active={filter === "ALL"}
            onClick={() => setFilter("ALL")}
          >
            <span>All active lanes</span>
            <span className="filter-count">{lanes.length}</span>
          </button>
          <button
            type="button"
            data-active={filter === "ALERT"}
            onClick={() => setFilter("ALERT")}
          >
            <span>Needs attention</span>
            <span className="filter-count">
              {lanes.filter((l) => l.alert).length}
            </span>
          </button>
          <button
            type="button"
            data-active={filter === "MOVING"}
            onClick={() => setFilter("MOVING")}
          >
            <span>Moving normally</span>
            <span className="filter-count">
              {lanes.filter((l) => !l.alert).length}
            </span>
          </button>
        </div>

        <button
          type="button"
          className="btn-ghost-sm"
          onClick={() => setViewMode("schematic")}
        >
          <Layers size={14} strokeWidth={2} aria-hidden="true" />
          <span>Schematic SVG</span>
        </button>
      </div>

      <MapLayersPanel
        layers={layers}
        onToggle={handleToggleLayer}
        onReset={handleResetLayers}
        counts={layerCounts}
        weatherStations={weatherStations}
        weatherLoading={weatherLoading}
        weatherError={weatherError}
        selectedWeatherSiteId={selectedWeatherSiteId}
        onSelectWeatherSite={handleSelectWeatherSite}
      />

      <div
        className="map-stage"
        data-layers={`w:${layers.warehouses ? 1 : 0},g:${layers.gateways ? 1 : 0},r:${layers.routes ? 1 : 0},wx:${layers.weather ? 1 : 0}`}
      >
        <div className="map-canvas-col">
          <div className="gmap-shell" data-testid="google-map-shell">
            <APIProvider
              apiKey={apiKey}
              language="en"
              region="NG"
              libraries={["marker", "routes"]}
            >
              <GoogleMap
                mapId="DEMO_MAP_ID"
                internalUsageAttributionIds={["gmp_mcp_codeassist_v1_aistudio"]}
                defaultCenter={mapCenter}
                defaultZoom={6}
                gestureHandling="greedy"
                style={{ width: "100%", height: "100%" }}
              >
                {visiblePoints.map((p) => {
                  const connected = visibleLanes.filter(
                    (l) => l.from.id === p.id || l.to.id === p.id,
                  );
                  return (
                    <SitePinMarker
                      key={p.id}
                      point={p}
                      isSelected={selectedSite?.id === p.id}
                      hasAlertLane={connected.some((l) => l.alert)}
                      laneCount={connected.length}
                      onSelect={() => {
                        setSelectedWeatherSiteId(null);
                        setSelectedSiteId(p.id);
                      }}
                      onClear={() => setSelectedSiteId(null)}
                    />
                  );
                })}
                {layers.weather ? (
                  <>
                    <WeatherAlertPolygons stations={weatherStations} />
                    {weatherStations.map((st) => {
                      const hasMatchingPin = visiblePoints.some((vp) => vp.id === st.siteId);
                      return (
                        <WeatherStationPin
                          key={`wx-${st.siteId}`}
                          station={st}
                          offsetPin={hasMatchingPin}
                          isSelected={selectedWeatherSiteId === st.siteId}
                          onSelect={() => {
                            setSelectedSiteId(null);
                            setSelectedWeatherSiteId(st.siteId);
                          }}
                          onClear={() => setSelectedWeatherSiteId(null)}
                        />
                      );
                    })}
                  </>
                ) : null}
                <MapFocusController target={weatherFocusTarget} />
                <NetworkRoutesLayer
                  showRoutes={layers.routes}
                  visibleLanes={visibleLanes}
                  selectedLane={selectedSite ? null : selectedLane}
                  onSelectLane={handleSelectLane}
                  onMetrics={handleMetrics}
                />
              </GoogleMap>
            </APIProvider>
          </div>

          <div className="map-footer-bar">
            <div className="legend">
              <span>
                <i className="dot m-warehouse" /> warehouse hub
              </span>
              <span>
                <i className="dot m-gateway-blue" /> port / airport
              </span>
              <span>
                <i className="line" /> active corridor
              </span>
              <span>
                <i className="line alert" /> needs attention
              </span>
            </div>
            <span className="text-xs text-faint">
              Click any pin or corridor lane to inspect live route
            </span>
          </div>
        </div>

        <div className="stack-md">
          {selectedSite ? (
            <div className="map-inspector" aria-live="polite">
              <div className="map-inspector-head">
                <div className="row-center">
                  <MapPin size={16} strokeWidth={2} aria-hidden="true" />
                  <div>
                    <strong>{selectedSite.name}</strong>
                    <span className="font-mono text-xs text-faint">
                      {" "}
                      · {selectedSite.code ?? formatStateLabel(selectedSite.type)} ·{" "}
                      {[selectedSite.city, selectedSite.country]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-ghost-sm"
                  onClick={() => setSelectedSiteId(null)}
                >
                  Clear
                </button>
              </div>
              {siteLanes.length === 0 ? (
                <p className="text-sm text-muted" style={{ margin: 0 }}>
                  No active shipments under the current filter pass through{" "}
                  {selectedSite.city ?? selectedSite.name}.
                </p>
              ) : (
                <div className="map-inspector-lanes">
                  {siteLanes.map(({ shipment }) => (
                    <button
                      key={shipment.id}
                      type="button"
                      className="map-lane-chip"
                      onClick={() => handleSelectLane(shipment.reference)}
                    >
                      <span className="font-mono font-semibold">
                        {shipment.reference}
                      </span>
                      <span className="text-muted">
                        {city(shipment.origin)} → {city(shipment.destination)}
                      </span>
                      <span
                        className="status-tag"
                        data-tone={toneFor(shipment.state)}
                      >
                        {formatStateLabel(shipment.state)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : selectedLane ? (
            <div className="map-inspector" aria-live="polite">
              <div className="map-inspector-head">
                <div className="row-center">
                  <Navigation size={15} strokeWidth={2} aria-hidden="true" />
                  <div>
                    <span className="font-mono font-semibold">
                      {selectedLane.shipment.reference}
                    </span>{" "}
                    <span className="text-muted">
                      {city(selectedLane.shipment.origin)} →{" "}
                      {city(selectedLane.shipment.destination)}
                    </span>
                  </div>
                  <span
                    className="status-tag"
                    data-tone={toneFor(selectedLane.shipment.state)}
                  >
                    {formatStateLabel(selectedLane.shipment.state)}
                  </span>
                </div>
                <Link
                  href={`/shipments/${selectedLane.shipment.reference}`}
                  className="empty-action"
                  style={{ marginTop: 0 }}
                >
                  <span>Open shipment</span>
                  <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
                </Link>
              </div>

              {layers.routes && routeMetrics ? (
                <div className="gmap-route-stats">
                  <span>
                    <RouteIcon size={13} strokeWidth={2} aria-hidden="true" />
                    <strong>{routeMetrics.distanceKm}</strong>
                  </span>
                  <span>
                    Drive ETA: <strong>{routeMetrics.durationLabel}</strong>
                  </span>
                </div>
              ) : !layers.routes ? (
                <p className="text-xs text-faint" style={{ margin: 0 }}>
                  Route polylines hidden — enable <strong>Active routes</strong> in Map Layers to draw corridors.
                </p>
              ) : null}

              <div className="map-inspector-meta">
                <span>
                  Customer: <strong>{selectedLane.shipment.customer_ref ?? "—"}</strong>
                </span>
                <span>
                  Cargo:{" "}
                  <strong>
                    {String(selectedLane.shipment.cargo?.quantity ?? "—")} ×{" "}
                    {String(selectedLane.shipment.cargo?.weight_kg ?? "—")} kg
                  </strong>
                </span>
                <span>
                  Last update: <strong>{relative(selectedLane.shipment.updated_at)}</strong>
                </span>
              </div>

              {visibleLanes.length > 1 ? (
                <div className="map-inspector-lanes" role="group" aria-label="Switch highlighted lane">
                  {visibleLanes.map((l) => (
                    <button
                      key={l.shipment.id}
                      type="button"
                      className={`map-lane-chip${
                        l.shipment.reference === selectedLane.shipment.reference
                          ? " is-selected"
                          : ""
                      }`}
                      onClick={() => handleSelectLane(l.shipment.reference)}
                    >
                      <span className="font-mono font-semibold">{l.shipment.reference}</span>
                      <span className="text-muted">
                        {city(l.shipment.origin)} → {city(l.shipment.destination)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <MapsGroundingPanel context={groundingContext} />
        </div>
      </div>
    </div>
  );
}
