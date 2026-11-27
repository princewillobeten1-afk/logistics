"use client";

import { useMemo, useState } from "react";
import { Leaf, Package, Wallet } from "lucide-react";
import {
  summarizeSevenDayPerformance,
  type DailyPerformancePoint,
} from "@/lib/performance-trends";

type MetricKey = "shipments" | "emissions" | "costPerShipment";

function buildSmoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const cx = ((p0.x + p1.x) / 2).toFixed(1);
    d += ` C ${cx} ${p0.y.toFixed(1)}, ${cx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

function niceAxisMax(val: number, integer = false): number {
  if (!Number.isFinite(val) || val <= 0) return integer ? 4 : 10;
  if (integer) {
    if (val <= 4) return 4;
    if (val <= 8) return 8;
    if (val <= 12) return 12;
    if (val <= 20) return 20;
    return Math.ceil(val / 10) * 10;
  }
  const exp = Math.floor(Math.log10(val));
  const base = 10 ** exp;
  const norm = val / base;
  const mult = norm <= 1.2 ? 1.2 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return Math.ceil(mult * base);
}

function currencySymbol(code: string): string {
  return (
    ({ NGN: "₦", USD: "$", EUR: "€", GBP: "£" } as Record<string, string>)[
      code.toUpperCase()
    ] ?? `${code} `
  );
}

function formatCompactCurrency(minor: number, currency: string): string {
  const sym = currencySymbol(currency);
  const major = minor / 100;
  if (major >= 1_000_000) return `${sym}${(major / 1_000_000).toFixed(1)}M`;
  if (major >= 1_000) return `${sym}${Math.round(major / 1_000)}K`;
  return `${sym}${Math.round(major).toLocaleString("en-US")}`;
}

function formatFullCurrency(minor: number, currency: string): string {
  if (minor <= 0) return `${currencySymbol(currency)}0`;
  const sym = currencySymbol(currency);
  const major = minor / 100;
  return `${sym}${major.toLocaleString("en-US", {
    minimumFractionDigits: major < 100 ? 2 : 0,
    maximumFractionDigits: major < 100 ? 2 : 0,
  })}`;
}

function formatKg(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toFixed(2)} t`;
  if (kg === 0) return "0 kg";
  return `${kg.toLocaleString("en-US", { maximumFractionDigits: 1 })} kg`;
}

