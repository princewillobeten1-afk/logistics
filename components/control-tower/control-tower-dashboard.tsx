"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Download,
  Filter,
  Plane,
  Plus,
  Search,
  Ship,
  TrainFront,
  Truck,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { CarrierWireframe } from "@/components/control-tower/carrier-wireframe";
import { ControlTowerCharts } from "@/components/control-tower/control-tower-charts";
import { PerformanceTrendChart } from "@/components/control-tower/performance-trend-chart";

const Carrier3DStage = dynamic(
  () =>
    import("@/components/control-tower/carrier-3d/carrier-stage").then(
      (mod) => mod.Carrier3DStage,
    ),
  {
    ssr: false,
    loading: () => <CarrierWireframe mode="ROAD" />,
  },
);
import {
  CorridorVectorMap,
  type CorridorMapHub,
} from "@/components/control-tower/corridor-vector-map";
import { QuickOrderDrawer } from "@/components/control-tower/quick-order-drawer";
import { city } from "@/lib/format";
import { resolveLocationCoordinates } from "@/lib/maps-grounding";
import type {
  ControlTowerKpis,
  ControlTowerShipmentItem,
  DailyPerformancePoint,
  ModeVolumePoint,
  QuoteBookingPoint,
} from "@/lib/queries";
import { formatStateLabel } from "@/lib/view-helpers";

type TrackingFilter = "ALL" | "IN_TRANSIT" | "ALERT";
type TransportMode = "SEA" | "AIR" | "ROAD" | "RAIL";

function hubCodeFor(loc: Record<string, unknown> | null, fallbackName: string): string {
  const wh = typeof loc?.warehouse === "string" ? loc.warehouse : "";
  if (wh && wh.length >= 3) return wh.slice(0, 3).toUpperCase();
  const c = fallbackName.trim().toUpperCase();
  if (c === "LAGOS") return "LOS";
  if (c === "ABUJA") return "ABV";
  if (c === "KANO") return "KAN";
  if (c === "PORT HARCOURT") return "PHC";
  if (c === "TEMA") return "TEM";
  if (c === "ACCRA") return "ACC";
  if (c === "COTONOU") return "COO";
  return c.replace(/[^A-Z]/g, "").slice(0, 3) || "HUB";
}

function formatUtcDate(dateVal: Date | string | null): string {
  if (!dateVal) return "TBD";
  const d = typeof dateVal === "string" ? new Date(dateVal) : dateVal;
  if (Number.isNaN(d.getTime())) return "TBD";
  return d
    .toLocaleDateString("en-US", {
      month: "short",
      day: "2-digit",
      year: "numeric",
      timeZone: "UTC",
    })
    .toUpperCase();
}

