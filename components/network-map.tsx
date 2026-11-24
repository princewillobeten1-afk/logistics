"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, MapPin, Navigation } from "lucide-react";
import { ClientRelative } from "@/components/client-time";
import { city, toneFor } from "@/lib/format";
import { filterPointsByLayers, type MapLayerVisibility } from "@/lib/map-layers";
import { formatStateLabel } from "@/lib/view-helpers";

export type MapSitePoint = {
  id: string;
  type: string;
  name: string;
  code: string | null;
  city: string | null;
  country: string | null;
  x: number;
  y: number;
};

export type MapShipmentItem = {
  id: string;
  reference: string;
  state: string;
  customer_ref: string | null;
  origin: Record<string, unknown>;
  destination: Record<string, unknown>;
  cargo: Record<string, unknown>;
  updated_at: Date | string;
};

export type MapLane = {
  shipment: MapShipmentItem;
  from: MapSitePoint;
  to: MapSitePoint;
  alert: boolean;
};

const W = 900;
const H = 520;

const MARKERS: Record<string, { r: number; className: string }> = {
  WAREHOUSE: { r: 6.5, className: "m-warehouse" },
  PORT: { r: 5.5, className: "m-gateway" },
  AIRPORT: { r: 5.5, className: "m-gateway" },
  RAIL_TERMINAL: { r: 5.5, className: "m-gateway" },
};

type LaneFilter = "ALL" | "ALERT" | "MOVING";

