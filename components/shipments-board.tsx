"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, PackageOpen, Search, X } from "lucide-react";
import { ClientRelative, ClientWhen } from "@/components/client-time";
import { PaginationBar } from "@/components/pagination-bar";
import { toneFor, city } from "@/lib/format";
import { buildPageHref } from "@/lib/pagination";
import {
  formatStateLabel,
  type ShipmentFilterable,
} from "@/lib/view-helpers";

export type ShipmentsBoardItem = ShipmentFilterable & {
  deadline: Date | string | null;
  updated_at: Date | string;
};

export interface BoardPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
}

export function ShipmentsBoard({
  shipments,
  counts,
  initialState,
  initialQuery = "",
  pagination,
}: {
  shipments: ShipmentsBoardItem[];
  counts: Record<string, number>;
  initialState?: string;
  initialQuery?: string;
  pagination: BoardPagination;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const activeState = initialState ?? "";

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const states = useMemo(
    () => Object.entries(counts).sort((a, b) => b[1] - a[1]),
    [counts],
  );

  const totalAcrossAllStates = useMemo(
    () => Object.values(counts).reduce((sum, n) => sum + n, 0),
    [counts],
  );

  function navigateWithFilters(next: { state?: string; q?: string; page?: number }) {
    const href = buildPageHref("/shipments", {
      state: next.state !== undefined ? next.state : activeState || undefined,
      q: next.q !== undefined ? next.q : initialQuery || undefined,
      page: next.page ?? 1,
      pageSize: pagination.pageSize,
    });
    router.push(href);
  }

  return (
    <>
      <form
        className="board-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          navigateWithFilters({ q: query.trim(), page: 1 });
        }}
      >
        <div className="board-search-group">
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
                  navigateWithFilters({ q: "", page: 1 });
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
                onClick={() => {
                  setQuery("");
                  navigateWithFilters({ q: "", page: 1 });
                }}
              >
                <X size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <button type="submit" className="search-submit-btn">
            Search
          </button>
        </div>
        <div className="board-summary" aria-live="polite">
          {pagination.total === 0 ? (
            <span>0 matching shipments</span>
          ) : (
            <span>
              Showing <strong>{pagination.startIndex}–{pagination.endIndex}</strong> of{" "}
              <strong>{pagination.total.toLocaleString()}</strong> shipments
            </span>
          )}
        </div>
      </form>

      <div
        className="filters"
        role="group"
        aria-label="Filter shipments by state"
      >
        <button
          type="button"
          data-active={!activeState}
          onClick={() => navigateWithFilters({ state: "", page: 1 })}
        >
          <span>All</span>
          <span className="filter-count">{totalAcrossAllStates}</span>
        </button>
        {states.map(([s, n]) => (
          <button
            key={s}
            type="button"
            data-active={activeState === s}
            onClick={() => navigateWithFilters({ state: activeState === s ? "" : s, page: 1 })}
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
          <span className="hint tabular-nums">
            {pagination.total.toLocaleString()} total · page {pagination.page} of {pagination.totalPages}
          </span>
        </header>

        {shipments.length === 0 ? (
          <div className="empty">
            <span className="empty-icon" aria-hidden="true">
              <PackageOpen size={18} strokeWidth={1.75} />
            </span>
            <strong>
              {initialQuery || activeState
                ? "No matching shipments"
                : "No shipments yet"}
            </strong>
            <div className="empty-hint">
              {initialQuery || activeState
                ? "Try clearing your search or selecting a different status filter."
                : "Shipments appear here once a customer order is confirmed."}
            </div>
            {initialQuery || activeState ? (
              <div>
                <button
                  type="button"
                  className="empty-action"
                  onClick={() => {
                    setQuery("");
                    navigateWithFilters({ state: "", q: "", page: 1 });
                  }}
                >
                  <span>Reset filters</span>
                  <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <>
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
                  {shipments.map((s) => (
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

            <PaginationBar
              basePath="/shipments"
              page={pagination.page}
              pageSize={pagination.pageSize}
              total={pagination.total}
              totalPages={pagination.totalPages}
              startIndex={pagination.startIndex}
              endIndex={pagination.endIndex}
              queryParams={{ state: activeState || undefined, q: initialQuery || undefined }}
              itemLabel="shipments"
            />
          </>
        )}
      </section>
    </>
  );
}
