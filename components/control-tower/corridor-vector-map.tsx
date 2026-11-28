"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Compass, Globe, Maximize2, Minus, Plus } from "lucide-react";
import { formatStateLabel } from "@/lib/view-helpers";

export interface CorridorMapHub {
  id: string;
  name: string;
  code: string | null;
  city: string | null;
  country: string | null;
  lat: number;
  lon: number;
}

// Simplified Natural Earth world landmass polygons projected in Equirectangular coordinates:
// x = ((lon + 180) / 360) * 1000, y = ((90 - lat) / 180) * 500
const WORLD_LAND_PATHS = [
  // North America
  "M 110,72 L 155,62 L 220,60 L 285,82 L 325,108 L 308,138 L 280,152 L 266,184 L 240,198 L 222,216 L 204,218 L 194,194 L 166,172 L 150,148 L 122,126 L 104,96 Z",
  // South America
  "M 272,226 L 310,226 L 352,250 L 386,274 L 388,308 L 364,344 L 340,384 L 316,418 L 298,408 L 296,368 L 282,326 L 268,284 L 264,252 Z",
  // Europe + Scandinavia
  "M 468,144 L 474,116 L 502,94 L 542,78 L 578,84 L 598,108 L 578,128 L 560,144 L 538,146 L 516,142 L 496,152 L 472,152 Z",
  // UK & Ireland
  "M 468,106 L 484,104 L 486,120 L 468,122 Z",
  // Africa (detailed West African Gulf of Guinea curve for Lagos/Tema/Abuja/Kano accuracy!)
  "M 476,162 L 518,158 L 560,164 L 588,176 L 596,204 L 626,222 L 642,248 L 620,282 L 604,322 L 578,354 L 552,358 L 536,332 L 528,288 L 522,252 L 504,238 L 482,238 L 462,228 L 452,206 L 458,184 Z",
  // Madagascar
  "M 624,306 L 636,302 L 634,332 L 620,336 Z",
  // Asia + Middle East + India + SE Asia
  "M 578,136 L 620,144 L 650,132 L 686,110 L 760,90 L 860,88 L 930,104 L 910,138 L 876,152 L 856,178 L 826,192 L 796,216 L 774,234 L 748,208 L 722,226 L 704,226 L 686,198 L 656,194 L 630,214 L 598,196 L 586,168 Z",
  // Australia
  "M 806,304 L 856,294 L 902,312 L 908,348 L 880,368 L 832,362 L 802,340 Z",
  // Greenland
  "M 340,36 L 412,30 L 434,54 L 394,82 L 352,74 Z",
];

const round2 = (n: number) => Math.round(n * 100) / 100;

function projectLon(lon: number): number {
  return round2(((lon + 180) / 360) * 1000);
}

function projectLat(lat: number): number {
  return round2(((90 - lat) / 180) * 500);
}

