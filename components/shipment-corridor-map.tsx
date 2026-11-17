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
import { Route as RouteIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { dispatchQuotaExceeded } from "@/components/maps-quota-banner";
import { isQuotaErrorMessage, type LatLngPoint } from "@/lib/maps-grounding";

function formatDurationMs(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
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

function CorridorRoute({
  origin,
  destination,
  alert,
  onStats,
}: {
  origin: LatLngPoint;
  destination: LatLngPoint;
  alert: boolean;
  onStats: (stats: { distance: string; duration: string } | null) => void;
}) {
  const map = useMap();
  const routesLib = useMapsLibrary("routes");
  const linesRef = useRef<google.maps.Polyline[]>([]);

  useEffect(() => {
    if (!map) return;
    let cancelled = false;

    linesRef.current.forEach((p) => p.setMap(null));
    linesRef.current = [];
    const strokeColor = alert ? "#dc2626" : "#0f766e";

    const drawFallback = () => {
      if (cancelled) return;
      const line = new google.maps.Polyline({
        path: [origin, destination],
        geodesic: true,
        strokeColor,
        strokeOpacity: 0.9,
        strokeWeight: 4,
        map,
      });
      linesRef.current = [line];
      const bounds = new google.maps.LatLngBounds();
      bounds.extend(origin);
      bounds.extend(destination);
      map.fitBounds(bounds, 48);
      onStats(null);
    };

    if (!routesLib || !routesLib.Route) {
      drawFallback();
      return () => {
        cancelled = true;
        linesRef.current.forEach((p) => p.setMap(null));
        linesRef.current = [];
      };
    }

    const request = {
      origin,
      destination,
      travelMode: "DRIVING",
      fields: ["path", "distanceMeters", "durationMillis", "viewport"],
    };

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
          drawFallback();
          return;
        }
        const polylines =
          typeof primaryRoute.createPolylines === "function"
            ? primaryRoute.createPolylines()
            : [];
        if (polylines.length === 0) {
          drawFallback();
          return;
        }
        polylines.forEach((pl) => {
          pl.setOptions({ strokeColor, strokeOpacity: 0.92, strokeWeight: 5 });
          pl.setMap(map);
        });
        linesRef.current = polylines;

        if (primaryRoute.viewport) {
          map.fitBounds(primaryRoute.viewport, 48);
        }

        if (typeof primaryRoute.distanceMeters === "number" && typeof primaryRoute.durationMillis === "number") {
          onStats({
            distance: `${(primaryRoute.distanceMeters / 1000).toFixed(0)} km`,
            duration: formatDurationMs(primaryRoute.durationMillis),
          });
        }
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
      linesRef.current.forEach((p) => p.setMap(null));
      linesRef.current = [];
    };
  }, [map, routesLib, origin, destination, alert, onStats]);

  return null;
}

export function ShipmentCorridorMap({
  apiKey,
  origin,
  destination,
  originLabel,
  destinationLabel,
  alert = false,
}: {
  apiKey: string;
  origin: LatLngPoint | null;
  destination: LatLngPoint | null;
  originLabel: string;
  destinationLabel: string;
  alert?: boolean;
}) {
  const [stats, setStats] = useState<{ distance: string; duration: string } | null>(null);

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
    <div className="stack-sm">
      <div className="gmap-shell gmap-shell-compact" data-testid="shipment-corridor-map">
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
            <CorridorRoute
              origin={origin}
              destination={destination}
              alert={alert}
              onStats={setStats}
            />
          </GoogleMap>
        </APIProvider>
      </div>
      {stats ? (
        <div className="gmap-route-stats">
          <span>
            <RouteIcon size={13} strokeWidth={2} aria-hidden="true" />
            Road corridor: <strong>{stats.distance}</strong>
          </span>
          <span>
            Estimated drive time: <strong>{stats.duration}</strong>
          </span>
        </div>
      ) : null}
    </div>
  );
}
