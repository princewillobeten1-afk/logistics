"use client";

import { useMemo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  buildWarehouseInventoryTrend,
  type DailyWarehouseInventoryPoint,
  type WarehouseTrendInventoryInput,
  type WarehouseTrendShipmentInput,
  type WarehouseTrendWarehouseInput,
} from "@/lib/warehouse-trends";

type WindowOption = 30 | 14 | 7;
type ChartMode = "comparison" | "flow";

interface TooltipEntry {
  payload?: DailyWarehouseInventoryPoint;
}

function InventoryTrendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const pt = payload[0]?.payload;
  if (!pt) return null;

  return (
    <div className="bi-recharts-tooltip">
      <div className="bi-tooltip-head">
        <strong>
          {pt.weekday}, {pt.label}
        </strong>
        <span className="wh-tooltip-tag">
          {pt.isToday ? "Live balance" : "30d trend"}
        </span>
      </div>
      <div className="bi-tooltip-rows">
        <div className="bi-tooltip-row">
          <span>On-hand inventory</span>
          <strong>{pt.onHand.toLocaleString("en-US")} units</strong>
        </div>
        <div className="bi-tooltip-row">
          <span>Reserved stock</span>
          <strong>{pt.reserved.toLocaleString("en-US")} units</strong>
        </div>
        <div className="bi-tooltip-row">
          <span>Available buffer</span>
          <strong>{pt.available.toLocaleString("en-US")} units</strong>
        </div>
        <div className="bi-tooltip-row">
          <span>Reservation share</span>
          <strong>{pt.utilizationPct}%</strong>
        </div>
        <div className="bi-tooltip-row bi-tooltip-cum">
          <span>Daily new reservations</span>
          <strong>+{pt.newReservations.toLocaleString("en-US")} units</strong>
        </div>
      </div>
    </div>
  );
}

function formatDelta(pct: number): string {
  if (pct > 0) return `+${pct}% vs 30d ago`;
  if (pct < 0) return `${pct}% vs 30d ago`;
  return "Flat vs 30d ago";
}