function formatUtcClock(dateVal: Date | string | null): string {
  if (!dateVal) return "--:--";
  const d = typeof dateVal === "string" ? new Date(dateVal) : dateVal;
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

function formatCompactMoney(minor: number, currency: string): string {
  const major = minor / 100;
  const symbol = { NGN: "₦", USD: "$", EUR: "€", GBP: "£" }[currency] ?? "";
  if (major >= 1_000_000) return `${symbol}${(major / 1_000_000).toFixed(1)}M`;
  if (major >= 1_000) return `${symbol}${Math.round(major / 1_000)}K`;
  return `${symbol}${Math.round(major).toLocaleString("en-US")}`;
}

function ModeGlyph({ mode, size = 13 }: { mode: TransportMode; size?: number }) {
  if (mode === "SEA") return <Ship size={size} strokeWidth={2} aria-hidden="true" />;
  if (mode === "AIR") return <Plane size={size} strokeWidth={2} aria-hidden="true" />;
  if (mode === "RAIL") return <TrainFront size={size} strokeWidth={2} aria-hidden="true" />;
  return <Truck size={size} strokeWidth={2} aria-hidden="true" />;
}

function progressForState(state: string): number {
  switch (state) {
    case "DELIVERED":
    case "POD_VERIFIED":
    case "CLOSED":
      return 100;
    case "IN_TRANSIT":
    case "EXCEPTION":
      return 64;
    case "BOOKED":
      return 42;
    case "AWAITING_APPROVAL":
    case "SOURCING":
      return 32;
    case "PLANNED":
    case "ALLOCATED":
      return 24;
    default:
      return 14;
  }
}

export function ControlTowerDashboard({
  operatorName,
  kpis,
  quoteBookingTrend,
  modeVolumeTrend,
  todayQuoteBookingTrend,
  todayModeVolumeTrend,
  performanceTrend7d,
  shipments,
  locations,
  deadCount,
}: {
  operatorName: string;
  kpis: ControlTowerKpis;
  quoteBookingTrend: QuoteBookingPoint[];
  modeVolumeTrend: ModeVolumePoint[];
  todayQuoteBookingTrend: QuoteBookingPoint[];
  todayModeVolumeTrend: ModeVolumePoint[];
  performanceTrend7d: DailyPerformancePoint[];
  shipments: ControlTowerShipmentItem[];
  locations: {
    id: string;
    type: string;
    name: string;
    code: string | null;
    city: string | null;
    country: string | null;
    latitude: string | null;
    longitude: string | null;
  }[];
  deadCount: number;
}) {
  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState<TrackingFilter>("ALL");
  const [orderDrawerOpen, setOrderDrawerOpen] = useState(false);

  const defaultRef =
    shipments.find((s) => s.state === "IN_TRANSIT")?.reference ??
    shipments[0]?.reference ??
    "";
  const [selectedRef, setSelectedRef] = useState<string>(defaultRef);
  const [previewModeOverride, setPreviewModeOverride] = useState<TransportMode | null>(null);

  const firstName = useMemo(() => {
    const clean = operatorName.trim();
    if (!clean) return "Operator";
    return clean.split(/[\s@._-]+/)[0] || "Operator";
  }, [operatorName]);

  const filteredShipments = useMemo(() => {
    const q = search.trim().toLowerCase();
    return shipments.filter((s) => {
      if (filterMode === "IN_TRANSIT" && s.state !== "IN_TRANSIT") return false;
      if (
        filterMode === "ALERT" &&
        !["EXCEPTION", "NEEDS_INFO", "AWAITING_APPROVAL"].includes(s.state)
      ) {
        return false;
      }
      if (!q) return true;
      const haystack = [
        s.reference,
        s.customer_ref ?? "",
        city(s.origin),
        city(s.destination),
        s.state,
        formatStateLabel(s.state),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [shipments, search, filterMode]);

  const selected = useMemo(
    () =>
      shipments.find((s) => s.reference === selectedRef) ??
      filteredShipments[0] ??
      shipments[0] ??
      null,
    [shipments, filteredShipments, selectedRef],
  );

  const activeMode: TransportMode =
    previewModeOverride ?? selected?.primary_mode ?? "ROAD";

  const hubs: CorridorMapHub[] = useMemo(
    () =>
      locations
        .map((l) => ({
          id: l.id,
          name: l.name,
          code: l.code,
          city: l.city,
          country: l.country,
          lat: Number(l.latitude),
          lon: Number(l.longitude),
        }))
        .filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lon)),
    [locations],
  );

  const selectedOriginCity = selected ? city(selected.origin) : "";
  const selectedDestCity = selected ? city(selected.destination) : "";

  const originCoords = useMemo(() => {
    const pt = resolveLocationCoordinates(selectedOriginCity, locations);
    return pt ? { lat: pt.lat, lon: pt.lng } : null;
  }, [selectedOriginCity, locations]);

  const destCoords = useMemo(() => {
    const pt = resolveLocationCoordinates(selectedDestCity, locations);
    return pt ? { lat: pt.lat, lon: pt.lng } : null;
  }, [selectedDestCity, locations]);

  function handleExportCsv() {
    const headers = [
      "Reference",
      "State",
      "Customer",
      "Origin",
      "Destination",
      "Mode",
      "Distance_KM",
      "Carrier",
      "Deadline_UTC",
    ];
    const rows = filteredShipments.map((s) => [
      s.reference,
      s.state,
      s.customer_ref ?? "",
      city(s.origin),
      city(s.destination),
      s.primary_mode,
      s.distance_km ?? "",
      s.carrier_name ?? "",
      s.deadline ? new Date(s.deadline).toISOString() : "",
    ]);
    const csv = [headers, ...rows]
      .map((line) =>
        line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","),
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `control-tower-shipments-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function cycleFilter() {
    setFilterMode((prev) =>
      prev === "ALL" ? "IN_TRANSIT" : prev === "IN_TRANSIT" ? "ALERT" : "ALL",
    );
  }

  const originCode = selected ? hubCodeFor(selected.origin, selectedOriginCity) : "—";
  const destCode = selected ? hubCodeFor(selected.destination, selectedDestCity) : "—";
  const selectedProgress = selected ? progressForState(selected.state) : 50;
  const isAlert = selected
    ? ["EXCEPTION", "NEEDS_INFO", "AWAITING_APPROVAL"].includes(selected.state)
    : false;

  return (
    <div className="ct-workspace">
      {/* 1. Executive Greeting Header */}
      <div className="ct-hero-row">
        <div className="ct-greeting">
          <h1>
            Hello, <span className="ct-greeting-name">{firstName}!</span>
          </h1>
          <p>Monitor your freight operations in real-time</p>
        </div>

        <div className="ct-hero-actions">
          <button type="button" className="ct-btn-outline" onClick={handleExportCsv}>
            <Download size={14} strokeWidth={2} aria-hidden="true" />
            <span>Export</span>
          </button>
          <button
            type="button"
            className="ct-btn-dark"
            onClick={() => setOrderDrawerOpen(true)}
          >
            <Plus size={15} strokeWidth={2.2} aria-hidden="true" />
            <span>New Order</span>
          </button>
        </div>
      </div>

      {/* Stalled Work Alert if applicable */}
      {deadCount > 0 ? (
        <div className="ct-alert-strip" role="alert">
          <span>
            <strong>{deadCount}</strong> stalled workflow{" "}
            {deadCount === 1 ? "item requires" : "items require"} operator inspection.
          </span>
          <Link href="/queue" className="auth-link">
            Inspect work queue →
          </Link>
        </div>
      ) : null}

      {/* 2. 6-Column Executive KPI Strip */}
      <dl className="ct-kpi-strip">
        <div className="ct-kpi-card">
          <dt>Active Shipment</dt>
          <dd>
            <strong>{kpis.activeShipments}</strong>
            <span className="ct-kpi-delta is-up">
              {kpis.totalShipments} total tracked
            </span>
          </dd>
        </div>

        <div className="ct-kpi-card">
          <dt>Quotes Generated</dt>
          <dd>
            <strong>{kpis.quotesGenerated}</strong>
            <span className="ct-kpi-delta is-up">
              {kpis.quotesSelected} selected
            </span>
          </dd>
        </div>

        <div className="ct-kpi-card">
          <dt>AI Conversations</dt>
          <dd>
            <strong>{kpis.aiConversations}</strong>
            <span className="ct-kpi-delta is-up">automated turns</span>
          </dd>
        </div>

        <Link href="/exceptions" className="ct-kpi-card is-interactive">
          <dt>Delayed Shipments</dt>
          <dd>
            <strong>{kpis.delayedOrAttention}</strong>
            <span
              className={`ct-kpi-delta ${kpis.delayedOrAttention > 0 ? "is-alert" : "is-up"}`}
            >
              {kpis.delayedOrAttention > 0 ? "Requires attention" : "All on schedule"}
            </span>
          </dd>
        </Link>

        <div className="ct-kpi-card">
          <dt>Conversion Rate</dt>
          <dd>
            <strong>{kpis.conversionRatePct}%</strong>
            <span className="ct-kpi-delta is-up">booked &amp; fulfilled</span>
          </dd>
        </div>

        <div className="ct-kpi-card">
          <dt>Freight Value</dt>
          <dd>
            <strong>{formatCompactMoney(kpis.freightValueMinor, kpis.currency)}</strong>
            <span className="ct-kpi-delta is-up">planned portfolio</span>
          </dd>
        </div>
      </dl>

      {/* 3. 7-Day Operational Performance Trends (Shipments, Emissions, Cost/Shipment) */}
      <PerformanceTrendChart
        data={performanceTrend7d}
        currency={kpis.currency}
      />

      {/* 4. 2-Column Analytical Charts Row */}
      <ControlTowerCharts
        quoteBookingTrend={quoteBookingTrend}
        modeVolumeTrend={modeVolumeTrend}
        todayQuoteBookingTrend={todayQuoteBookingTrend}
        todayModeVolumeTrend={todayModeVolumeTrend}
      />

      {/* 4. 3-Column Live Control Tower Workspace */}
      <div className="ct-live-grid">
        {/* Column 1: Shipment Tracking Cards */}
        <section className="ct-card ct-track-col" aria-label="Shipment Tracking">
          <div className="ct-col-head">
            <h2>Shipment Tracking</h2>
            <div className="ct-col-tools">
              <button
                type="button"
                className="ct-icon-chip"
                onClick={cycleFilter}
                title={`Filter: ${filterMode === "ALL" ? "All shipments" : filterMode === "IN_TRANSIT" ? "In transit only" : "Alerts & exceptions"}`}
                aria-label="Cycle shipment tracking filter"
              >
                <Filter size={14} strokeWidth={2} aria-hidden="true" />
                {filterMode !== "ALL" ? (
                  <span className="ct-filter-pill-text">
                    {filterMode === "IN_TRANSIT" ? "Transit" : "Alerts"}
                  </span>
                ) : null}
              </button>
              <Link href="/shipments" className="ct-col-link">
                All
              </Link>
            </div>
          </div>

          <div className="ct-track-search">
            <Search size={14} strokeWidth={1.8} aria-hidden="true" />
            <label htmlFor="ct-shipment-search" className="visually-hidden">
              Filter shipments by Order ID, reference, customer, or city
            </label>
            <input
              id="ct-shipment-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Order ID, route or customer…"
            />
            {search ? (
              <button
                type="button"
                className="ct-track-clear"
                aria-label="Clear filter"
                onClick={() => setSearch("")}
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <div className="ct-track-list" role="listbox" aria-label="Tracked shipments">
            {shipments.length === 0 ? (
              <div className="ct-empty-mini">
                <p>No shipments yet</p>
                <button
                  type="button"
                  className="ct-btn-dark"
                  onClick={() => setOrderDrawerOpen(true)}
                >
                  <Plus size={14} strokeWidth={2} aria-hidden="true" />
                  <span>New Order</span>
                </button>
              </div>
            ) : filteredShipments.length === 0 ? (
              <div className="ct-empty-mini">
                <p>No shipments match your filter.</p>
                <button
                  type="button"
                  className="ct-btn-outline"
                  onClick={() => {
                    setSearch("");
                    setFilterMode("ALL");
                  }}
                >
                  Reset filter
                </button>
              </div>
            ) : (
              filteredShipments.slice(0, 8).map((s) => {
                const oCity = city(s.origin);
                const dCity = city(s.destination);
                const oCode = hubCodeFor(s.origin, oCity);
                const dCode = hubCodeFor(s.destination, dCity);
                const isSelected = selected?.reference === s.reference;
                const badgeTone =
                  s.state === "IN_TRANSIT"
                    ? "transit"
                    : ["DELIVERED", "POD_VERIFIED", "CLOSED", "BOOKED"].includes(s.state)
                      ? "arrived"
                      : ["EXCEPTION", "AWAITING_APPROVAL", "NEEDS_INFO"].includes(s.state)
                        ? "alert"
                        : "pending";

                return (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`ct-ship-card${isSelected ? " is-selected" : ""}`}
                    onClick={() => {
                      setSelectedRef(s.reference);
                      setPreviewModeOverride(null);
                    }}
                  >
                    <div className="ct-ship-card-top">
                      <span className="ct-ship-ref">{s.reference}</span>
                      <span className={`ct-ship-badge is-${badgeTone}`}>
                        {formatStateLabel(s.state)}
                      </span>
                    </div>

                    <div className="ct-ship-route-row">
                      <span className="ct-code-chip">{oCode}</span>
                      <span className="ct-route-dash" aria-hidden="true" />
                      <span className="ct-route-mode-icon" aria-hidden="true">
                        <ModeGlyph mode={s.primary_mode} size={12} />
                      </span>
                      <span className="ct-route-dash" aria-hidden="true" />
                      <span className="ct-duration-chip">
                        {s.transit_hours
                          ? `${s.transit_hours} h`
                          : s.distance_km
                            ? `${s.distance_km} km`
                            : "Scheduled"}
                      </span>
                      <span className="ct-route-dash" aria-hidden="true" />
                      <span className="ct-code-chip">{dCode}</span>
                    </div>

                    <div className="ct-ship-card-foot">
                      <div>
                        <strong>{oCity}</strong>
                        <span>{formatUtcDate(s.created_at)}</span>
                      </div>
                      <div className="is-right">
                        <strong>{dCity}</strong>
                        <span>{formatUtcDate(s.deadline)}</span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* Column 2: Live Transit Inspector */}
        <section className="ct-card ct-transit-col" aria-label="Live Transit Inspector">
          <div className="ct-col-head">
            <h2>Live Transit</h2>
            {selected ? (
              <Link
                href={`/shipments/${encodeURIComponent(selected.reference)}`}
                className="ct-col-link"
              >
                Details
              </Link>
            ) : null}
          </div>

          {selected ? (
            <>
              <div className="ct-transit-subhead">
                <span className="ct-transit-date">{formatUtcDate(selected.created_at)}</span>

                <div className="ct-transit-modes" role="group" aria-label="Transport mode view">
                  {(["SEA", "AIR", "ROAD", "RAIL"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`ct-transit-mode-btn${activeMode === m ? " is-active" : ""}`}
                      onClick={() => setPreviewModeOverride(m)}
                      title={`View ${m.toLowerCase()} transport mode`}
                    >
                      <ModeGlyph mode={m} size={13} />
                      {activeMode === m ? <span>{m === "SEA" ? "SHIP" : m}</span> : null}
                    </button>
                  ))}
                </div>

                <span className="ct-transit-clock">
                  {formatUtcClock(selected.updated_at)} UTC
                </span>
              </div>

              <div className="ct-wireframe-stage">
                <Carrier3DStage mode={activeMode} />
              </div>

              <div className="ct-carrier-row">
                <div className="ct-carrier-avatar" aria-hidden="true">
                  <ModeGlyph mode={activeMode} size={16} />
                </div>
                <div className="ct-carrier-meta">
                  <strong>
                    Shipped via {selected.carrier_name ?? "Assigned Carrier"}
                  </strong>
                  <span>
                    {selected.last_lat != null && selected.last_lon != null
                      ? `Coordinates: ${selected.last_lat.toFixed(4)}° N, ${selected.last_lon.toFixed(4)}° E`
                      : originCoords
                        ? `Origin hub: ${originCoords.lat.toFixed(4)}° N, ${originCoords.lon.toFixed(4)}° E`
                        : "Awaiting live GPS telemetry"}
                  </span>
                </div>
                <Link
                  href={`/shipments/${encodeURIComponent(selected.reference)}`}
                  className="ct-circle-arrow"
                  aria-label={`Open full details for ${selected.reference}`}
                >
                  <ArrowUpRight size={15} strokeWidth={2} aria-hidden="true" />
                </Link>
              </div>

              <div className="ct-endpoints-box">
                <div className="ct-endpoint">
                  <span className="ct-endpoint-code">{originCode}</span>
                  <span className="ct-endpoint-city">{selectedOriginCity}</span>
                  <div className="ct-endpoint-times">
                    <div>
                      <span>Scheduled</span>
                      <strong>{formatUtcClock(selected.created_at)}</strong>
                    </div>
                    <div>
                      <span>Dispatched</span>
                      <strong>{formatUtcClock(selected.updated_at)}</strong>
                    </div>
                  </div>
                </div>

                <div className="ct-endpoints-swap" aria-hidden="true">
                  <ArrowLeftRight size={14} strokeWidth={2} />
                </div>

                <div className="ct-endpoint is-right">
                  <span className="ct-endpoint-code">{destCode}</span>
                  <span className="ct-endpoint-city">{selectedDestCity}</span>
                  <div className="ct-endpoint-times">
                    <div>
                      <span>Promised</span>
                      <strong>{formatUtcClock(selected.deadline)}</strong>
                    </div>
                    <div>
                      <span>Estimated</span>
                      <strong>
                        {selected.transit_hours ? `${selected.transit_hours}h ETA` : "Tracking"}
                      </strong>
                    </div>
                  </div>
                </div>
              </div>

              <div className="ct-progress-block">
                <div className="ct-progress-head">
                  <span>
                    {selected.vehicle_label
                      ? `Unit · ${selected.vehicle_label}`
                      : `Cargo: ${String(selected.cargo?.quantity ?? "—")} × ${String(selected.cargo?.weight_kg ?? "—")} kg`}
                  </span>
                  <strong>
                    {selected.distance_km ? `${selected.distance_km} km corridor` : formatStateLabel(selected.state)}
                  </strong>
                </div>

                <div className="ct-progress-track" role="progressbar" aria-valuenow={selectedProgress} aria-valuemin={0} aria-valuemax={100}>
                  <span
                    className={`ct-progress-fill${isAlert ? " is-alert" : ""}`}
                    style={{ width: `${selectedProgress}%` }}
                  />
                  <span
                    className={`ct-progress-thumb${isAlert ? " is-alert" : ""}`}
                    style={{ left: `calc(${selectedProgress}% - 7px)` }}
                  />
                </div>

                <div className="ct-progress-foot">
                  <div>
                    <span className="ct-code-inline">{originCode}</span>
                    <strong>{selectedOriginCity}</strong>
                    <small>{formatUtcDate(selected.created_at)}</small>
                  </div>
                  <div className="is-right">
                    <span className="ct-code-inline">{destCode}</span>
                    <strong>{selectedDestCity}</strong>
                    <small>{formatUtcDate(selected.deadline)}</small>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="ct-empty-mini">
              <p>Select a shipment to inspect live transit telemetry.</p>
            </div>
          )}
        </section>

        {/* Column 3: Live Corridor Vector Map */}
        <section className="ct-card ct-map-col" aria-label="Live Corridor Map">
          {selected && originCoords && destCoords ? (
            <CorridorVectorMap
              reference={selected.reference}
              state={selected.state}
              originCity={selectedOriginCity}
              destinationCity={selectedDestCity}
              originCoords={originCoords}
              destinationCoords={destCoords}
              liveLat={selected.last_lat}
              liveLon={selected.last_lon}
              hubs={hubs}
            />
          ) : (
            <div className="ct-empty-mini">
              <p>
                {selected
                  ? "Configure hub coordinates in Warehouses to visualize this corridor."
                  : "No active routes mapped."}
              </p>
            </div>
          )}
        </section>
      </div>

      <QuickOrderDrawer
        open={orderDrawerOpen}
        onClose={() => setOrderDrawerOpen(false)}
      />
    </div>
  );
}
