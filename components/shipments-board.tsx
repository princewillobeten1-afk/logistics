"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, PackageOpen, Search, X } from "lucide-react";
import { ClientRelative, ClientWhen } from "@/components/client-time";
import { toneFor, city } from "@/lib/format";
import {
  filterShipments,
  formatStateLabel,
  type ShipmentFilterable,
} from "@/lib/view-helpers";

export type ShipmentsBoardItem = ShipmentFilterable & {
  deadline: Date | string | null;
  updated_at: Date | string;
};

export function ShipmentsBoard({
  shipments,
  counts,
  initialState,
  initialQuery = "",
}: {
  shipments: ShipmentsBoardItem[];
  counts: Record<string, number>;
  initialState?: string;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [activeState, setActiveState] = useState<string>(initialState ?? "");

  const states = useMemo(
    () => Object.entries(counts).sort((a, b) => b[1] - a[1]),
    [counts],
  );

  const filtered = useMemo(
    () =>
      filterShipments(shipments, {
        query,
        state: activeState || undefined,
      }),
    [shipments, query, activeState],
  );

  function selectState(next: string) {
    setActiveState(next);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams();
      if (next) params.set("state", next);
      if (query.trim()) params.set("q", query.trim());
      const qs = params.toString();
      window.history.replaceState(null, "", qs ? `/shipments?${qs}` : "/shipments");
    }
  }

  return (
    <>
      <div className="board-toolbar">
        <div className="search-field">
          <Search
            size={15}
            strokeWidth={1.75}
            aria-hidden="true"
            className="search-field-icon"
          />
          <label htmlFor="shipments-search" className="visually-hidden">
            Search shipments by reference, customer name, or route origin and destination
          </label>
          <input
            id="shipments-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
            placeholder="Search reference, customer name, or route (origin → destination)…"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="board-summary" aria-live="polite">
          Showing <strong>{filtered.length}</strong> of{" "}
          <strong>{shipments.length}</strong> shipments
        </div>
      </div>

      <div
        className="filters"
        role="group"
        aria-label="Filter shipments by state"
      >
        <button
          type="button"
          data-active={!activeState}
          onClick={() => selectState("")}
        >
          <span>All</span>
          <span className="filter-count">{shipments.length}</span>
        </button>
        {states.map(([s, n]) => (
          <button
            key={s}
            type="button"
            data-active={activeState === s}
            onClick={() => selectState(activeState === s ? "" : s)}
          >
            <span>{formatStateLabel(s)}</span>
            <span className="filter-count">{n}</span>
          </button>
        ))}
      </div>

      <section className="panel">
        <header>
          <h2>
            {activeState
              ? `${formatStateLabel(activeState)} shipments`
              : "All shipments"}
          </h2>
          <span className="hint">{filtered.length} shown</span>
        </header>

        {filtered.length === 0 ? (
          <div className="empty">
            <span className="empty-icon" aria-hidden="true">
              <PackageOpen size={18} strokeWidth={1.75} />
            </span>
            <strong>
              {query || activeState
                ? "No matching shipments"
                : "No shipments yet"}
            </strong>
            <div className="empty-hint">
              {query || activeState
                ? "Try clearing your search or selecting a different status filter."
                : "Shipments appear here once a customer order is confirmed."}
            </div>
            {query || activeState ? (
              <div>
                <button
                  type="button"
                  className="empty-action"
                  onClick={() => {
                    setQuery("");
                    selectState("");
                  }}
                >
                  <span>Reset filters</span>
                  <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Shipments list"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Status</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Lane</th>
                  <th scope="col">Cargo</th>
                  <th scope="col">Deadline</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
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
                    <td>{s.customer_ref ?? "—"}</td>
                    <td className="num">
                      {city(s.origin)} → {city(s.destination)}
                    </td>
                    <td className="num">
                      {(s.cargo?.quantity as number) ?? "—"} ×{" "}
                      {(s.cargo?.weight_kg as number) ?? "—"}kg
                    </td>
                    <td className="num">
                      <ClientWhen date={s.deadline} />
                    </td>
                    <td className="num text-faint">
                      <ClientRelative date={s.updated_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