export function InventoryReservationChart({
  warehouses,
  inventory,
  shipments,
  generatedAtIso,
}: {
  warehouses: WarehouseTrendWarehouseInput[];
  inventory: WarehouseTrendInventoryInput[];
  shipments: WarehouseTrendShipmentInput[];
  generatedAtIso: string;
}) {
  const [selectedSite, setSelectedSite] = useState<string>("ALL");
  const [windowDays, setWindowDays] = useState<WindowOption>(30);
  const [chartMode, setChartMode] = useState<ChartMode>("comparison");

  const siteOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of warehouses) {
      map.set(w.code.toUpperCase(), `${w.code} · ${w.name}`);
    }
    for (const inv of inventory) {
      const code = inv.warehouse.toUpperCase();
      if (!map.has(code)) {
        map.set(code, code);
      }
    }
    return Array.from(map.entries()).map(([code, label]) => ({ code, label }));
  }, [warehouses, inventory]);

  const trend = useMemo(
    () =>
      buildWarehouseInventoryTrend({
        inventory,
        shipments,
        warehouseCode: selectedSite,
        now: new Date(generatedAtIso),
        days: 30,
      }),
    [inventory, shipments, selectedSite, generatedAtIso],
  );

  const visibleSeries = useMemo(
    () => trend.series.slice(-windowDays),
    [trend.series, windowDays],
  );

  if (!trend.summary.hasInventoryData) {
    return (
      <div className="wh-trend-empty">
        <strong>No warehouse stock balances recorded yet.</strong>
        <p>
          Once warehouse SKUs and on-hand stock levels are added, this chart compares daily
          on-hand inventory against shipment reservation demand over the trailing 30 days.
        </p>
      </div>
    );
  }

  const { summary } = trend;

  return (
    <div className="wh-trend-wrap">
      <div className="wh-trend-controls">
        <div className="wh-trend-control-group">
          <div
            className="bi-seg"
            role="group"
            aria-label="Chart comparison mode"
          >
            <button
              type="button"
              className={`bi-seg-btn ${chartMode === "comparison" ? "is-active" : ""}`}
              onClick={() => setChartMode("comparison")}
            >
              On-hand vs. reserved
            </button>
            <button
              type="button"
              className={`bi-seg-btn ${chartMode === "flow" ? "is-active" : ""}`}
              onClick={() => setChartMode("flow")}
            >
              Daily reservation flow
            </button>
          </div>

          <div className="bi-seg" role="group" aria-label="Time window">
            {([30, 14, 7] as WindowOption[]).map((d) => (
              <button
                key={d}
                type="button"
                className={`bi-seg-btn ${windowDays === d ? "is-active" : ""}`}
                onClick={() => setWindowDays(d)}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {siteOptions.length > 1 ? (
          <label className="wh-site-filter">
            <span>Site</span>
            <select
              aria-label="Filter chart by warehouse site"
              value={selectedSite}
              onChange={(e) => setSelectedSite(e.target.value)}
            >
              <option value="ALL">All sites ({siteOptions.length})</option>
              {siteOptions.map((site) => (
                <option key={site.code} value={site.code}>
                  {site.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="wh-trend-kpis">
        <div className="wh-trend-kpi">
          <span className="wh-trend-kpi-label">On-hand inventory</span>
          <strong className="wh-trend-kpi-val">
            {summary.currentOnHand.toLocaleString("en-US")} units
          </strong>
          <span className="wh-trend-kpi-sub">
            30d avg {summary.avgOnHand.toLocaleString("en-US")} ·{" "}
            {formatDelta(summary.onHandDeltaPct)}
          </span>
        </div>

        <div className="wh-trend-kpi">
          <span className="wh-trend-kpi-label">Reserved stock</span>
          <strong className="wh-trend-kpi-val wh-val-warn">
            {summary.currentReserved.toLocaleString("en-US")} units
          </strong>
          <span className="wh-trend-kpi-sub">
            30d avg {summary.avgReserved.toLocaleString("en-US")} ·{" "}
            {formatDelta(summary.reservedDeltaPct)}
          </span>
        </div>

        <div className="wh-trend-kpi">
          <span className="wh-trend-kpi-label">Peak 30d reservations</span>
          <strong className="wh-trend-kpi-val">
            {summary.peakReserved.toLocaleString("en-US")} units
          </strong>
          <span className="wh-trend-kpi-sub">
            Peaked on {summary.peakReservedLabel}
          </span>
        </div>

        <div className="wh-trend-kpi">
          <span className="wh-trend-kpi-label">Reservation utilisation</span>
          <strong
            className={`wh-trend-kpi-val ${
              summary.currentUtilizationPct >= 70 ? "wh-val-warn" : "wh-val-good"
            }`}
          >
            {summary.currentUtilizationPct}%
          </strong>
          <span className="wh-trend-kpi-sub">
            {summary.daysAboveStrainThreshold} of 30 days ≥ 70% strain
          </span>
        </div>
      </div>

      <div className="wh-trend-legend" aria-label="Chart legend">
        <span className="wh-legend-item">
          <span className="wh-swatch wh-swatch-onhand" aria-hidden="true" />
          On-hand inventory (units)
        </span>
        <span className="wh-legend-item">
          <span className="wh-swatch wh-swatch-reserved" aria-hidden="true" />
          Reserved stock (units)
        </span>
        {chartMode === "comparison" ? (
          <span className="wh-legend-item">
            <span className="wh-swatch wh-swatch-util" aria-hidden="true" />
            Reservation utilisation (%)
          </span>
        ) : (
          <span className="wh-legend-item">
            <span className="wh-swatch wh-swatch-flow" aria-hidden="true" />
            Daily new reservations (right axis)
          </span>
        )}
      </div>

      <div
        className="bi-recharts-box wh-recharts-box"
        role="img"
        aria-label={`On-hand inventory versus reservation trend over the last ${windowDays} days`}
      >
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart
            data={visibleSeries}
            margin={{ top: 10, right: 16, left: 4, bottom: 4 }}
          >
            <defs>
              <linearGradient id="whOnHandFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#0d6b63" stopOpacity={0.22} />
                <stop offset="95%" stopColor="#0d6b63" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="whReservedFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#d97706" stopOpacity={0.24} />
                <stop offset="95%" stopColor="#d97706" stopOpacity={0.03} />
              </linearGradient>
            </defs>

            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--rule)"
              vertical={false}
            />
            <XAxis
              dataKey="label"
              tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--rule)" }}
              minTickGap={22}
            />
            <YAxis
              yAxisId="units"
              tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={52}
              tickFormatter={(v: number) =>
                v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
              }
            />
            {chartMode === "comparison" ? (
              <YAxis
                yAxisId="pct"
                orientation="right"
                domain={[0, 100]}
                tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={44}
                tickFormatter={(v: number) => `${v}%`}
              />
            ) : (
              <YAxis
                yAxisId="daily"
                orientation="right"
                tick={{ fill: "var(--ink-faint)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={44}
                tickFormatter={(v: number) => `+${v}`}
              />
            )}

            <Tooltip content={<InventoryTrendTooltip />} />

            {chartMode === "comparison" ? (
              <>
                <ReferenceLine
                  yAxisId="pct"
                  y={70}
                  stroke="#d97706"
                  strokeDasharray="4 4"
                  strokeOpacity={0.55}
                />
                <Area
                  yAxisId="units"
                  type="monotone"
                  dataKey="onHand"
                  name="On-hand inventory"
                  stroke="#0d6b63"
                  strokeWidth={2.25}
                  fill="url(#whOnHandFill)"
                  activeDot={{ r: 4, fill: "#0d6b63" }}
                  isAnimationActive={false}
                />
                <Area
                  yAxisId="units"
                  type="monotone"
                  dataKey="reserved"
                  name="Reserved stock"
                  stroke="#d97706"
                  strokeWidth={2.25}
                  fill="url(#whReservedFill)"
                  activeDot={{ r: 4, fill: "#d97706" }}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="pct"
                  type="monotone"
                  dataKey="utilizationPct"
                  name="Reservation utilisation"
                  stroke="#475569"
                  strokeWidth={1.75}
                  strokeDasharray="4 3"
                  dot={false}
                  activeDot={{ r: 3.5, fill: "#475569" }}
                  isAnimationActive={false}
                />
              </>
            ) : (
              <>
                <Bar
                  yAxisId="daily"
                  dataKey="newReservations"
                  name="Daily new reservations"
                  fill="#0ea5e9"
                  fillOpacity={0.38}
                  radius={[3, 3, 0, 0]}
                  maxBarSize={22}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="units"
                  type="monotone"
                  dataKey="onHand"
                  name="On-hand inventory"
                  stroke="#0d6b63"
                  strokeWidth={2.25}
                  dot={false}
                  activeDot={{ r: 4, fill: "#0d6b63" }}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="units"
                  type="monotone"
                  dataKey="reserved"
                  name="Reserved stock"
                  stroke="#d97706"
                  strokeWidth={2.25}
                  dot={false}
                  activeDot={{ r: 4, fill: "#d97706" }}
                  isAnimationActive={false}
                />
              </>
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="wh-trend-note">
        Today&apos;s balance reflects live verified warehouse stock ({summary.currentOnHand.toLocaleString("en-US")} on hand,{" "}
        {summary.currentReserved.toLocaleString("en-US")} reserved); prior days in the 30-day
        window reconstruct daily stock and reservation trajectories from tenant shipment
        allocations ({summary.totalShipmentsLinked} linked shipment
        {summary.totalShipmentsLinked === 1 ? "" : "s"}).
      </p>
    </div>
  );
}
