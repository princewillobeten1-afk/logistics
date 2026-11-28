"use client";

import { useMemo, useState } from "react";
import { formatMoneyMajor } from "@/lib/intelligence/engine";
import type {
  BiChartSpec,
  DataProvenance,
  ForecastSummary,
  TrendForecastPoint,
} from "@/lib/intelligence/types";

type ForecastMetric = "shipments" | "spend" | "co2e" | "unit_cost";

const round2 = (n: number) => Math.round(n * 100) / 100;

const METRIC_META: Record<
  ForecastMetric,
  { label: string; color: string; shortUnit: (currency: string) => string }
> = {
  shipments: {
    label: "Shipments",
    color: "var(--accent)",
    shortUnit: () => "loads",
  },
  spend: {
    label: "Freight Spend",
    color: "#2563eb",
    shortUnit: (c) => c,
  },
  co2e: {
    label: "CO₂e Emissions",
    color: "#0f766e",
    shortUnit: () => "kg",
  },
  unit_cost: {
    label: "Cost / Shipment",
    color: "#b45309",
    shortUnit: (c) => c,
  },
};

export function ProvenanceTag({ provenance }: { provenance: DataProvenance }) {
  const cls =
    provenance === "VERIFIED"
      ? "bi-prov bi-prov-verified"
      : provenance === "ESTIMATE"
        ? "bi-prov bi-prov-estimate"
        : "bi-prov bi-prov-prediction";
  return <span className={cls}>{provenance}</span>;
}