export function PerformanceTrendChart({
  data,
  currency = "NGN",
}: {
  data: DailyPerformancePoint[];
  currency?: string;
}) {
  const [visible, setVisible] = useState<Record<MetricKey, boolean>>({
    shipments: true,
    emissions: true,
    costPerShipment: true,
  });

  // Default focus to the most recent day with activity, or the last day in the 7-day window
  const defaultIdx = useMemo(() => {
    for (let i = data.length - 1; i >= 0; i -= 1) {
      if (
        data[i].shipments > 0 ||
        data[i].emissionsKg > 0 ||
        data[i].costPerShipmentMinor > 0
      ) {
        return i;
      }
    }
    return Math.max(0, data.length - 1);
  }, [data]);

  const [hoveredIdx, setHoveredIdx] = useState<number>(defaultIdx);

  const summary = useMemo(() => summarizeSevenDayPerformance(data), [data]);

  function toggleMetric(key: MetricKey) {
    setVisible((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.shipments && !next.emissions && !next.costPerShipment) {
        return prev;
      }
      return next;
    });
  }

  const W = 1040;
  const H = 228;
  const PAD_L = 56;
  const PAD_R = 66;
  const PAD_T = 20;
  const PAD_B = 34;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const maxShipments = niceAxisMax(
    Math.max(1, ...data.map((d) => d.shipments)),
    true,
  );
  const maxEmissions = niceAxisMax(
    Math.max(1, ...data.map((d) => d.emissionsKg)),
    false,
  );
  const maxCost = niceAxisMax(
    Math.max(100, ...data.map((d) => d.costPerShipmentMinor)),
    false,
  );

  // Adaptive Y-axis semantics:
  // Left axis = Shipments when visible; otherwise Emissions if visible; otherwise Cost/Shipment.
  const leftAxisMetric: MetricKey = visible.shipments
    ? "shipments"
    : visible.emissions
      ? "emissions"
      : "costPerShipment";

  // Right axis = Cost/Shipment when visible (and not already on left); otherwise Emissions when visible (and not on left).
  const rightAxisMetric: MetricKey | null =
    visible.costPerShipment && leftAxisMetric !== "costPerShipment"
      ? "costPerShipment"
      : visible.emissions && leftAxisMetric !== "emissions"
        ? "emissions"
        : null;

  const colWidth = data.length > 0 ? plotW / data.length : plotW;
  const xAt = (i: number) => PAD_L + colWidth * i + colWidth / 2;
  const yAt = (val: number, maxVal: number) =>
    PAD_T + plotH - (Math.max(0, val) / maxVal) * plotH;

  const barWidth = Math.min(44, Math.max(18, colWidth * 0.34));

  const shipmentBars = data.map((d, i) => {
    const xCenter = xAt(i);
    const yTop = yAt(d.shipments, maxShipments);
    const height = Math.max(0, PAD_T + plotH - yTop);
    return { x: xCenter - barWidth / 2, y: yTop, width: barWidth, height, xCenter };
  });

  const emissionPts = data.map((d, i) => ({
    x: xAt(i),
    y: yAt(d.emissionsKg, maxEmissions),
  }));

  const costPts = data.map((d, i) => ({
    x: xAt(i),
    y: yAt(d.costPerShipmentMinor, maxCost),
  }));

  const safeIdx = Math.min(hoveredIdx, Math.max(0, data.length - 1));
  const activeDay = data[safeIdx];
  const activeX = xAt(safeIdx);

  function formatAxisTick(metric: MetricKey, frac: number): string {
    if (metric === "shipments") return String(Math.round(maxShipments * frac));
    if (metric === "emissions") {
      const v = maxEmissions * frac;
      return v >= 1000 ? `${(v / 1000).toFixed(1)}t` : `${Math.round(v)} kg`;
    }
    return formatCompactCurrency(maxCost * frac, currency);
  }

  const popoverLeftPct = Math.min(76, Math.max(12, (activeX / W) * 100));

  return (
    <section
      className="ct-card ct-chart-card ct-perf-card"
      aria-label="7-Day Operational Performance Trends"
    >
      <div className="ct-chart-head">
        <div className="ct-chart-title-row">
          <div>
            <h2>7-Day Operational Performance</h2>
            <p className="ct-perf-subtitle">
              Daily shipment volume, CO₂e emissions, and average cost per shipment
            </p>
          </div>
        </div>

        <div
          className="ct-mode-toggles"
          role="group"
          aria-label="Toggle performance trend metrics"
        >
          <button
            type="button"
            className="ct-mode-toggle"
            aria-pressed={visible.shipments}
            onClick={() => toggleMetric("shipments")}
          >
            <span className="ct-legend-swatch-bar" aria-hidden="true" />
            <Package size={12} strokeWidth={2} aria-hidden="true" />
            <span>Shipments</span>
          </button>
          <button
            type="button"
            className="ct-mode-toggle"
            aria-pressed={visible.emissions}
            onClick={() => toggleMetric("emissions")}
          >
            <i className="ct-legend-line is-emerald" aria-hidden="true" />
            <Leaf size={12} strokeWidth={2} aria-hidden="true" />
            <span>Emissions (CO₂e)</span>
          </button>
          <button
            type="button"
            className="ct-mode-toggle"
            aria-pressed={visible.costPerShipment}
            onClick={() => toggleMetric("costPerShipment")}
          >
            <i className="ct-legend-line is-amber" aria-hidden="true" />
            <Wallet size={12} strokeWidth={2} aria-hidden="true" />
            <span>Cost / Shipment</span>
          </button>
        </div>
      </div>

      {/* Compact 7-day metric readout strip */}
      <dl className="ct-perf-summary">
        <div>
          <dt>7d Shipments</dt>
          <dd>
            <strong>{summary.totalShipments}</strong>
            <span>last 7 days</span>
          </dd>
        </div>
        <div>
          <dt>7d Emissions</dt>
          <dd>
            <strong>{formatKg(summary.totalEmissionsKg)}</strong>
            <span>
              {summary.totalShipments > 0
                ? `${summary.avgEmissionsPerShipmentKg} kg / load`
                : "CO₂e footprint"}
            </span>
          </dd>
        </div>
        <div>
          <dt>Avg Cost / Shipment</dt>
          <dd>
            <strong>
              {formatFullCurrency(summary.avgCostPerShipmentMinor, currency)}
            </strong>
            <span>
              {summary.totalCostMinor > 0
                ? `${formatCompactCurrency(summary.totalCostMinor, currency)} total`
                : "planned & booked"}
            </span>
          </dd>
        </div>
      </dl>

      <div className="ct-chart-canvas-wrap ct-perf-canvas">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="ct-chart-svg"
          role="img"
          aria-label="7-day combo chart comparing daily shipments, CO2e emissions, and cost per shipment"
        >
          {/* Horizontal grid + adaptive left & right axis ticks */}
          {[0, 0.25, 0.5, 0.75, 1].map((frac, idx) => {
            const y = PAD_T + plotH * (1 - frac);
            return (
              <g key={idx}>
                <line
                  x1={PAD_L}
                  y1={y}
                  x2={W - PAD_R}
                  y2={y}
                  className="ct-grid-line"
                />
                <text
                  x={PAD_L - 10}
                  y={y + 3.5}
                  textAnchor="end"
                  className="ct-axis-text"
                >
                  {formatAxisTick(leftAxisMetric, frac)}
                </text>
                {rightAxisMetric ? (
                  <text
                    x={W - PAD_R + 10}
                    y={y + 3.5}
                    textAnchor="start"
                    className="ct-axis-text"
                  >
                    {formatAxisTick(rightAxisMetric, frac)}
                  </text>
                ) : null}
              </g>
            );
          })}

          {/* Axis unit micro-labels */}
          <text
            x={PAD_L}
            y={12}
            textAnchor="start"
            className="ct-axis-unit"
          >
            {leftAxisMetric === "shipments"
              ? "SHIPMENTS"
              : leftAxisMetric === "emissions"
                ? "EMISSIONS (CO₂e)"
                : `COST / SHIPMENT (${currency})`}
          </text>
          {rightAxisMetric ? (
            <text
              x={W - PAD_R}
              y={12}
              textAnchor="end"
              className="ct-axis-unit"
            >
              {rightAxisMetric === "costPerShipment"
                ? `COST / SHIPMENT (${currency})`
                : "EMISSIONS (CO₂e)"}
            </text>
          ) : null}

          {/* Active vertical crosshair */}
          {summary.hasAnyData && activeDay ? (
            <line
              x1={activeX}
              y1={PAD_T}
              x2={activeX}
              y2={H - PAD_B}
              className="ct-crosshair"
            />
          ) : null}

          {/* Shipments bars */}
          {visible.shipments
            ? shipmentBars.map((bar, i) => {
                const isSelected = summary.hasAnyData && i === safeIdx;
                if (bar.height <= 0) return null;
                return (
                  <rect
                    key={`bar-${data[i].dateIso}`}
                    x={bar.x}
                    y={bar.y}
                    width={bar.width}
                    height={bar.height}
                    rx={4}
                    className={`ct-bar-shipments${isSelected ? " is-selected" : ""}`}
                  />
                );
              })
            : null}

          {/* Emissions smooth line */}
          {visible.emissions ? (
            <path
              d={buildSmoothPath(emissionPts)}
              className="ct-line-emerald"
            />
          ) : null}

          {/* Cost per shipment smooth line */}
          {visible.costPerShipment ? (
            <path d={buildSmoothPath(costPts)} className="ct-line-amber" />
          ) : null}

          {/* Nodes, X-axis date labels, and column hit targets */}
          {data.map((d, i) => {
            const cx = xAt(i);
            const isSelected = summary.hasAnyData && i === safeIdx;
            const ePt = emissionPts[i];
            const cPt = costPts[i];

            return (
              <g key={d.dateIso}>
                <text
                  x={cx}
                  y={H - 14}
                  textAnchor="middle"
                  className={`ct-axis-text${isSelected ? " is-selected" : ""}`}
                >
                  {d.label}
                </text>
                <text
                  x={cx}
                  y={H - 2}
                  textAnchor="middle"
                  className="ct-axis-weekday"
                >
                  {d.weekday}
                </text>

                {visible.emissions ? (
                  <circle
                    cx={ePt.x}
                    cy={ePt.y}
                    r={isSelected ? 4.8 : 3.4}
                    className={`ct-dot-emerald${isSelected ? " is-selected" : ""}`}
                  />
                ) : null}

                {visible.costPerShipment ? (
                  <circle
                    cx={cPt.x}
                    cy={cPt.y}
                    r={isSelected ? 4.8 : 3.4}
                    className={`ct-dot-amber${isSelected ? " is-selected" : ""}`}
                  />
                ) : null}

                <rect
                  x={PAD_L + colWidth * i}
                  y={PAD_T}
                  width={colWidth}
                  height={plotH + PAD_B}
                  fill="transparent"
                  className="ct-hit-zone"
                  tabIndex={0}
                  role="button"
                  aria-label={`${d.weekday} ${d.label}: ${d.shipments} shipments, ${formatKg(d.emissionsKg)} CO2e, average cost ${formatFullCurrency(d.costPerShipmentMinor, currency)}`}
                  onMouseEnter={() => setHoveredIdx(i)}
                  onFocus={() => setHoveredIdx(i)}
                  onClick={() => setHoveredIdx(i)}
                />
              </g>
            );
          })}

          {!summary.hasAnyData ? (
            <text
              x={PAD_L + plotW / 2}
              y={PAD_T + plotH / 2}
              textAnchor="middle"
              className="ct-axis-text"
            >
              No shipments recorded in the last 7 days — create an order to populate trends
            </text>
          ) : null}
        </svg>

        {summary.hasAnyData && activeDay ? (
          <div
            className="ct-chart-popover ct-perf-popover"
            style={{ left: `${popoverLeftPct}%` }}
          >
            <div className="ct-popover-title">
              {activeDay.weekday}, {activeDay.label}
            </div>
            {visible.shipments ? (
              <div className="ct-popover-row">
                <span className="ct-popover-key">
                  <i className="ct-popover-ring is-blue" />
                  Shipments
                </span>
                <strong>{activeDay.shipments}</strong>
              </div>
            ) : null}
            {visible.emissions ? (
              <div className="ct-popover-row">
                <span className="ct-popover-key">
                  <i className="ct-popover-ring is-emerald" />
                  Emissions
                </span>
                <strong>{formatKg(activeDay.emissionsKg)}</strong>
              </div>
            ) : null}
            {visible.costPerShipment ? (
              <div className="ct-popover-row">
                <span className="ct-popover-key">
                  <i className="ct-popover-ring is-amber" />
                  Cost / Shipment
                </span>
                <strong>
                  {formatFullCurrency(activeDay.costPerShipmentMinor, currency)}
                </strong>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