export function NetworkMap({
  points,
  lanes,
  layers,
}: {
  points: MapSitePoint[];
  lanes: MapLane[];
  layers?: MapLayerVisibility;
}) {
  const [filter, setFilter] = useState<LaneFilter>("ALL");
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [selectedRef, setSelectedRef] = useState<string | null>(
    () => lanes.find((l) => l.alert)?.shipment.reference ?? lanes[0]?.shipment.reference ?? null,
  );

  const visiblePoints = useMemo(
    () => (layers ? filterPointsByLayers(points, layers) : points),
    [points, layers],
  );

  const visibleLanes = useMemo(() => {
    if (layers && !layers.routes) return [];
    if (filter === "ALERT") return lanes.filter((l) => l.alert);
    if (filter === "MOVING") return lanes.filter((l) => !l.alert);
    return lanes;
  }, [lanes, filter, layers]);

  const selectedSite = useMemo(
    () => points.find((p) => p.id === selectedSiteId) ?? null,
    [points, selectedSiteId],
  );

  const selectedLane = useMemo(
    () =>
      lanes.find((l) => l.shipment.reference === selectedRef) ??
      visibleLanes[0] ??
      null,
    [lanes, visibleLanes, selectedRef],
  );

  const siteLanes = useMemo(() => {
    if (!selectedSite) return [];
    return visibleLanes.filter(
      (l) => l.from.id === selectedSite.id || l.to.id === selectedSite.id,
    );
  }, [selectedSite, visibleLanes]);

  const placedMarkers = useMemo(() => {
    // Separate markers that land very close in regional projection (e.g. Tema & Accra)
    // and alternate label positions so no two site codes collide.
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    const adjusted = new Map<
      string,
      { x: number; y: number; labelDx: number; labelDy: number; anchor: "middle" | "start" | "end" }
    >();
    const placed: { id: string; x: number; y: number }[] = [];

    for (const p of sorted) {
      let x = p.x;
      let y = p.y;
      let labelDy = -1; // -1 = above, 1 = below
      let labelDx = 0;
      let anchor: "middle" | "start" | "end" = "middle";

      for (const prev of placed) {
        const dx = x - prev.x;
        const dy = y - prev.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 26) {
          x = prev.x + 24;
          y = prev.y - 12;
        }
        if (Math.abs(x - prev.x) < 76 && Math.abs(y - prev.y) < 34) {
          const prevLabel = adjusted.get(prev.id);
          if (prevLabel && prevLabel.labelDy < 0) {
            labelDy = 1;
            labelDx = 8;
            anchor = "start";
          } else {
            labelDy = -1;
            labelDx = -6;
            anchor = "end";
          }
        }
      }

      placed.push({ id: p.id, x, y });
      adjusted.set(p.id, { x, y, labelDx, labelDy, anchor });
    }
    return adjusted;
  }, [points]);

  return (
    <div className="stack-md">
      <div className="filters" role="group" aria-label="Filter network lanes">
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

      <div className="map-stage">
        <div className="map-canvas-col">
          <div className="mapwrap">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="map"
              role="img"
              aria-label="Interactive map of the logistics network"
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
                <marker
                  id="arrow-alert"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className="lane-head-alert" />
                </marker>
              </defs>

              <g className="grid">
                {Array.from({ length: 7 }, (_, i) => (
                  <line
                    key={`v${i}`}
                    x1={(W / 6) * i}
                    y1="0"
                    x2={(W / 6) * i}
                    y2={H}
                  />
                ))}
                {Array.from({ length: 5 }, (_, i) => (
                  <line
                    key={`h${i}`}
                    x1="0"
                    y1={(H / 4) * i}
                    x2={W}
                    y2={(H / 4) * i}
                  />
                ))}
              </g>

              {visibleLanes.map(({ shipment, from, to, alert }, i) => {
                const pFrom = placedMarkers.get(from.id) ?? from;
                const pTo = placedMarkers.get(to.id) ?? to;
                const mx = (pFrom.x + pTo.x) / 2;
                const my = (pFrom.y + pTo.y) / 2;
                const dx = pTo.x - pFrom.x;
                const dy = pTo.y - pFrom.y;
                const len = Math.hypot(dx, dy) || 1;
                const lift = Math.min(70, len * 0.22) + (i % 2 === 0 ? 0 : 12);
                const cx = mx + (-dy / len) * lift;
                const cy = my + (dx / len) * lift;
                const isSelected =
                  (!selectedSite &&
                    selectedLane?.shipment.reference === shipment.reference) ||
                  (selectedSite !== null &&
                    (from.id === selectedSite.id || to.id === selectedSite.id));
                const dimmed =
                  (selectedSite !== null &&
                    from.id !== selectedSite.id &&
                    to.id !== selectedSite.id) ||
                  (!selectedSite &&
                    selectedLane !== null &&
                    selectedLane.shipment.reference !== shipment.reference);

                return (
                  <path
                    key={`${shipment.id}-${i}`}
                    d={`M ${pFrom.x} ${pFrom.y} Q ${cx} ${cy} ${pTo.x} ${pTo.y}`}
                    className={`lane${alert ? " lane-alert" : ""}${isSelected ? " lane-selected" : ""}${dimmed ? " lane-dim" : ""}`}
                    markerEnd={alert ? "url(#arrow-alert)" : "url(#arrow)"}
                    tabIndex={0}
                    role="button"
                    aria-label={`Inspect lane ${shipment.reference}: ${city(shipment.origin)} to ${city(shipment.destination)}`}
                    onClick={() => {
                      setSelectedSiteId(null);
                      setSelectedRef(shipment.reference);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedSiteId(null);
                        setSelectedRef(shipment.reference);
                      }
                    }}
                  />
                );
              })}

              {visiblePoints.map((p) => {
                const marker = MARKERS[p.type] ?? { r: 4.5, className: "m-other" };
                const isSelected = selectedSite?.id === p.id;
                const pos = placedMarkers.get(p.id) ?? {
                  x: p.x,
                  y: p.y,
                  labelDx: 0,
                  labelDy: -1,
                  anchor: "middle" as const,
                };
                const textY =
                  pos.labelDy < 0
                    ? pos.y - marker.r - 9
                    : pos.y + marker.r + 17;

                return (
                  <g
                    key={p.id}
                    className={`marker ${marker.className}${isSelected ? " is-selected" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Select site ${p.name} (${p.code ?? p.type})`}
                    onClick={() => setSelectedSiteId(isSelected ? null : p.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedSiteId(isSelected ? null : p.id);
                      }
                    }}
                  >
                    <circle
                      className="halo"
                      cx={pos.x}
                      cy={pos.y}
                      r={isSelected ? marker.r + 10 : marker.r + 5}
                    />
                    <circle className="core" cx={pos.x} cy={pos.y} r={marker.r} />
                    <text
                      x={pos.x + pos.labelDx}
                      y={textY}
                      textAnchor={pos.anchor}
                    >
                      {p.code ?? p.name}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="map-footer-bar">
            <div className="legend">
              <span>
                <i className="dot m-warehouse" /> warehouse
              </span>
              <span>
                <i className="dot m-gateway" /> port / airport
              </span>
              <span>
                <i className="line" /> active lane
              </span>
              <span>
                <i className="line alert" /> needs attention
              </span>
            </div>
            <span className="text-xs text-faint">
              Click any site or lane to inspect shipments
            </span>
          </div>
        </div>

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
                  <Link
                    key={shipment.id}
                    href={`/shipments/${shipment.reference}`}
                    className="map-lane-chip"
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
                  </Link>
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
                Last update: <strong><ClientRelative date={selectedLane.shipment.updated_at} /></strong>
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
