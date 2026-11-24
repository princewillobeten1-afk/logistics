"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AlertCircle, ArrowRight, PackageOpen, RefreshCw } from "lucide-react";
import { ClientRelative } from "@/components/client-time";
import {
  GoogleNetworkMap,
  type GoogleMapLane,
  type GoogleMapPoint,
} from "@/components/google-network-map";
import type { MapShipmentItem } from "@/components/network-map";
import { city, toneFor } from "@/lib/format";
import { formatStateLabel } from "@/lib/view-helpers";

type MapRefreshResponse = {
  points?: GoogleMapPoint[];
  lanes?: GoogleMapLane[];
  active?: MapShipmentItem[];
  fetchedAt?: string;
  error?: string;
};

export function MapViewClient({
  apiKey,
  initialPoints,
  initialLanes,
  initialActive,
}: {
  apiKey: string;
  initialPoints: GoogleMapPoint[];
  initialLanes: GoogleMapLane[];
  initialActive: MapShipmentItem[];
}) {
  const [points, setPoints] = useState<GoogleMapPoint[]>(initialPoints);
  const [lanes, setLanes] = useState<GoogleMapLane[]>(initialLanes);
  const [active, setActive] = useState<MapShipmentItem[]>(initialActive);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  const mappedIds = useMemo(
    () => new Set(lanes.map((l) => l.shipment.id)),
    [lanes],
  );

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch("/api/map", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as MapRefreshResponse;
      if (!res.ok) {
        setRefreshError(
          data.error ?? "Unable to refresh shipment and location data.",
        );
        return;
      }
      if (Array.isArray(data.points)) setPoints(data.points);
      if (Array.isArray(data.lanes)) setLanes(data.lanes);
      if (Array.isArray(data.active)) setActive(data.active);
      if (data.fetchedAt) setLastRefreshedAt(data.fetchedAt);
    } catch {
      setRefreshError("Network error while refreshing shipment and location data.");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
      <section className="panel">
        <header>
          <h2>Network</h2>
          <span className="hint">
            {points.length} sites · {lanes.length} active lane(s)
          </span>
        </header>
        {points.length === 0 ? (
          <div className="empty">
            <span className="empty-icon" aria-hidden="true">
              <PackageOpen size={18} strokeWidth={1.75} />
            </span>
            <strong>No locations yet</strong>
            <div className="empty-hint">
              The map draws itself once your warehouses, ports and airports are
              configured.
            </div>
          </div>
        ) : (
          <div className="body">
            <GoogleNetworkMap apiKey={apiKey} points={points} lanes={lanes} />
          </div>
        )}
      </section>

      <section className="panel">
        <header>
          <h2>Active shipments</h2>
          <div className="panel-actions">
            <span className="hint" aria-live="polite">
              {active.length} moving
              {lastRefreshedAt ? (
                <>
                  {" · updated "}
                  <ClientRelative date={lastRefreshedAt} />
                </>
              ) : null}
            </span>
            <button
              type="button"
              className="panel-refresh-btn"
              onClick={handleRefresh}
              disabled={refreshing}
              aria-busy={refreshing}
              aria-label="Refresh active shipments and location data"
            >
              <RefreshCw
                size={13}
                strokeWidth={2}
                className={refreshing ? "spin" : undefined}
                aria-hidden="true"
              />
              <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
            </button>
          </div>
        </header>

        {refreshError ? (
          <div className="panel-inline-error" role="alert">
            <AlertCircle size={14} strokeWidth={2} aria-hidden="true" />
            <span>{refreshError}</span>
          </div>
        ) : null}

        {active.length === 0 ? (
          <div className="empty">
            <span className="empty-icon" aria-hidden="true">
              <PackageOpen size={18} strokeWidth={1.75} />
            </span>
            <strong>Nothing active</strong>
            <div className="empty-hint">
              Submit a shipment to see it on the map.
            </div>
            <div>
              <Link href="/orders" className="empty-action">
                <span>Create order</span>
                <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
              </Link>
            </div>
          </div>
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Active shipments on map"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Status</th>
                  <th scope="col">Lane</th>
                  <th scope="col">Coordinates</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {active.map((s) => {
                  const drawn = mappedIds.has(s.id);
                  return (
                    <tr key={s.id}>
                      <td className="ref">
                        <Link href={`/shipments/${s.reference}`}>
                          {s.reference}
                        </Link>
                      </td>
                      <td>
                        <span
                          className="status-tag"
                          data-tone={toneFor(s.state)}
                        >
                          {formatStateLabel(s.state)}
                        </span>
                      </td>
                      <td className="num">
                        {city(s.origin)} → {city(s.destination)}
                      </td>
                      <td className="num text-faint">
                        {drawn ? "Mapped" : "Pending coordinates"}
                      </td>
                      <td className="num text-faint">
                        <ClientRelative date={s.updated_at} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
