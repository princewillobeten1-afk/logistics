"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Plane, Ship, Truck } from "lucide-react";
import type { ModeVolumePoint, QuoteBookingPoint } from "@/lib/queries";

type TimeRange = "TODAY" | "7D" | "14D";

const round2 = (n: number) => Math.round(n * 100) / 100;

function buildSmoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const cx = ((p0.x + p1.x) / 2).toFixed(1);
    d += ` C ${cx} ${p0.y.toFixed(1)}, ${cx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

function buildPolylinePath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  return pts
    .map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
}

function niceMax(val: number): number {
  if (val <= 4) return 4;
  if (val <= 8) return 8;
  if (val <= 12) return 12;
  if (val <= 20) return 20;
  if (val <= 50) return 50;
  return Math.ceil(val / 20) * 20;
}

const RANGE_LABELS: Record<TimeRange, string> = {
  TODAY: "Today",
  "7D": "7 days",
  "14D": "14 days",
};

export function ControlTowerCharts({
  quoteBookingTrend,
  modeVolumeTrend,
  todayQuoteBookingTrend,
  todayModeVolumeTrend,
}: {
  quoteBookingTrend: QuoteBookingPoint[];
  modeVolumeTrend: ModeVolumePoint[];
  todayQuoteBookingTrend: QuoteBookingPoint[];
  todayModeVolumeTrend: ModeVolumePoint[];
}) {
  const [rangeLeft, setRangeLeft] = useState<TimeRange>("TODAY");
  const [rangeRight, setRangeRight] = useState<TimeRange>("TODAY");

  const [hoveredLeft, setHoveredLeft] = useState<number>(0);
  const [hoveredRight, setHoveredRight] = useState<number>(0);

  const [visibleModes, setVisibleModes] = useState<{
    sea: boolean;
    air: boolean;
    road: boolean;
  }>({ sea: true, air: true, road: true });

  const leftSeries = useMemo(() => {
    if (rangeLeft === "TODAY") return todayQuoteBookingTrend;
    if (rangeLeft === "7D") return quoteBookingTrend.slice(-7);
    return quoteBookingTrend;
  }, [quoteBookingTrend, todayQuoteBookingTrend, rangeLeft]);

  const rightSeries = useMemo(() => {
    if (rangeRight === "TODAY") return todayModeVolumeTrend;
    if (rangeRight === "7D") return modeVolumeTrend.slice(-7);
    return modeVolumeTrend;
  }, [modeVolumeTrend, todayModeVolumeTrend, rangeRight]);

  const leftHasData = useMemo(
    () => leftSeries.some((d) => d.bookings > 0 || d.quotes > 0),
    [leftSeries],
  );
  const rightHasData = useMemo(
    () => rightSeries.some((d) => d.sea > 0 || d.air > 0 || d.road > 0),
    [rightSeries],
  );

  const W = 540;
  const H = 195;
  const PAD_L = 34;
  const PAD_R = 16;
  const PAD_T = 18;
  const PAD_B = 28;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const leftMax = niceMax(
    Math.max(1, ...leftSeries.flatMap((d) => [d.bookings, d.quotes])),
  );
  const rightMax = niceMax(
    Math.max(
      1,
      ...rightSeries.flatMap((d) => [
        visibleModes.sea ? d.sea : 0,
        visibleModes.air ? d.air : 0,
        visibleModes.road ? d.road : 0,
      ]),
    ),
  );

  const xAt = (i: number, len: number) =>
    round2(len <= 1 ? PAD_L + plotW / 2 : PAD_L + (i / (len - 1)) * plotW);

  const yAt = (val: number, maxVal: number) =>
    round2(PAD_T + plotH - (Math.max(0, val) / maxVal) * plotH);

  const bookingPts = leftSeries.map((d, i) => ({
    x: xAt(i, leftSeries.length),
    y: yAt(d.bookings, leftMax),
  }));
  const quotePts = leftSeries.map((d, i) => ({
    x: xAt(i, leftSeries.length),
    y: yAt(d.quotes, leftMax),
  }));

  const seaPts = rightSeries.map((d, i) => ({
    x: xAt(i, rightSeries.length),
    y: yAt(d.sea, rightMax),
  }));
  const airPts = rightSeries.map((d, i) => ({
    x: xAt(i, rightSeries.length),
    y: yAt(d.air, rightMax),
  }));
  const roadPts = rightSeries.map((d, i) => ({
    x: xAt(i, rightSeries.length),
    y: yAt(d.road, rightMax),
  }));

  const safeLeftIdx = Math.min(hoveredLeft, Math.max(0, leftSeries.length - 1));
  const safeRightIdx = Math.min(hoveredRight, Math.max(0, rightSeries.length - 1));

  const activeLeft = leftSeries[safeLeftIdx];
  const activeRight = rightSeries[safeRightIdx];

  function toggleMode(key: "sea" | "air" | "road") {
    setVisibleModes((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.sea && !next.air && !next.road) return prev;
      return next;
    });
  }

  function cycleRange(current: TimeRange): TimeRange {
    if (current === "TODAY") return "7D";
    if (current === "7D") return "14D";
    return "TODAY";
  }

  return (
    <div className="ct-charts-grid">
      {/* Chart 1: Quote vs Booking Trend */}
      <section className="ct-card ct-chart-card" aria-label="Quote vs Booking Trend">
        <div className="ct-chart-head">
          <div className="ct-chart-title-row">
            <h2>Quote vs Booking Trend</h2>
            <div className="ct-chart-legend" aria-hidden="true">
              <span>
                <i className="ct-legend-line is-blue" />
                Bookings
              </span>
              <span>
                <i className="ct-legend-line is-emerald" />
                Quotes
              </span>
            </div>
          </div>

          <button
            type="button"
            className="ct-range-btn"
            onClick={() => setRangeLeft(cycleRange(rangeLeft))}
            aria-label={`Change trend range, currently ${RANGE_LABELS[rangeLeft]}`}
          >
            <span>{RANGE_LABELS[rangeLeft]}</span>
            <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="ct-chart-canvas-wrap">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="ct-chart-svg"
            role="img"
            aria-label="Quote versus booking trend line chart"
          >
            {/* Horizontal grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((frac, idx) => {
              const y = round2(PAD_T + plotH * (1 - frac));
              const val = Math.round(leftMax * frac);
              return (
                <g key={idx}>
                  <line
                    x1={PAD_L}
                    y1={y}
                    x2={W - PAD_R}
                    y2={y}
                    className="ct-grid-line"
                  />
                  <text x={PAD_L - 8} y={round2(y + 3.5)} textAnchor="end" className="ct-axis-text">
                    {val}
                  </text>
                </g>
              );
            })}

            {/* Active vertical guide */}
            {bookingPts[safeLeftIdx] ? (
              <line
                x1={bookingPts[safeLeftIdx].x}
                y1={PAD_T}
                x2={bookingPts[safeLeftIdx].x}
                y2={H - PAD_B}
                className="ct-crosshair"
              />
            ) : null}

            {/* Smooth splines */}
            <path d={buildSmoothPath(quotePts)} className="ct-line-emerald" />
            <path d={buildSmoothPath(bookingPts)} className="ct-line-blue" />

            {/* Interactive nodes + X labels */}
            {leftSeries.map((d, i) => {
              const bPt = bookingPts[i];
              const qPt = quotePts[i];
              const isSelected = leftHasData && i === safeLeftIdx;
              const showLabel =
                leftSeries.length <= 8 || i % 2 === 0 || i === leftSeries.length - 1;
              return (
                <g key={`${d.label}-${i}`}>
                  {showLabel ? (
                    <text
                      x={bPt.x}
                      y={H - 8}
                      textAnchor="middle"
                      className={`ct-axis-text${isSelected ? " is-selected" : ""}`}
                    >
                      {d.label}
                    </text>
                  ) : null}
                  <circle
                    cx={qPt.x}
                    cy={qPt.y}
                    r={isSelected ? 4.5 : 3.2}
                    className={`ct-dot-emerald${isSelected ? " is-selected" : ""}`}
                  />
                  <circle
                    cx={bPt.x}
                    cy={bPt.y}
                    r={isSelected ? 4.5 : 3.2}
                    className={`ct-dot-blue${isSelected ? " is-selected" : ""}`}
                  />
                  {/* Wide hit target per column */}
                  <rect
                    x={round2(bPt.x - plotW / (Math.max(1, leftSeries.length) * 2))}
                    y={PAD_T}
                    width={round2(plotW / Math.max(1, leftSeries.length))}
                    height={plotH + PAD_B}
                    fill="transparent"
                    className="ct-hit-zone"
                    tabIndex={0}
                    role="button"
                    aria-label={`${d.label}: ${d.bookings} bookings, ${d.quotes} quotes`}
                    onMouseEnter={() => setHoveredLeft(i)}
                    onFocus={() => setHoveredLeft(i)}
                    onClick={() => setHoveredLeft(i)}
                  />
                </g>
              );
            })}

            {!leftHasData ? (
              <text
                x={round2(PAD_L + plotW / 2)}
                y={round2(PAD_T + plotH / 2 - 4)}
                textAnchor="middle"
                className="ct-axis-text"
              >
                No quote or booking activity in this window
              </text>
            ) : null}
          </svg>

          {leftHasData && activeLeft && bookingPts[safeLeftIdx] ? (
            <div
              className="ct-chart-popover"
              style={{
                left: `${Math.min(72, Math.max(12, (bookingPts[safeLeftIdx].x / W) * 100)).toFixed(2)}%`,
              }}
            >
              <div className="ct-popover-title">{activeLeft.label}</div>
              <div className="ct-popover-row">
                <span className="ct-popover-key">
                  <i className="ct-popover-ring is-blue" />
                  Bookings
                </span>
                <strong>{activeLeft.bookings}</strong>
              </div>
              <div className="ct-popover-row">
                <span className="ct-popover-key">
                  <i className="ct-popover-ring is-emerald" />
                  Quotes
                </span>
                <strong>{activeLeft.quotes}</strong>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* Chart 2: Shipment Volume by Mode */}
      <section className="ct-card ct-chart-card" aria-label="Shipment Volume by Mode">
        <div className="ct-chart-head">
          <div className="ct-chart-title-row">
            <h2>Shipment Volume by Mode</h2>
            <div className="ct-mode-toggles" role="group" aria-label="Toggle transport modes">
              <button
                type="button"
                className="ct-mode-toggle"
                aria-pressed={visibleModes.sea}
                onClick={() => toggleMode("sea")}
              >
                <Ship size={12} strokeWidth={2} aria-hidden="true" />
                <span>Sea</span>
              </button>
              <button
                type="button"
                className="ct-mode-toggle"
                aria-pressed={visibleModes.air}
                onClick={() => toggleMode("air")}
              >
                <Plane size={12} strokeWidth={2} aria-hidden="true" />
                <span>Air</span>
              </button>
              <button
                type="button"
                className="ct-mode-toggle"
                aria-pressed={visibleModes.road}
                onClick={() => toggleMode("road")}
              >
                <Truck size={12} strokeWidth={2} aria-hidden="true" />
                <span>Road</span>
              </button>
            </div>
          </div>

          <button
            type="button"
            className="ct-range-btn"
            onClick={() => setRangeRight(cycleRange(rangeRight))}
            aria-label={`Change mode volume range, currently ${RANGE_LABELS[rangeRight]}`}
          >
            <span>{RANGE_LABELS[rangeRight]}</span>
            <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="ct-chart-canvas-wrap">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="ct-chart-svg"
            role="img"
            aria-label="Shipment volume by transport mode chart"
          >
            {[0, 0.25, 0.5, 0.75, 1].map((frac, idx) => {
              const y = round2(PAD_T + plotH * (1 - frac));
              const val = Math.round(rightMax * frac);
              return (
                <g key={idx}>
                  <line
                    x1={PAD_L}
                    y1={y}
                    x2={W - PAD_R}
                    y2={y}
                    className="ct-grid-line"
                  />
                  <text x={PAD_L - 8} y={round2(y + 3.5)} textAnchor="end" className="ct-axis-text">
                    {val}
                  </text>
                </g>
              );
            })}

            {roadPts[safeRightIdx] ? (
              <line
                x1={roadPts[safeRightIdx].x}
                y1={PAD_T}
                x2={roadPts[safeRightIdx].x}
                y2={H - PAD_B}
                className="ct-crosshair"
              />
            ) : null}

            {visibleModes.air ? (
              <path d={buildPolylinePath(airPts)} className="ct-line-muted-2" />
            ) : null}
            {visibleModes.sea ? (
              <path d={buildPolylinePath(seaPts)} className="ct-line-muted-1" />
            ) : null}
            {visibleModes.road ? (
              <path d={buildPolylinePath(roadPts)} className="ct-line-ink" />
            ) : null}

            {rightSeries.map((d, i) => {
              const pt = roadPts[i];
              const isSelected = rightHasData && i === safeRightIdx;
              const showLabel =
                rightSeries.length <= 8 || i % 2 === 0 || i === rightSeries.length - 1;
              return (
                <g key={`${d.label}-${i}`}>
                  {showLabel ? (
                    <text
                      x={pt.x}
                      y={H - 8}
                      textAnchor="middle"
                      className={`ct-axis-text${isSelected ? " is-selected" : ""}`}
                    >
                      {d.label}
                    </text>
                  ) : null}
                  <rect
                    x={round2(pt.x - plotW / (Math.max(1, rightSeries.length) * 2))}
                    y={PAD_T}
                    width={round2(plotW / Math.max(1, rightSeries.length))}
                    height={plotH + PAD_B}
                    fill="transparent"
                    className="ct-hit-zone"
                    tabIndex={0}
                    role="button"
                    aria-label={`${d.label}: Sea ${d.sea}, Air ${d.air}, Road ${d.road}`}
                    onMouseEnter={() => setHoveredRight(i)}
                    onFocus={() => setHoveredRight(i)}
                    onClick={() => setHoveredRight(i)}
                  />
                </g>
              );
            })}

            {!rightHasData ? (
              <text
                x={round2(PAD_L + plotW / 2)}
                y={round2(PAD_T + plotH / 2 - 4)}
                textAnchor="middle"
                className="ct-axis-text"
              >
                No shipments recorded by mode in this window
              </text>
            ) : null}
          </svg>

          {rightHasData && activeRight && roadPts[safeRightIdx] ? (
            <div
              className="ct-chart-popover"
              style={{
                left: `${Math.min(72, Math.max(12, (roadPts[safeRightIdx].x / W) * 100)).toFixed(2)}%`,
              }}
            >
              <div className="ct-popover-title">{activeRight.label}</div>
              {visibleModes.road ? (
                <div className="ct-popover-row">
                  <span className="ct-popover-key">
                    <i className="ct-popover-ring is-ink" />
                    Road
                  </span>
                  <strong>{activeRight.road}</strong>
                </div>
              ) : null}
              {visibleModes.sea ? (
                <div className="ct-popover-row">
                  <span className="ct-popover-key">
                    <i className="ct-popover-ring is-emerald" />
                    Sea
                  </span>
                  <strong>{activeRight.sea}</strong>
                </div>
              ) : null}
              {visibleModes.air ? (
                <div className="ct-popover-row">
                  <span className="ct-popover-key">
                    <i className="ct-popover-ring is-slate" />
                    Air
                  </span>
                  <strong>{activeRight.air}</strong>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
