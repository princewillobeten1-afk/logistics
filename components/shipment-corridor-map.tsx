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
import { Map as MapIcon, Route as RouteIcon, Satellite } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dispatchQuotaExceeded } from "@/components/maps-quota-banner";
import type { WeatherStationReading } from "@/lib/map-layers";
import { isQuotaErrorMessage, type LatLngPoint } from "@/lib/maps-grounding";

export interface CorridorPathOption {
  index: number;
  label: string;
  description: string | null;
  distanceKm: number | null;
  distanceLabel: string;
  durationMs: number | null;
  durationLabel: string;
  midpoint: LatLngPoint | null;
  source: "routes-api" | "geodesic";
}

function formatDurationMs(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

export function haversineDistanceKm(a: LatLngPoint, b: LatLngPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const c =
    s1 * s1 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));
}

function extractLatLng(pt: unknown): LatLngPoint | null {
  if (!pt || typeof pt !== "object") return null;
  const obj = pt as {
    lat?: number | (() => number);
    lng?: number | (() => number);
  };
  const lat = typeof obj.lat === "function" ? obj.lat() : Number(obj.lat);
  const lng = typeof obj.lng === "function" ? obj.lng() : Number(obj.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function EndpointMarker({
  position,
  title,
  label,
  tone,
}: {
  position: LatLngPoint;
  title: string;
  label: string;
  tone: "origin" | "destination";
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();
  const [open, setOpen] = useState(false);

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={position}
        title={title}
        onClick={() => setOpen((prev) => !prev)}
      >
        <Pin
          background={tone === "origin" ? "#0f766e" : "#1d4ed8"}
          borderColor={tone === "origin" ? "#115e59" : "#1e40af"}
          glyphColor="#ffffff"
          glyph={tone === "origin" ? "A" : "B"}
        />
      </AdvancedMarker>
      {open && marker ? (
        <InfoWindow anchor={marker} onCloseClick={() => setOpen(false)} maxWidth={220}>
          <div className="gmap-infowindow">
            <strong>{label}</strong>
            <div className="gmap-infowindow-meta">{title}</div>
          </div>
        </InfoWindow>
      ) : null}
    </>
  );
}

function CorridorWeatherOverlay({
  stations,
}: {
  stations: WeatherStationReading[];
}) {
  const map = useMap();
  const polysRef = useRef<google.maps.Polygon[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

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
          fillOpacity: 0.16,
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

  const alertStations = stations.filter((s) => s.severity !== "CLEAR");

  return (
    <>
      {alertStations.map((st) => (
        <CorridorWeatherPin
          key={`wx-${st.siteId}`}
          station={st}
          isOpen={activeId === st.siteId}
          onToggle={() =>
            setActiveId((prev) => (prev === st.siteId ? null : st.siteId))
          }
          onClose={() => setActiveId(null)}
        />
      ))}
    </>
  );
}

function CorridorWeatherPin({
  station,
  isOpen,
  onToggle,
  onClose,
}: {
  station: WeatherStationReading;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const [markerRef, marker] = useAdvancedMarkerRef();
  const isSevere = station.severity === "SEVERE" || station.severity === "EXTREME";
  const background = isSevere ? "#b91c1c" : "#d97706";
  const borderColor = isSevere ? "#7f1d1d" : "#92400e";

  return (
    <>
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: station.lat + 0.08, lng: station.lng + 0.08 }}
        zIndex={isOpen ? 40 : 25}
        title={`${station.siteName}: ${station.conditionLabel}`}
        onClick={onToggle}
      >
        <Pin
          background={background}
          borderColor={borderColor}
          glyphColor="#ffffff"
          glyph="!"
          scale={0.86}
        />
      </AdvancedMarker>
      {isOpen && marker ? (
        <InfoWindow anchor={marker} onCloseClick={onClose} maxWidth={250}>
          <div className="gmap-infowindow">
            <strong>
              {station.siteName} · {station.severity} Alert
            </strong>
            <div className="gmap-infowindow-meta">
              {station.conditionLabel}
              {station.temperatureC !== null
                ? ` · ${station.temperatureC.toFixed(1)}°C`
                : ""}
              {station.windSpeedKmh !== null
                ? ` · Wind ${Math.round(station.windSpeedKmh)} km/h`
                : ""}
            </div>
            {station.advisoryReasons.length > 0 ? (
              <div className="gmap-infowindow-lanes" style={{ color: "#9a3412" }}>
                {station.advisoryReasons[0]}
              </div>
            ) : null}
          </div>
        </InfoWindow>
      ) : null}
    </>
  );
}

interface ComputedRouteEntry {
  option: CorridorPathOption;
  polylines: google.maps.Polyline[];
  viewport?: google.maps.LatLngBounds | google.maps.LatLngBoundsLiteral;
}

function CorridorRoute({
  origin,
  destination,
  alert,
  selectedPathIndex,
  onSelectPathIndex,
  onPathsResolved,
}: {
  origin: LatLngPoint;
  destination: LatLngPoint;
  alert: boolean;
  selectedPathIndex: number;
  onSelectPathIndex?: (index: number) => void;
  onPathsResolved?: (paths: CorridorPathOption[]) => void;
}) {
  const map = useMap();
  const routesLib = useMapsLibrary("routes");
  const routeEntriesRef = useRef<ComputedRouteEntry[]>([]);
  const onPathsResolvedRef = useRef(onPathsResolved);
  const onSelectPathIndexRef = useRef(onSelectPathIndex);
  onPathsResolvedRef.current = onPathsResolved;
  onSelectPathIndexRef.current = onSelectPathIndex;

  // Fetch primary + alternative routes from Google Maps Routes API
  useEffect(() => {
    if (!map) return;
    let cancelled = false;

    const clearAll = () => {
      for (const entry of routeEntriesRef.current) {
        entry.polylines.forEach((p) => p.setMap(null));
      }
      routeEntriesRef.current = [];
    };

    clearAll();

    const fallbackDistanceKm = Math.max(1, Math.round(haversineDistanceKm(origin, destination)));
    const fallbackMidpoint: LatLngPoint = {
      lat: (origin.lat + destination.lat) / 2,
      lng: (origin.lng + destination.lng) / 2,
    };

    const drawFallback = () => {
      if (cancelled) return;
      const strokeColor = alert ? "#dc2626" : "#0f766e";
      const line = new google.maps.Polyline({
        path: [origin, destination],
        geodesic: true,
        strokeColor,
        strokeOpacity: 0.9,
        strokeWeight: 4,
        map,
      });
      const fallbackOption: CorridorPathOption = {
        index: 0,
        label: "Direct corridor",
        description: "Geodesic line",
        distanceKm: fallbackDistanceKm,
        distanceLabel: `~${fallbackDistanceKm} km`,
        durationMs: null,
        durationLabel: "Estimated by plan",
        midpoint: fallbackMidpoint,
        source: "geodesic",
      };
      routeEntriesRef.current = [{ option: fallbackOption, polylines: [line] }];
      const bounds = new google.maps.LatLngBounds();
      bounds.extend(origin);
      bounds.extend(destination);
      map.fitBounds(bounds, 48);
      onPathsResolvedRef.current?.([fallbackOption]);
    };

    if (!routesLib || !routesLib.Route) {
      drawFallback();
      return () => {
        cancelled = true;
        clearAll();
      };
    }

    const request = {
      origin,
      destination,
      travelMode: "DRIVING",
      computeAlternativeRoutes: true,
      fields: ["path", "distanceMeters", "durationMillis", "viewport", "description"],
    };

    (routesLib.Route as unknown as {
      computeRoutes: (req: typeof request) => Promise<{
        routes?: Array<{
          description?: string;
          distanceMeters?: number;
          durationMillis?: number;
          path?: unknown[];
          viewport?: google.maps.LatLngBounds | google.maps.LatLngBoundsLiteral;
          createPolylines?: () => google.maps.Polyline[];
        }>;
      }>;
    })
      .computeRoutes(request)
      .then(({ routes }) => {
        if (cancelled) return;
        const list = Array.isArray(routes) ? routes : [];
        if (list.length === 0) {
          drawFallback();
          return;
        }

        const resolvedEntries: ComputedRouteEntry[] = [];
        list.forEach((rt, idx) => {
          const polylines =
            typeof rt.createPolylines === "function" ? rt.createPolylines() : [];
          if (polylines.length === 0) return;

          const pathPts = Array.isArray(rt.path) ? rt.path : [];
          const midRaw =
            pathPts.length > 0 ? pathPts[Math.floor(pathPts.length / 2)] : null;
          const midpoint = extractLatLng(midRaw) ?? fallbackMidpoint;
          const distKm =
            typeof rt.distanceMeters === "number"
              ? Math.max(1, Math.round(rt.distanceMeters / 1000))
              : fallbackDistanceKm;
          const durMs =
            typeof rt.durationMillis === "number" ? rt.durationMillis : null;

          polylines.forEach((pl) => {
            pl.addListener("click", () => {
              onSelectPathIndexRef.current?.(idx);
            });
            pl.setMap(map);
          });

          resolvedEntries.push({
            option: {
              index: idx,
              label: idx === 0 ? "Primary road path" : `Alternative ${idx}`,
              description: rt.description?.trim() || null,
              distanceKm: distKm,
              distanceLabel: `${distKm} km`,
              durationMs: durMs,
              durationLabel: durMs !== null ? formatDurationMs(durMs) : "—",
              midpoint,
              source: "routes-api",
            },
            polylines,
            viewport: rt.viewport,
          });
        });

        if (resolvedEntries.length === 0) {
          drawFallback();
          return;
        }

        routeEntriesRef.current = resolvedEntries;
        onPathsResolvedRef.current?.(resolvedEntries.map((e) => e.option));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err ?? "");
        if (isQuotaErrorMessage(msg)) {
          dispatchQuotaExceeded();
        }
        drawFallback();
      });

    return () => {
      cancelled = true;
      clearAll();
    };
  }, [map, routesLib, origin, destination, alert]);

  // Style selected vs alternative polylines and fit map viewport when selected path changes
  useEffect(() => {
    if (!map) return;
    const entries = routeEntriesRef.current;
    if (entries.length === 0) return;
    const activeColor = alert ? "#dc2626" : "#0f766e";
    const safeIdx =
      selectedPathIndex >= 0 && selectedPathIndex < entries.length
        ? selectedPathIndex
        : 0;

    entries.forEach((entry, idx) => {
      const isSelected = idx === safeIdx;
      entry.polylines.forEach((pl) => {
        pl.setOptions({
          strokeColor: isSelected ? activeColor : "#64748b",
          strokeOpacity: isSelected ? 0.94 : 0.45,
          strokeWeight: isSelected ? 5 : 3.5,
          zIndex: isSelected ? 20 : 10,
          clickable: entries.length > 1,
        });
      });
    });

    const chosen = entries[safeIdx];
    if (chosen?.viewport) {
      map.fitBounds(chosen.viewport, 48);
    }
  }, [map, selectedPathIndex, alert]);

  return null;
}

export function ShipmentCorridorMap({
  apiKey,
  origin,
  destination,
  originLabel,
  destinationLabel,
  alert = false,
  selectedPathIndex = 0,
  onSelectPathIndex,
  onPathsResolved,
  weatherStations = [],
}: {
  apiKey: string;
  origin: LatLngPoint | null;
  destination: LatLngPoint | null;
  originLabel: string;
  destinationLabel: string;
  alert?: boolean;
  selectedPathIndex?: number;
  onSelectPathIndex?: (index: number) => void;
  onPathsResolved?: (paths: CorridorPathOption[]) => void;
  weatherStations?: WeatherStationReading[];
}) {
  const [mapType, setMapType] = useState<"roadmap" | "hybrid">("roadmap");

  if (!apiKey || !origin || !destination) {
    return (
      <div className="corridor-map-placeholder">
        <div className="row-center">
          <RouteIcon size={16} strokeWidth={2} aria-hidden="true" />
          <strong>
            {originLabel} → {destinationLabel}
          </strong>
        </div>
        <p className="text-xs text-muted" style={{ margin: 0 }}>
          {!apiKey
            ? "Interactive Google Map renders once a Google Maps API key is configured."
            : "Waiting for geocoded origin/destination coordinates."}
        </p>
      </div>
    );
  }

  const center = {
    lat: (origin.lat + destination.lat) / 2,
    lng: (origin.lng + destination.lng) / 2,
  };

  return (
    <div className="gmap-shell gmap-shell-compact" data-testid="shipment-corridor-map">
      <div
        className="gmap-type-toggle"
        role="group"
        aria-label="Map view mode"
        data-testid="corridor-map-type-toggle"
      >
        <button
          type="button"
          className={`gmap-type-btn${mapType === "roadmap" ? " is-active" : ""}`}
          aria-pressed={mapType === "roadmap"}
          onClick={() => setMapType("roadmap")}
        >
          <MapIcon size={13} strokeWidth={2} aria-hidden="true" />
          <span>Street</span>
        </button>
        <button
          type="button"
          className={`gmap-type-btn${mapType === "hybrid" ? " is-active" : ""}`}
          aria-pressed={mapType === "hybrid"}
          onClick={() => setMapType("hybrid")}
        >
          <Satellite size={13} strokeWidth={2} aria-hidden="true" />
          <span>Satellite</span>
        </button>
      </div>
      <APIProvider
        apiKey={apiKey}
        language="en"
        region="NG"
        libraries={["marker", "routes"]}
      >
        <GoogleMap
          mapId="DEMO_MAP_ID"
          internalUsageAttributionIds={["gmp_mcp_codeassist_v1_aistudio"]}
          defaultCenter={center}
          defaultZoom={6}
          mapTypeId={mapType}
          mapTypeControl={false}
          gestureHandling="greedy"
          style={{ width: "100%", height: "100%" }}
        >
          <EndpointMarker
            position={origin}
            title={originLabel}
            label="Origin"
            tone="origin"
          />
          <EndpointMarker
            position={destination}
            title={destinationLabel}
            label="Destination"
            tone="destination"
          />
          <CorridorWeatherOverlay stations={weatherStations} />
          <CorridorRoute
            origin={origin}
            destination={destination}
            alert={alert}
            selectedPathIndex={selectedPathIndex}
            onSelectPathIndex={onSelectPathIndex}
            onPathsResolved={onPathsResolved}
          />
        </GoogleMap>
      </APIProvider>
    </div>
  );
}