export function CorridorVectorMap({
  reference,
  state,
  originCity,
  destinationCity,
  originCoords,
  destinationCoords,
  liveLat,
  liveLon,
  hubs,
}: {
  reference: string;
  state: string;
  originCity: string;
  destinationCity: string;
  originCoords: { lat: number; lon: number };
  destinationCoords: { lat: number; lon: number };
  liveLat?: number | null;
  liveLon?: number | null;
  hubs: CorridorMapHub[];
}) {
  const [framing, setFraming] = useState<"REGIONAL" | "GLOBAL">("REGIONAL");
  const [zoomFactor, setZoomFactor] = useState<number>(1);
  const [timelineProgress, setTimelineProgress] = useState<number>(() => {
    if (["DELIVERED", "POD_VERIFIED", "CLOSED"].includes(state)) return 1;
    if (["IN_TRANSIT", "EXCEPTION"].includes(state)) return 0.62;
    if (["BOOKED", "AWAITING_APPROVAL", "SOURCING"].includes(state)) return 0.35;
    return 0.14;
  });

  const oPt = useMemo(
    () => ({ x: projectLon(originCoords.lon), y: projectLat(originCoords.lat) }),
    [originCoords.lat, originCoords.lon],
  );
  const dPt = useMemo(
    () => ({
      x: projectLon(destinationCoords.lon),
      y: projectLat(destinationCoords.lat),
    }),
    [destinationCoords.lat, destinationCoords.lon],
  );

  // Compute curved corridor arc
  const { pathD, ctrlPt, markerPt } = useMemo(() => {
    const mx = (oPt.x + dPt.x) / 2;
    const my = (oPt.y + dPt.y) / 2;
    const dx = dPt.x - oPt.x;
    const dy = dPt.y - oPt.y;
    const dist = Math.hypot(dx, dy) || 1;
    const curveLift = Math.min(26, dist * 0.28);
    const cx = mx + (-dy / dist) * curveLift;
    const cy = my + (dx / dist) * curveLift;
    const t =
      liveLat != null && liveLon != null && timelineProgress === 0.62
        ? 0.62
        : timelineProgress;
    // Quadratic Bezier point at t
    const oneMinusT = 1 - t;
    const px =
      oneMinusT * oneMinusT * oPt.x + 2 * oneMinusT * t * cx + t * t * dPt.x;
    const py =
      oneMinusT * oneMinusT * oPt.y + 2 * oneMinusT * t * cy + t * t * dPt.y;
    return {
      pathD: `M ${oPt.x.toFixed(2)} ${oPt.y.toFixed(2)} Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${dPt.x.toFixed(2)} ${dPt.y.toFixed(2)}`,
      ctrlPt: { x: round2(cx), y: round2(cy) },
      markerPt: { x: round2(px), y: round2(py) },
    };
  }, [oPt, dPt, liveLat, liveLon, timelineProgress]);

  // Compute dynamic SVG viewBox matching Regional corridor vs Global map
  const viewBox = useMemo(() => {
    if (framing === "GLOBAL") {
      const baseW = 540 / zoomFactor;
      const baseH = 380 / zoomFactor;
      const cx = 530;
      const cy = 225;
      return `${(cx - baseW / 2).toFixed(1)} ${(cy - baseH / 2).toFixed(1)} ${baseW.toFixed(1)} ${baseH.toFixed(1)}`;
    }
    const minX = Math.min(oPt.x, dPt.x, ctrlPt.x);
    const maxX = Math.max(oPt.x, dPt.x, ctrlPt.x);
    const minY = Math.min(oPt.y, dPt.y, ctrlPt.y);
    const maxY = Math.max(oPt.y, dPt.y, ctrlPt.y);
    const spanX = Math.max(maxX - minX, 34);
    const spanY = Math.max(maxY - minY, 26);
    const boxW = Math.max(82, spanX * 2.4) / zoomFactor;
    const boxH = Math.max(66, spanY * 2.4) / zoomFactor;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return `${(cx - boxW / 2).toFixed(2)} ${(cy - boxH / 2).toFixed(2)} ${boxW.toFixed(2)} ${boxH.toFixed(2)}`;
  }, [framing, zoomFactor, oPt, dPt, ctrlPt]);

  const isAlert = ["EXCEPTION", "NEEDS_INFO", "AWAITING_APPROVAL"].includes(state);
  const scaleStroke = framing === "GLOBAL" ? 1 : 0.28;

  const TIMELINE_SLOTS = [
    { label: "-12h", t: 0.14 },
    { label: "-6h", t: 0.38 },
    { label: "Live", t: 0.62 },
    { label: "+6h", t: 0.84 },
    { label: "ETA", t: 1.0 },
  ];

  return (
    <div className="ct-map-panel">
      {/* Floating Top-Left Framing Controls */}
      <div className="ct-map-top-left">
        <button
          type="button"
          className="ct-map-icon-btn"
          title={framing === "REGIONAL" ? "Switch to global framing" : "Focus on corridor"}
          aria-label={framing === "REGIONAL" ? "Switch to global framing" : "Focus on corridor"}
          onClick={() => {
            setFraming((f) => (f === "REGIONAL" ? "GLOBAL" : "REGIONAL"));
            setZoomFactor(1);
          }}
        >
          {framing === "REGIONAL" ? (
            <Globe size={14} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Compass size={14} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
        <Link
          href="/map"
          className="ct-map-icon-btn"
          title="Open full Google Network Map"
          aria-label="Open full Google Network Map"
        >
          <Maximize2 size={13} strokeWidth={2} aria-hidden="true" />
        </Link>
      </div>

      {/* Floating Top-Right Zoom Controls */}
      <div className="ct-map-top-right">
        <button
          type="button"
          className="ct-map-zoom-btn"
          aria-label="Zoom in"
          onClick={() => setZoomFactor((z) => Math.min(2.2, +(z + 0.3).toFixed(1)))}
        >
          <Plus size={14} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ct-map-zoom-btn"
          aria-label="Zoom out"
          onClick={() => setZoomFactor((z) => Math.max(0.6, +(z - 0.3).toFixed(1)))}
        >
          <Minus size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* Floating Callout Card inside Map */}
      <Link href={`/shipments/${encodeURIComponent(reference)}`} className="ct-map-callout">
        <div className="ct-map-callout-ref">{reference}</div>
        <div className="ct-map-callout-sub">
          <span className={`ct-map-status-dot${isAlert ? " is-alert" : ""}`} aria-hidden="true" />
          <span>{formatStateLabel(state)}</span>
        </div>
      </Link>

      {/* Architectural Monochrome SVG Map */}
      <svg
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid slice"
        className="ct-map-svg"
        role="img"
        aria-label={`Corridor map from ${originCity} to ${destinationCity}`}
      >
        <g className="ct-land-layer">
          {WORLD_LAND_PATHS.map((d, i) => (
            <path key={i} d={d} strokeWidth={round2(scaleStroke * 1.2)} />
          ))}
        </g>

        {/* Network Hubs */}
        {hubs.map((hub) => {
          const hx = projectLon(hub.lon);
          const hy = projectLat(hub.lat);
          const isOrigin =
            hub.city?.toLowerCase() === originCity.toLowerCase();
          const isDest =
            hub.city?.toLowerCase() === destinationCity.toLowerCase();
          const isEndpoint = isOrigin || isDest;
          return (
            <g key={hub.id}>
              <circle
                cx={hx}
                cy={hy}
                r={round2(isEndpoint ? scaleStroke * 3.8 : scaleStroke * 2.1)}
                className={isEndpoint ? "ct-hub-active" : "ct-hub-dot"}
              />
              {framing === "REGIONAL" && isEndpoint ? (
                <text
                  x={hx}
                  y={round2(isDest && hy < oPt.y ? hy - scaleStroke * 8 : hy + scaleStroke * 13)}
                  textAnchor="middle"
                  fontSize={round2(scaleStroke * 8.5)}
                  className="ct-hub-label"
                >
                  {hub.code?.slice(0, 3) ?? hub.city?.slice(0, 3).toUpperCase()}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* Dashed curved corridor path */}
        <path
          d={pathD}
          fill="none"
          className={`ct-corridor-arc${isAlert ? " is-alert" : ""}`}
          strokeWidth={round2(scaleStroke * 2.2)}
          strokeDasharray={`${round2(scaleStroke * 4.5)} ${round2(scaleStroke * 3.5)}`}
        />

        {/* Origin & Destination Pins */}
        <circle
          cx={oPt.x}
          cy={oPt.y}
          r={round2(scaleStroke * 6.5)}
          className="ct-pin-halo"
        />
        <circle
          cx={oPt.x}
          cy={oPt.y}
          r={round2(scaleStroke * 3.6)}
          className="ct-pin-origin"
        />

        <circle
          cx={dPt.x}
          cy={dPt.y}
          r={round2(scaleStroke * 6.5)}
          className="ct-pin-halo-dest"
        />
        <circle
          cx={dPt.x}
          cy={dPt.y}
          r={round2(scaleStroke * 3.6)}
          className="ct-pin-dest"
        />

        {/* Active shipment position indicator */}
        <circle
          cx={markerPt.x}
          cy={markerPt.y}
          r={round2(scaleStroke * 7.5)}
          className={`ct-vehicle-halo${isAlert ? " is-alert" : ""}`}
        />
        <circle
          cx={markerPt.x}
          cy={markerPt.y}
          r={round2(scaleStroke * 3.4)}
          className={`ct-vehicle-core${isAlert ? " is-alert" : ""}`}
        />
      </svg>

      {/* Bottom Interactive Scrubbable Time Bar */}
      <div className="ct-map-timeline" role="group" aria-label="Transit timeline preview">
        <div className="ct-map-time-labels">
          {TIMELINE_SLOTS.map((slot) => {
            const active = Math.abs(timelineProgress - slot.t) < 0.1;
            return (
              <button
                key={slot.label}
                type="button"
                className={`ct-map-time-btn${active ? " is-active" : ""}`}
                onClick={() => setTimelineProgress(slot.t)}
              >
                {slot.label}
              </button>
            );
          })}
        </div>
        <div className="ct-map-ruler" aria-hidden="true">
          {Array.from({ length: 29 }, (_, idx) => (
            <span
              key={idx}
              className={`ct-ruler-tick${idx % 7 === 0 ? " is-major" : ""}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
