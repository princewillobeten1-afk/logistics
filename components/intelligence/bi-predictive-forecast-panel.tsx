"use client";

import { useMemo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CalendarRange,
  Download,
  Info,
  Lock,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { ProvenanceTag } from "@/components/intelligence/bi-charts";
import { formatMoneyMajor } from "@/lib/intelligence/engine";
import type {
  Forecast30dPoint,
  Forecast30dWeeklyBucket,
  PredictiveForecast30d,
} from "@/lib/intelligence/types";

type ChartView = "combined" | "volume" | "cost" | "weekly";
type HistoryWindow = "14d" | "30d" | "forecast_only";

function formatShortAxisMoney(value: number, currency: string): string {
  return formatMoneyMajor(value, currency);
}

function escapeCsvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

interface CustomTooltipPayloadItem {
  name?: string;
  value?: number | null;
  color?: string;
  dataKey?: string;
  payload?: Forecast30dPoint;
}

function DailyForecastTooltip({
  active,
  payload,
  label,
  currency,
  costRedacted,
}: {
  active?: boolean;
  payload?: CustomTooltipPayloadItem[];
  label?: string;
  currency: string;
  costRedacted: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const pt = payload[0]?.payload;
  if (!pt) return null;

  return (
    <div className="bi-recharts-tooltip">
      <div className="bi-tooltip-head">
        <strong>{label}</strong>
        <ProvenanceTag provenance={pt.provenance} />
      </div>
      <div className="bi-tooltip-rows">
        {!pt.isForecast ? (
          <>
            <div className="bi-tooltip-row">
              <span>Verified Shipments</span>
              <strong>{pt.actualShipments ?? 0} loads</strong>
            </div>
            {!costRedacted ? (
              <div className="bi-tooltip-row">
                <span>Verified Carrier Spend</span>
                <strong>{formatMoneyMajor(pt.actualCarrierCostMajor ?? 0, currency)}</strong>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="bi-tooltip-row">
              <span>Projected Shipments</span>
              <strong>{pt.projectedShipments ?? 0} loads</strong>
            </div>
            <div className="bi-tooltip-sub">
              ±1σ range: {pt.shipmentsLower ?? 0} – {pt.shipmentsUpper ?? 0} loads
            </div>
            {!costRedacted ? (
              <>
                <div className="bi-tooltip-row">
                  <span>Projected Carrier Cost</span>
                  <strong>
                    {formatMoneyMajor(pt.projectedCarrierCostMajor ?? 0, currency)}
                  </strong>
                </div>
                <div className="bi-tooltip-sub">
                  ±1σ budget: {formatMoneyMajor(pt.carrierCostLower ?? 0, currency)} –{" "}
                  {formatMoneyMajor(pt.carrierCostUpper ?? 0, currency)}
                </div>
                {pt.cumulativeProjectedCostMajor !== null ? (
                  <div className="bi-tooltip-row bi-tooltip-cum">
                    <span>Cumulative 30d Budget</span>
                    <strong>
                      {formatMoneyMajor(pt.cumulativeProjectedCostMajor, currency)}
                    </strong>
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

interface WeeklyTooltipItem {
  payload?: Forecast30dWeeklyBucket;
}

function WeeklyForecastTooltip({
  active,
  payload,
  currency,
  costRedacted,
}: {
  active?: boolean;
  payload?: WeeklyTooltipItem[];
  currency: string;
  costRedacted: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const wk = payload[0]?.payload;
  if (!wk) return null;

  return (
    <div className="bi-recharts-tooltip">
      <div className="bi-tooltip-head">
        <strong>
          {wk.weekLabel} · {wk.dateRangeLabel}
        </strong>
        <ProvenanceTag provenance="PREDICTION" />
      </div>
      <div className="bi-tooltip-rows">
        <div className="bi-tooltip-row">
          <span>Projected Volume</span>
          <strong>{wk.projectedShipments} loads</strong>
        </div>
        <div className="bi-tooltip-sub">
          ±1σ range: {wk.shipmentsLower} – {wk.shipmentsUpper} loads
        </div>
        {!costRedacted ? (
          <>
            <div className="bi-tooltip-row">
              <span>Carrier Cost Requirement</span>
              <strong>{formatMoneyMajor(wk.projectedCarrierCostMajor, currency)}</strong>
            </div>
            <div className="bi-tooltip-sub">
              Budget band: {formatMoneyMajor(wk.carrierCostLower, currency)} –{" "}
              {formatMoneyMajor(wk.carrierCostUpper, currency)}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function BiPredictiveForecastPanel({
  forecast,
  currency,
  orgName,
  onAskAiForecast,
}: {
  forecast: PredictiveForecast30d;
  currency: string;
  orgName: string;
  onAskAiForecast: (question: string) => void;
}) {
  const costRedacted = Boolean(forecast.carrierCostRedacted);
  const [view, setView] = useState<ChartView>(costRedacted ? "volume" : "combined");
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>("14d");
  const [showMethod, setShowMethod] = useState(false);

  const visibleDaily = useMemo(() => {
    if (historyWindow === "forecast_only") {
      return forecast.dailySeries.filter((p) => p.isForecast);
    }
    if (historyWindow === "14d") {
      return forecast.dailySeries.filter((p) => p.dayIndex >= -13);
    }
    return forecast.dailySeries;
  }, [forecast.dailySeries, historyWindow]);

  const exportCsv = () => {
    const headers = [
      "Date",
      "Label",
      "Provenance",
      "Verified Shipments",
      "Projected Shipments",
      "Shipments Lower",
      "Shipments Upper",
      ...(costRedacted
        ? []
        : [
            `Verified Carrier Cost (${currency})`,
            `Projected Carrier Cost (${currency})`,
            `Carrier Cost Lower (${currency})`,
            `Carrier Cost Upper (${currency})`,
            `Cumulative 30D Cost (${currency})`,
          ]),
    ];

    const rows = forecast.dailySeries.map((pt) => [
      pt.dateIso,
      pt.label,
      pt.provenance,
      pt.actualShipments !== null ? String(pt.actualShipments) : "",
      pt.projectedShipments !== null ? String(pt.projectedShipments) : "",
      pt.shipmentsLower !== null ? String(pt.shipmentsLower) : "",
      pt.shipmentsUpper !== null ? String(pt.shipmentsUpper) : "",
      ...(costRedacted
        ? []
        : [
            pt.actualCarrierCostMajor !== null ? String(pt.actualCarrierCostMajor) : "",
            pt.projectedCarrierCostMajor !== null
              ? String(pt.projectedCarrierCostMajor)
              : "",
            pt.carrierCostLower !== null ? String(pt.carrierCostLower) : "",
            pt.carrierCostUpper !== null ? String(pt.carrierCostUpper) : "",
            pt.cumulativeProjectedCostMajor !== null
              ? String(pt.cumulativeProjectedCostMajor)
              : "",
          ]),
    ]);

    const csv = [
      headers.map(escapeCsvCell).join(","),
      ...rows.map((r) => r.map(escapeCsvCell).join(",")),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-30d-predictive-forecast.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const activeView: ChartView = costRedacted && view === "cost" ? "volume" : view;

  return (
    <section
      className="bi-panel bi-pf-section"
      aria-labelledby="bi-predictive-forecast-heading"
    >
      <div className="bi-panel-head">
        <div className="bi-panel-title-group">
          <div className="bi-title-with-icon">
            <TrendingUp
              size={17}
              strokeWidth={2}
              className="bi-title-icon"
              aria-hidden="true"
            />
            <h2 id="bi-predictive-forecast-heading">
              Predictive Forecast · Next 30 Days
            </h2>
            <ProvenanceTag provenance="PREDICTION" />
          </div>
          <p className="bi-panel-sub">
            Projects future shipment volume and carrier cost requirements over the next 30
            days from verified historical trends, with widening ±1σ confidence bands and
            weekly carrier budget rollups.
          </p>
        </div>

        <div className="bi-pf-head-actions">
          <button
            type="button"
            className="bi-btn-ghost"
            onClick={() =>
              onAskAiForecast(
                "Analyze our 30-day predictive forecast for shipment volume and carrier cost requirements, highlight peak weeks, and recommend carrier capacity and working capital actions.",
              )
            }
          >
            <Sparkles size={14} aria-hidden="true" />
            <span>Analyze Forecast</span>
          </button>
          <button
            type="button"
            className="bi-btn-outline"
            onClick={exportCsv}
          >
            <Download size={14} aria-hidden="true" />
            <span>Export 30d CSV</span>
          </button>
        </div>
      </div>

      {/* 30-Day Executive Forecast KPI Summary Strip */}
      <div className="bi-pf-kpis">
        <div className="bi-pf-kpi">
          <span className="bi-pf-kpi-label">Projected 30-Day Volume</span>
          <strong className="bi-pf-kpi-val">
            {forecast.totalProjectedShipments.toLocaleString("en-US")} loads
          </strong>
          <span className="bi-pf-kpi-sub">
            ±1σ band: {forecast.projectedShipmentsRange[0]}–{forecast.projectedShipmentsRange[1]} ·
            slope {forecast.dailyShipmentSlope >= 0 ? "+" : ""}
            {forecast.dailyShipmentSlope}/day
          </span>
        </div>

        <div className="bi-pf-kpi">
          <span className="bi-pf-kpi-label">30-Day Carrier Cost Requirement</span>
          <strong className={`bi-pf-kpi-val${costRedacted ? " is-redacted" : ""}`}>
            {costRedacted
              ? "Restricted"
              : formatMoneyMajor(forecast.totalProjectedCarrierCostMajor, currency)}
          </strong>
          <span className="bi-pf-kpi-sub">
            {costRedacted
              ? "Approver or Admin role required"
              : `Upper reserve: ${formatMoneyMajor(forecast.projectedCarrierCostRange[1], currency)}`}
          </span>
        </div>

        <div className="bi-pf-kpi">
          <span className="bi-pf-kpi-label">Projected Unit Carrier Rate</span>
          <strong className={`bi-pf-kpi-val${costRedacted ? " is-redacted" : ""}`}>
            {costRedacted
              ? "Restricted"
              : forecast.projectedAvgCostPerShipmentMajor > 0
                ? `${formatMoneyMajor(forecast.projectedAvgCostPerShipmentMajor, currency)} / load`
                : "—"}
          </strong>
          <span className="bi-pf-kpi-sub">
            Peak day: {forecast.peakDayLabel} ({forecast.peakDayShipments} loads)
          </span>
        </div>

        <div className="bi-pf-kpi">
          <span className="bi-pf-kpi-label">Model Confidence</span>
          <strong className="bi-pf-kpi-val">{forecast.confidenceLevel}</strong>
          <span className="bi-pf-kpi-sub">
            Trained on trailing {forecast.historicalDaysUsed}d verified data
          </span>
        </div>
      </div>

      {costRedacted ? (
        <div className="bi-access-note">
          <Lock size={14} aria-hidden="true" />
          <span>
            Carrier cost budget projections are redacted for your role; shipment volume
            forecasts remain available for operational planning.
          </span>
        </div>
      ) : null}

      {/* Recharts View & Window Controls */}
      <div className="bi-pf-controls">
        <div
          className="bi-seg-tabs"
          role="tablist"
          aria-label="Predictive forecast visualization view"
        >
          {!costRedacted ? (
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "combined"}
              className={`bi-seg-btn${activeView === "combined" ? " is-active" : ""}`}
              onClick={() => setView("combined")}
            >
              Volume &amp; Carrier Cost
            </button>
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "volume"}
            className={`bi-seg-btn${activeView === "volume" ? " is-active" : ""}`}
            onClick={() => setView("volume")}
          >
            Shipment Volume (±1σ)
          </button>
          {!costRedacted ? (
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "cost"}
              className={`bi-seg-btn${activeView === "cost" ? " is-active" : ""}`}
              onClick={() => setView("cost")}
            >
              Carrier Cost Budget (±1σ)
            </button>
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "weekly"}
            className={`bi-seg-btn${activeView === "weekly" ? " is-active" : ""}`}
            onClick={() => setView("weekly")}
          >
            Weekly Rollup (4 Wks)
          </button>
        </div>

        {activeView !== "weekly" ? (
          <div
            className="bi-seg-tabs"
            role="group"
            aria-label="Historical context window"
          >
            <CalendarRange size={13} className="bi-period-icon" aria-hidden="true" />
            {(
              [
                ["14d", "14D History + 30D"],
                ["30d", "30D History + 30D"],
                ["forecast_only", "Next 30D Only"],
              ] as [HistoryWindow, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`bi-seg-btn${historyWindow === key ? " is-active" : ""}`}
                onClick={() => setHistoryWindow(key)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Recharts Interactive Chart Surface */}
      <div
        className="bi-recharts-box"
        role="img"
        aria-label="30-day predictive forecast chart for shipment volume and carrier cost requirements"
      >
        <ResponsiveContainer width="100%" height={330}>
          {activeView === "weekly" ? (
            <ComposedChart
              data={forecast.weeklyRollup}
              margin={{ top: 14, right: 16, left: 4, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--rule)" vertical={false} />
              <XAxis
                dataKey="weekLabel"
                tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
                axisLine={{ stroke: "var(--rule)" }}
                tickLine={false}
              />
              <YAxis
                yAxisId="left"
                allowDecimals={false}
                tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={38}
              />
              {!costRedacted ? (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={68}
                  tickFormatter={(v: number) => formatShortAxisMoney(v, currency)}
                />
              ) : null}
              <Tooltip
                content={
                  <WeeklyForecastTooltip
                    currency={currency}
                    costRedacted={costRedacted}
                  />
                }
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              <Bar
                yAxisId="left"
                dataKey="projectedShipments"
                name="Projected Shipments (loads)"
                fill="#0d6b63"
                radius={[5, 5, 0, 0]}
                maxBarSize={46}
                isAnimationActive={false}
              />
              {!costRedacted ? (
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="projectedCarrierCostMajor"
                  name={`Carrier Cost Requirement (${currency})`}
                  stroke="#2563eb"
                  strokeWidth={2.5}
                  dot={{ r: 4, fill: "#ffffff", stroke: "#2563eb", strokeWidth: 2 }}
                  activeDot={{ r: 6 }}
                  isAnimationActive={false}
                />
              ) : null}
            </ComposedChart>
          ) : activeView === "combined" ? (
            <ComposedChart
              data={visibleDaily}
              margin={{ top: 18, right: 14, left: 2, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--rule)" vertical={false} />
              <XAxis
                dataKey="label"
                minTickGap={28}
                tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
                axisLine={{ stroke: "var(--rule)" }}
                tickLine={false}
              />
              <YAxis
                yAxisId="left"
                allowDecimals={false}
                tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={34}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={66}
                tickFormatter={(v: number) => formatShortAxisMoney(v, currency)}
              />
              <Tooltip
                content={
                  <DailyForecastTooltip
                    currency={currency}
                    costRedacted={costRedacted}
                  />
                }
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              {historyWindow !== "forecast_only" ? (
                <ReferenceLine
                  yAxisId="left"
                  x={forecast.todayLabel}
                  stroke="#0d6b63"
                  strokeDasharray="4 4"
                  label={{
                    value: "30D Forecast →",
                    position: "insideTopLeft",
                    dx: 6,
                    fill: "#0d6b63",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                />
              ) : null}
              <Bar
                yAxisId="left"
                dataKey="actualShipments"
                name="Verified Shipments"
                fill="#0d6b63"
                fillOpacity={0.82}
                radius={[3, 3, 0, 0]}
                maxBarSize={14}
                isAnimationActive={false}
              />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="projectedShipments"
                name="Projected Shipments (30D)"
                stroke="#0d6b63"
                strokeWidth={2.25}
                strokeDasharray="5 4"
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
              <Area
                yAxisId="right"
                type="monotone"
                dataKey="actualCarrierCostMajor"
                name={`Verified Carrier Cost (${currency})`}
                stroke="#2563eb"
                fill="#2563eb"
                fillOpacity={0.12}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="projectedCarrierCostMajor"
                name={`Projected Carrier Cost (${currency})`}
                stroke="#2563eb"
                strokeWidth={2.25}
                strokeDasharray="6 4"
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            </ComposedChart>
          ) : activeView === "volume" ? (
            <ComposedChart
              data={visibleDaily}
              margin={{ top: 18, right: 16, left: 4, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--rule)" vertical={false} />
              <XAxis
                dataKey="label"
                minTickGap={28}
                tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
                axisLine={{ stroke: "var(--rule)" }}
                tickLine={false}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={38}
              />
              <Tooltip
                content={
                  <DailyForecastTooltip
                    currency={currency}
                    costRedacted={costRedacted}
                  />
                }
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              {historyWindow !== "forecast_only" ? (
                <ReferenceLine
                  x={forecast.todayLabel}
                  stroke="#0d6b63"
                  strokeDasharray="4 4"
                  label={{
                    value: "30D Forecast →",
                    position: "insideTopLeft",
                    dx: 6,
                    fill: "#0d6b63",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                />
              ) : null}
              <Area
                type="monotone"
                dataKey="shipmentsBandBase"
                stackId="volBand"
                stroke="none"
                fill="transparent"
                legendType="none"
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="shipmentsBandSpan"
                stackId="volBand"
                name="±1σ Confidence Band"
                legendType="square"
                stroke="none"
                fill="#0d6b63"
                fillOpacity={0.16}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="actualShipments"
                name="Verified Shipments"
                stroke="#0d6b63"
                strokeWidth={2.4}
                dot={{ r: 2.5 }}
                connectNulls
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="projectedShipments"
                name="Projected Shipments (30D)"
                stroke="#0d6b63"
                strokeWidth={2.4}
                strokeDasharray="6 4"
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            </ComposedChart>
          ) : (
            <ComposedChart
              data={visibleDaily}
              margin={{ top: 18, right: 16, left: 6, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--rule)" vertical={false} />
              <XAxis
                dataKey="label"
                minTickGap={28}
                tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
                axisLine={{ stroke: "var(--rule)" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={66}
                tickFormatter={(v: number) => formatShortAxisMoney(v, currency)}
              />
              <Tooltip
                content={
                  <DailyForecastTooltip
                    currency={currency}
                    costRedacted={costRedacted}
                  />
                }
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
              {historyWindow !== "forecast_only" ? (
                <ReferenceLine
                  x={forecast.todayLabel}
                  stroke="#2563eb"
                  strokeDasharray="4 4"
                  label={{
                    value: "30D Forecast →",
                    position: "insideTopLeft",
                    dx: 6,
                    fill: "#2563eb",
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                />
              ) : null}
              <Area
                type="monotone"
                dataKey="carrierCostBandBase"
                stackId="costBand"
                stroke="none"
                fill="transparent"
                legendType="none"
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="carrierCostBandSpan"
                stackId="costBand"
                name="±1σ Budget Band"
                legendType="square"
                stroke="none"
                fill="#2563eb"
                fillOpacity={0.16}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="actualCarrierCostMajor"
                name={`Verified Carrier Spend (${currency})`}
                stroke="#2563eb"
                strokeWidth={2.4}
                dot={{ r: 2.5 }}
                connectNulls
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="projectedCarrierCostMajor"
                name={`Projected Carrier Spend (${currency})`}
                stroke="#2563eb"
                strokeWidth={2.4}
                strokeDasharray="6 4"
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            </ComposedChart>
          )}
        </ResponsiveContainer>
      </div>

      {/* Weekly Carrier Budget & Transport Mode Capacity Breakdown */}
      <div className="bi-pf-bottom-grid">
        <div className="bi-pf-subcard">
          <div className="bi-dyn-chart-head">
            <h4>30-Day Weekly Capacity &amp; Carrier Budget Plan</h4>
            <ProvenanceTag provenance="PREDICTION" />
          </div>
          <div className="scroller" tabIndex={0} role="region" aria-label="Weekly forecast breakdown">
            <table className="bi-table">
              <thead>
                <tr>
                  <th scope="col">Window</th>
                  <th scope="col" className="num">
                    Projected Volume
                  </th>
                  <th scope="col" className="num">
                    Range (±1σ)
                  </th>
                  <th scope="col" className="num">
                    Carrier Cost Req.
                  </th>
                </tr>
              </thead>
              <tbody>
                {forecast.weeklyRollup.map((wk) => (
                  <tr key={wk.weekLabel}>
                    <td>
                      <div className="bi-entity-cell">
                        <strong>{wk.weekLabel}</strong>
                        <span>{wk.dateRangeLabel}</span>
                      </div>
                    </td>
                    <td className="num bi-num-strong">{wk.projectedShipments} loads</td>
                    <td className="num">
                      {wk.shipmentsLower}–{wk.shipmentsUpper}
                    </td>
                    <td className="num bi-num-strong">
                      {costRedacted
                        ? "Restricted"
                        : formatMoneyMajor(wk.projectedCarrierCostMajor, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bi-pf-subcard">
          <div className="bi-dyn-chart-head">
            <h4>Projected 30-Day Carrier Capacity Mix by Mode</h4>
            <ProvenanceTag provenance="PREDICTION" />
          </div>
          {forecast.modeAllocation.length === 0 ? (
            <p className="bi-panel-sub">
              Mode breakdown will populate automatically as historical shipments accumulate.
            </p>
          ) : (
            <div className="bi-hbar-list">
              {forecast.modeAllocation.map((m) => (
                <div key={m.mode} className="bi-hbar-row">
                  <div className="bi-hbar-meta">
                    <span className="bi-hbar-label">
                      <strong>{m.mode}</strong> · {m.sharePct}% share ({m.projectedShipments} loads)
                    </span>
                    <span className="bi-hbar-val">
                      {costRedacted
                        ? "Cost restricted"
                        : formatMoneyMajor(m.projectedCarrierCostMajor, currency)}
                    </span>
                  </div>
                  <div className="bi-hbar-track">
                    <div
                      className="bi-hbar-fill"
                      style={{ width: `${Math.max(5, Math.min(100, m.sharePct))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="bi-pf-method-toggle">
            <button
              type="button"
              className="bi-btn-ghost"
              onClick={() => setShowMethod((v) => !v)}
            >
              <Info size={14} aria-hidden="true" />
              <span>{showMethod ? "Hide forecast methodology" : "How 30-day forecast is calculated"}</span>
            </button>
            {showMethod ? (
              <p className="bi-formula-box">{forecast.methodology}</p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