export function BiForecastChart({
  points,
  forecastSummary,
  currency,
}: {
  points: TrendForecastPoint[];
  forecastSummary: ForecastSummary;
  currency: string;
}) {
  const [metric, setMetric] = useState<ForecastMetric>("shipments");
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  const meta = METRIC_META[metric];

  const series = useMemo(() => {
    return points.map((p) => {
      if (metric === "shipments") {
        return {
          point: p,
          val: p.shipments,
          low: p.shipmentsLower ?? p.shipments,
          high: p.shipmentsUpper ?? p.shipments,
        };
      }
      if (metric === "spend") {
        return {
          point: p,
          val: p.freightSpendMajor,
          low: p.freightSpendLower ?? p.freightSpendMajor,
          high: p.freightSpendUpper ?? p.freightSpendMajor,
        };
      }
      if (metric === "co2e") {
        return {
          point: p,
          val: p.co2eKg,
          low: p.co2eLower ?? p.co2eKg,
          high: p.co2eUpper ?? p.co2eKg,
        };
      }
      return {
        point: p,
        val: p.costPerShipmentMajor,
        low: p.costPerShipmentMajor,
        high: p.costPerShipmentMajor,
      };
    });
  }, [points, metric]);

  const width = 760;
  const height = 248;
  const padL = 56;
  const padR = 20;
  const padT = 18;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxVal = Math.max(
    1,
    ...series.map((s) => Math.max(s.val, s.high)),
  ) * 1.12;

  const xOf = (idx: number) =>
    round2(
      series.length <= 1
        ? padL + plotW / 2
        : padL + (idx / (series.length - 1)) * plotW,
    );
  const yOf = (val: number) => round2(padT + plotH - (val / maxVal) * plotH);

  const firstForecastIdx = series.findIndex((s) => s.point.isForecast);
  const splitIdx = firstForecastIdx > 0 ? firstForecastIdx - 1 : -1;

  const actualCoords = series
    .map((s, i) => ({ x: xOf(i), y: yOf(s.val), isForecast: s.point.isForecast }))
    .filter((c) => !c.isForecast);

  const forecastCoords = series
    .map((s, i) => ({
      x: xOf(i),
      y: yOf(s.val),
      yLow: yOf(s.low),
      yHigh: yOf(s.high),
      isForecast: s.point.isForecast,
    }))
    .filter((_, i) => firstForecastIdx >= 0 && i >= Math.max(0, firstForecastIdx - 1));

  const actualPath = actualCoords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");

  const forecastPath = forecastCoords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");

  const confidenceAreaPath =
    forecastCoords.length >= 2 && metric !== "unit_cost"
      ? [
          ...forecastCoords.map(
            (c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.yHigh.toFixed(1)}`,
          ),
          ...[...forecastCoords]
            .reverse()
            .map((c) => `L${c.x.toFixed(1)},${c.yLow.toFixed(1)}`),
          "Z",
        ].join(" ")
      : "";

  const formatVal = (v: number) => {
    if (metric === "spend" || metric === "unit_cost") {
      return formatMoneyMajor(v, currency);
    }
    if (metric === "co2e") {
      return `${v.toFixed(1)} kg`;
    }
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };

  const activePoint =
    activeIdx !== null && series[activeIdx] ? series[activeIdx] : series[series.length - 1];

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    val: maxVal * ratio,
    y: round2(padT + plotH * (1 - ratio)),
  }));

  const labelStep = Math.max(1, Math.ceil(series.length / 7));

  return (
    <div className="bi-forecast-wrap">
      <div className="bi-forecast-toolbar">
        <div className="bi-seg-tabs" role="tablist" aria-label="Forecast metric">
          {(Object.keys(METRIC_META) as ForecastMetric[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={metric === key}
              className={`bi-seg-btn${metric === key ? " is-active" : ""}`}
              onClick={() => setMetric(key)}
            >
              {METRIC_META[key].label}
            </button>
          ))}
        </div>
        <div className="bi-chart-legend" aria-label="Chart provenance legend">
          <span className="bi-legend-item">
            <span className="bi-line-swatch bi-line-solid" style={{ borderColor: meta.color }} />
            Verified actuals
          </span>
          <span className="bi-legend-item">
            <span className="bi-line-swatch bi-line-dashed" style={{ borderColor: meta.color }} />
            7-day forecast (±1σ band)
          </span>
        </div>
      </div>

      {activePoint ? (
        <div className="bi-readout-bar" aria-live="polite">
          <div className="bi-readout-main">
            <strong>{activePoint.point.label}</strong>
            <ProvenanceTag provenance={activePoint.point.provenance} />
            <span className="bi-readout-val">{formatVal(activePoint.val)}</span>
          </div>
          <div className="bi-readout-sub">
            {activePoint.point.isForecast && metric !== "unit_cost" ? (
              <span>
                Confidence range: {formatVal(activePoint.low)} – {formatVal(activePoint.high)}
              </span>
            ) : (
              <span>
                {activePoint.point.shipments} loads ·{" "}
                {formatMoneyMajor(activePoint.point.freightSpendMajor, currency)} spend ·{" "}
                {activePoint.point.co2eKg} kg CO₂e
              </span>
            )}
          </div>
        </div>
      ) : null}

      <div className="bi-svg-frame">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="bi-svg-chart"
          role="img"
          aria-label={`${meta.label} historical trend and 7-day predictive forecast`}
        >
          {yTicks.map((t, idx) => (
            <g key={idx}>
              <line
                x1={padL}
                y1={t.y}
                x2={width - padR}
                y2={t.y}
                stroke="var(--rule)"
                strokeWidth="1"
              />
              <text
                x={padL - 8}
                y={t.y + 4}
                textAnchor="end"
                className="bi-axis-label"
              >
                {metric === "spend" || metric === "unit_cost"
                  ? formatMoneyMajor(t.val, currency)
                  : Math.round(t.val)}
              </text>
            </g>
          ))}

          {splitIdx >= 0 ? (
            <g>
              <rect
                x={xOf(splitIdx)}
                y={padT}
                width={width - padR - xOf(splitIdx)}
                height={plotH}
                fill="var(--accent-soft)"
                opacity="0.22"
              />
              <line
                x1={xOf(splitIdx)}
                y1={padT}
                x2={xOf(splitIdx)}
                y2={padT + plotH}
                stroke="var(--accent)"
                strokeWidth="1"
                strokeDasharray="3 3"
                opacity="0.7"
              />
              <text
                x={xOf(splitIdx) + 6}
                y={padT + 12}
                className="bi-split-label"
              >
                Forecast →
              </text>
            </g>
          ) : null}

          {confidenceAreaPath ? (
            <path d={confidenceAreaPath} fill={meta.color} opacity="0.14" />
          ) : null}

          {actualPath ? (
            <path
              d={actualPath}
              fill="none"
              stroke={meta.color}
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}

          {forecastPath ? (
            <path
              d={forecastPath}
              fill="none"
              stroke={meta.color}
              strokeWidth="2.25"
              strokeDasharray="6 4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}

          {series.map((s, i) => {
            const cx = xOf(i);
            const cy = yOf(s.val);
            const isSelected = activeIdx === i;
            return (
              <g key={s.point.dateIso}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={isSelected ? 5 : 3}
                  fill={s.point.isForecast ? "var(--surface)" : meta.color}
                  stroke={meta.color}
                  strokeWidth="2"
                />
                <rect
                  x={round2(cx - Math.max(8, plotW / Math.max(1, series.length) / 2))}
                  y={padT}
                  width={round2(Math.max(16, plotW / Math.max(1, series.length)))}
                  height={plotH}
                  fill="transparent"
                  className="bi-hit-target"
                  tabIndex={0}
                  aria-label={`${s.point.label}: ${formatVal(s.val)} (${s.point.provenance})`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onFocus={() => setActiveIdx(i)}
                />
                {i % labelStep === 0 || i === series.length - 1 ? (
                  <text
                    x={cx}
                    y={height - 10}
                    textAnchor="middle"
                    className="bi-axis-label"
                  >
                    {s.point.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="bi-forecast-footer">
        <div className="bi-forecast-pill-group">
          <span>
            <strong>Next {forecastSummary.horizonDays}d Volume:</strong>{" "}
            {forecastSummary.projectedShipments} loads ({forecastSummary.projectedShipmentsRange[0]}–
            {forecastSummary.projectedShipmentsRange[1]})
          </span>
          <span>
            <strong>Projected Spend:</strong>{" "}
            {formatMoneyMajor(forecastSummary.projectedSpendMajor, currency)}
          </span>
          <span>
            <strong>Confidence:</strong> {forecastSummary.confidenceLevel}
          </span>
        </div>
        <p className="bi-methodology-inline">{forecastSummary.methodology}</p>
      </div>
    </div>
  );
}

function formatCompactNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(v / 1_000).toFixed(1)}k`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function BiDynamicChart({ chart }: { chart: BiChartSpec }) {
  if (!chart.points || chart.points.length === 0) return null;
  const maxVal = Math.max(1, ...chart.points.map((p) => Math.abs(p.value)));

  if (chart.type === "line") {
    const w = 540;
    const h = 196;
    const padL = 44;
    const padR = 40;
    const padT = 24;
    const padB = 30;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const pts = chart.points.map((p, i) => ({
      ...p,
      x: round2(
        chart.points.length <= 1
          ? padL + plotW / 2
          : padL + (i / (chart.points.length - 1)) * plotW,
      ),
      y: round2(padT + plotH - (Math.max(0, p.value) / (maxVal * 1.15)) * plotH),
    }));
    const d = pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" ");
    const areaD =
      pts.length >= 2
        ? `${d} L${pts[pts.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)} L${pts[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} Z`
        : "";

    return (
      <div className="bi-dyn-chart">
        <div className="bi-dyn-chart-head">
          <h4>{chart.title}</h4>
          <ProvenanceTag provenance={chart.provenance} />
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} className="bi-svg-chart" role="img" aria-label={chart.title}>
          {[0, 0.5, 1].map((r, idx) => {
            const y = round2(padT + plotH * (1 - r));
            return (
              <line
                key={idx}
                x1={padL}
                y1={y}
                x2={w - padR}
                y2={y}
                stroke="var(--rule)"
                strokeWidth="1"
              />
            );
          })}
          {areaD ? <path d={areaD} fill="var(--accent)" opacity="0.1" /> : null}
          <path
            d={d}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.25"
            strokeDasharray={chart.provenance === "PREDICTION" ? "5 4" : undefined}
          />
          {pts.map((p, idx) => (
            <g key={idx}>
              <circle cx={p.x} cy={p.y} r="3.5" fill="var(--accent)" />
              <text x={p.x} y={p.y - 9} textAnchor="middle" className="bi-axis-label">
                {formatCompactNumber(p.value)}
              </text>
              <text x={p.x} y={h - 9} textAnchor="middle" className="bi-axis-label">
                {p.label.slice(0, 10)}
              </text>
            </g>
          ))}
        </svg>
      </div>
    );
  }

  // Horizontal bar (cleanest for comparing corridors, branches, customers, departments)
  return (
    <div className="bi-dyn-chart">
      <div className="bi-dyn-chart-head">
        <h4>{chart.title}</h4>
        <ProvenanceTag provenance={chart.provenance} />
      </div>
      <div className="bi-hbar-list">
        {chart.points.map((pt, idx) => {
          const pct = Math.max(4, Math.min(100, (Math.abs(pt.value) / maxVal) * 100)).toFixed(2);
          return (
            <div key={`${pt.label}-${idx}`} className="bi-hbar-row">
              <div className="bi-hbar-meta">
                <span className="bi-hbar-label">{pt.label}</span>
                <span className="bi-hbar-val">
                  {formatCompactNumber(pt.value)}
                  {chart.unit ? ` ${chart.unit}` : ""}
                </span>
              </div>
              <div className="bi-hbar-track">
                <div className="bi-hbar-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
