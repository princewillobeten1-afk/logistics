"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ArrowDownUp,
  ArrowUpRight,
  Building2,
  Download,
  Layers,
  Route,
  Search,
  Truck,
  Users,
} from "lucide-react";
import { ProvenanceTag } from "@/components/intelligence/bi-charts";
import type {
  BiComparisonSuite,
  ComparisonRow,
} from "@/lib/intelligence/types";

type TabKey = "departments" | "branches" | "vehicles" | "routes" | "customers";

const TABS: { key: TabKey; label: string; icon: typeof Layers }[] = [
  { key: "departments", label: "Departments", icon: Layers },
  { key: "branches", label: "Branches & Warehouses", icon: Building2 },
  { key: "vehicles", label: "Vehicles", icon: Truck },
  { key: "routes", label: "Routes & Corridors", icon: Route },
  { key: "customers", label: "Customers", icon: Users },
];

type SortField = "primary" | "secondary" | "risk" | "name";

function escapeCsvCell(value: string): string {
  // Prevent CSV formula injection in spreadsheet tools
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function BiComparisonsPanel({
  comparisons,
  periodLabel,
  orgName,
}: {
  comparisons: BiComparisonSuite;
  periodLabel: string;
  orgName: string;
}) {
  const [tab, setTab] = useState<TabKey>("departments");
  const [queryText, setQueryText] = useState("");
  const [sortBy, setSortBy] = useState<SortField>("primary");
  const [sortAsc, setSortAsc] = useState(false);

  const rawRows: ComparisonRow[] = comparisons[tab] ?? [];

  const filtered = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    const list = q
      ? rawRows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            (r.subtitle ?? "").toLowerCase().includes(q) ||
            r.efficiencyFormatted.toLowerCase().includes(q),
        )
      : [...rawRows];

    list.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "name") cmp = a.name.localeCompare(b.name);
      else if (sortBy === "secondary") cmp = a.secondaryMetricValue - b.secondaryMetricValue;
      else if (sortBy === "risk") cmp = a.riskCount - b.riskCount;
      else cmp = a.primaryMetricValue - b.primaryMetricValue;
      return sortAsc ? cmp : -cmp;
    });
    return list;
  }, [rawRows, queryText, sortBy, sortAsc]);

  const toggleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortAsc((v) => !v);
    } else {
      setSortBy(field);
      setSortAsc(field === "name");
    }
  };

  const exportCsv = () => {
    const sample = filtered[0];
    const headers = [
      "Entity",
      "Details",
      "Status",
      sample?.primaryMetricLabel ?? "Primary",
      sample?.secondaryMetricLabel ?? "Secondary",
      sample?.efficiencyLabel ?? "Efficiency",
      sample?.riskLabel ?? "Risks",
      "Period Delta (%)",
      "Provenance",
    ];
    const lines = [
      headers.map(escapeCsvCell).join(","),
      ...filtered.map((r) =>
        [
          r.name,
          r.subtitle ?? "",
          r.status,
          r.primaryMetricFormatted,
          r.secondaryMetricFormatted,
          r.efficiencyFormatted,
          String(r.riskCount),
          r.deltaPct !== null ? `${r.deltaPct}%` : "N/A",
          r.provenance,
        ]
          .map(escapeCsvCell)
          .join(","),
      ),
    ];

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-bi-${tab}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sampleRow = rawRows[0];

  return (
    <section className="bi-panel" aria-labelledby="bi-compare-heading">
      <div className="bi-panel-head">
        <div className="bi-panel-title-group">
          <h2 id="bi-compare-heading">Cross-Entity Performance Comparisons</h2>
          <p className="bi-panel-sub">
            Benchmark departments, branches, fleet vehicles, freight corridors, and customer
            accounts side-by-side ({periodLabel}).
          </p>
        </div>

        <button
          type="button"
          className="bi-btn-outline"
          onClick={exportCsv}
          disabled={filtered.length === 0}
        >
          <Download size={14} aria-hidden="true" />
          <span>Export CSV</span>
        </button>
      </div>

      <div className="bi-compare-controls">
        <div className="bi-seg-tabs" role="tablist" aria-label="Comparison dimension">
          {TABS.map((t) => {
            const Icon = t.icon;
            const count = comparisons[t.key]?.length ?? 0;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                className={`bi-seg-btn${tab === t.key ? " is-active" : ""}`}
                onClick={() => {
                  setTab(t.key);
                  setQueryText("");
                }}
              >
                <Icon size={14} strokeWidth={1.85} aria-hidden="true" />
                <span>{t.label}</span>
                <span className="bi-tab-count">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="bi-search-box">
          <Search size={14} aria-hidden="true" />
          <label htmlFor="bi-compare-search" className="visually-hidden">
            Filter comparison rows
          </label>
          <input
            id="bi-compare-search"
            type="search"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            placeholder={`Filter ${tab}…`}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bi-empty-table">
          No {tab} records match the current workspace or filter yet.
        </div>
      ) : (
        <div
          className="scroller bi-table-scroller"
          tabIndex={0}
          role="region"
          aria-label={`${tab} performance comparison`}
        >
          <table className="bi-table">
            <thead>
              <tr>
                <th scope="col">
                  <button
                    type="button"
                    className="bi-sort-th"
                    onClick={() => toggleSort("name")}
                  >
                    <span>Entity</span>
                    <ArrowDownUp size={12} aria-hidden="true" />
                  </button>
                </th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  <button
                    type="button"
                    className="bi-sort-th"
                    onClick={() => toggleSort("primary")}
                  >
                    <span>{sampleRow?.primaryMetricLabel ?? "Primary"}</span>
                    <ArrowDownUp size={12} aria-hidden="true" />
                  </button>
                </th>
                <th scope="col" className="num">
                  <button
                    type="button"
                    className="bi-sort-th"
                    onClick={() => toggleSort("secondary")}
                  >
                    <span>{sampleRow?.secondaryMetricLabel ?? "Secondary"}</span>
                    <ArrowDownUp size={12} aria-hidden="true" />
                  </button>
                </th>
                <th scope="col">{sampleRow?.efficiencyLabel ?? "Efficiency"}</th>
                <th scope="col" className="num">
                  <button
                    type="button"
                    className="bi-sort-th"
                    onClick={() => toggleSort("risk")}
                  >
                    <span>{sampleRow?.riskLabel ?? "Risk"}</span>
                    <ArrowDownUp size={12} aria-hidden="true" />
                  </button>
                </th>
                <th scope="col">Provenance</th>
                <th scope="col" className="num">
                  Drilldown
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const stClass = `bi-status-${row.status.toLowerCase()}`;
                return (
                  <tr key={row.id}>
                    <td>
                      <div className="bi-entity-cell">
                        <strong>{row.name}</strong>
                        {row.subtitle ? <span>{row.subtitle}</span> : null}
                      </div>
                    </td>
                    <td>
                      <span className={`bi-status-dot ${stClass}`}>
                        {row.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="num">
                      <span className="bi-num-strong">{row.primaryMetricFormatted}</span>
                      {row.deltaPct !== null ? (
                        <span className="bi-delta-inline">
                          {row.deltaPct >= 0 ? "+" : ""}
                          {row.deltaPct.toFixed(1)}%
                        </span>
                      ) : null}
                    </td>
                    <td className="num">{row.secondaryMetricFormatted}</td>
                    <td>{row.efficiencyFormatted}</td>
                    <td className={`num${row.riskCount > 0 ? " bi-risk-hot" : ""}`}>
                      {row.riskCount}
                    </td>
                    <td>
                      <ProvenanceTag provenance={row.provenance} />
                    </td>
                    <td className="num">
                      {row.deepLink ? (
                        <Link href={row.deepLink} className="bi-inline-link">
                          <span>Inspect</span>
                          <ArrowUpRight size={13} aria-hidden="true" />
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
