"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const ROUTE_META: Record<string, { group: string; label: string }> = {
  "/": { group: "Operations", label: "Overview" },
  "/map": { group: "Operations", label: "Shipments map" },
  "/orders": { group: "Operations", label: "Orders" },
  "/shipments": { group: "Operations", label: "Shipments" },
  "/planning": { group: "Operations", label: "Planning" },
  "/exceptions": { group: "Operations", label: "Exceptions" },
  "/approvals": { group: "Operations", label: "Approvals" },
  "/carriers": { group: "Network", label: "Carriers" },
  "/fleet": { group: "Network", label: "Fleet" },
  "/warehouses": { group: "Network", label: "Warehouses" },
  "/customers": { group: "Customer", label: "Customers" },
  "/support": { group: "Customer", label: "Support inbox" },
  "/track": { group: "Customer", label: "Preview chat" },
  "/communications": { group: "Records", label: "Communications" },
  "/documents": { group: "Records", label: "Documents" },
  "/analytics": { group: "Records", label: "Analytics" },
  "/activity": { group: "System", label: "Activity" },
  "/queue": { group: "System", label: "Work queue" },
  "/settings": { group: "System", label: "Settings" },
};

type Scheme = "light dark" | "light" | "dark";

function applyScheme(value: Scheme) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) meta.content = value;
  if (value === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else if (value === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [refQuery, setRefQuery] = useState("");
  const [scheme, setScheme] = useState<Scheme>("light dark");

  useEffect(() => {
    try {
      const stored = localStorage.getItem("color-scheme");
      if (stored === "light" || stored === "dark") {
        setScheme(stored);
        applyScheme(stored);
      } else {
        setScheme("light dark");
        applyScheme("light dark");
      }
    } catch {
      // Storage blocked; keep system default
    }

    const onStorage = (e: StorageEvent) => {
      if (e.key !== "color-scheme") return;
      const next: Scheme =
        e.newValue === "light" || e.newValue === "dark" ? e.newValue : "light dark";
      setScheme(next);
      applyScheme(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function selectScheme(next: Scheme) {
    setScheme(next);
    applyScheme(next);
    try {
      if (next === "light dark") {
        localStorage.removeItem("color-scheme");
      } else {
        localStorage.setItem("color-scheme", next);
      }
    } catch {
      // Ignore storage errors
    }
  }

  function onQuickJump(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = refQuery.trim();
    if (!trimmed) return;
    setRefQuery("");
    router.push(`/shipments/${encodeURIComponent(trimmed)}`);
  }

  const exact = ROUTE_META[pathname];
  let group = exact?.group ?? "Operations";
  let parentHref: string | null = null;
  let parentLabel: string | null = null;
  let currentLabel = exact?.label ?? "Overview";

  if (!exact && pathname.startsWith("/shipments/")) {
    group = "Operations";
    parentHref = "/shipments";
    parentLabel = "Shipments";
    currentLabel = decodeURIComponent(pathname.slice("/shipments/".length));
  } else if (!exact && pathname.startsWith("/customers/")) {
    group = "Customer";
    parentHref = "/customers";
    parentLabel = "Customers";
    currentLabel = decodeURIComponent(pathname.slice("/customers/".length));
  }

  return (
    <header className="topbar">
      <nav aria-label="Breadcrumb" className="breadcrumbs">
        <ol>
          <li>
            <span className="crumb-group">{group}</span>
          </li>
          <li aria-hidden="true" className="crumb-sep">
            /
          </li>
          {parentHref && parentLabel ? (
            <>
              <li>
                <Link href={parentHref}>{parentLabel}</Link>
              </li>
              <li aria-hidden="true" className="crumb-sep">
                /
              </li>
              <li>
                <span className="crumb-current font-mono" aria-current="page">
                  {currentLabel}
                </span>
              </li>
            </>
          ) : (
            <li>
              <span className="crumb-current" aria-current="page">
                {currentLabel}
              </span>
            </li>
          )}
        </ol>
      </nav>

      <div className="topbar-controls">
        <form onSubmit={onQuickJump} className="quick-jump" role="search">
          <label htmlFor="quick-jump-ref" className="visually-hidden">
            Jump to shipment reference
          </label>
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <input
            id="quick-jump-ref"
            name="reference"
            type="search"
            value={refQuery}
            onChange={(e) => setRefQuery(e.target.value)}
            placeholder="Find shipment ref…"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
          />
        </form>

        <div className="theme-switch" role="group" aria-label="Color theme">
          <button
            type="button"
            aria-pressed={scheme === "light dark"}
            onClick={() => selectScheme("light dark")}
          >
            Auto
          </button>
          <button
            type="button"
            aria-pressed={scheme === "light"}
            onClick={() => selectScheme("light")}
          >
            Light
          </button>
          <button
            type="button"
            aria-pressed={scheme === "dark"}
            onClick={() => selectScheme("dark")}
          >
            Dark
          </button>
        </div>
      </div>
    </header>
  );
}

