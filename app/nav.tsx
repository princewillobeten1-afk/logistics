"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

const ICONS: Record<string, ReactNode> = {
  "/": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  ),
  "/map": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1.75 3.5L5.75 2L10.25 3.5L14.25 2V12.5L10.25 14L5.75 12.5L1.75 14V3.5Z" strokeLinejoin="round" />
      <path d="M5.75 2V12.5M10.25 3.5V14" />
    </svg>
  ),
  "/orders": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2.5" y="2" width="11" height="12" rx="1.5" />
      <path d="M5 5.5H11M5 8H11M5 10.5H8.5" strokeLinecap="round" />
    </svg>
  ),
  "/shipments": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 1.75L13.75 4.75V11.25L8 14.25L2.25 11.25V4.75L8 1.75Z" strokeLinejoin="round" />
      <path d="M2.25 4.75L8 7.75L13.75 4.75M8 7.75V14.25" strokeLinejoin="round" />
    </svg>
  ),
  "/planning": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="3.5" cy="12" r="1.75" />
      <circle cx="12.5" cy="4" r="1.75" />
      <path d="M5.25 12H8.5C10.15 12 11 10.8 11 9.25V6.75C11 5.2 10.15 4 8.5 4H10.75" strokeLinecap="round" />
    </svg>
  ),
  "/exceptions": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 2.25L14.25 13.25H1.75L8 2.25Z" strokeLinejoin="round" />
      <path d="M8 6.5V9.5M8 11.5H8.01" strokeLinecap="round" />
    </svg>
  ),
  "/approvals": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 1.75L13.25 3.75V7.75C13.25 11.1 10.95 13.35 8 14.25C5.05 13.35 2.75 11.1 2.75 7.75V3.75L8 1.75Z" strokeLinejoin="round" />
      <path d="M5.75 8L7.25 9.5L10.5 6.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  "/carriers": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 11.5L3.5 4.5H12.5L14 11.5H2Z" strokeLinejoin="round" />
      <path d="M5 7.5H11M2 13.5H14" strokeLinecap="round" />
    </svg>
  ),
  "/fleet": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1.5 4.5H10V11.5H1.5V4.5Z" strokeLinejoin="round" />
      <path d="M10 6.5H12.75L14.5 8.75V11.5H10V6.5Z" strokeLinejoin="round" />
      <circle cx="4.25" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
    </svg>
  ),
  "/warehouses": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 6.25L8 2.25L14 6.25V13.75H2V6.25Z" strokeLinejoin="round" />
      <path d="M5.5 13.75V9.25H10.5V13.75" strokeLinejoin="round" />
    </svg>
  ),
  "/customers": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="5.25" r="2.5" />
      <path d="M3 13.5C3 11.15 5.24 9.5 8 9.5C10.76 9.5 13 11.15 13 13.5" strokeLinecap="round" />
    </svg>
  ),
  "/support": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2.25 3.5H13.75V10.75H5.5L2.25 13.5V3.5Z" strokeLinejoin="round" />
    </svg>
  ),
  "/track": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M9.75 6.25L6.75 7.25L5.75 10.25L8.75 9.25L9.75 6.25Z" strokeLinejoin="round" />
    </svg>
  ),
  "/communications": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" />
      <path d="M2.25 4L8 8.25L13.75 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  "/documents": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 1.75H9.75L13 5V14.25H4V1.75Z" strokeLinejoin="round" />
      <path d="M9.5 1.75V5.25H13M6 8.5H10.5M6 11H9" strokeLinecap="round" />
    </svg>
  ),
  "/analytics": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2.5 13.5V9M6.25 13.5V6M10 13.5V8M13.5 13.5V3.5" strokeLinecap="round" />
    </svg>
  ),
  "/activity": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1.5 8H4.25L6.25 3.5L9.5 12.5L11.5 8H14.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  "/queue": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2.5" width="12" height="3" rx="0.75" />
      <rect x="2" y="6.5" width="12" height="3" rx="0.75" />
      <rect x="2" y="10.5" width="12" height="3" rx="0.75" />
    </svg>
  ),
  "/settings": (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.75V3.25M8 12.75V14.25M1.75 8H3.25M12.75 8H14.25M3.6 3.6L4.65 4.65M11.35 11.35L12.4 12.4M12.4 3.6L11.35 4.65M4.65 11.35L3.6 12.4" strokeLinecap="round" />
    </svg>
  ),
};

const SECTIONS: { group: string; items: { href: string; label: string }[] }[] = [
  {
    group: "Operations",
    items: [
      { href: "/", label: "Overview" },
      { href: "/map", label: "Shipments map" },
      { href: "/orders", label: "Orders" },
      { href: "/shipments", label: "Shipments" },
      { href: "/planning", label: "Planning" },
      { href: "/exceptions", label: "Exceptions" },
      { href: "/approvals", label: "Approvals" },
    ],
  },
  {
    group: "Network",
    items: [
      { href: "/carriers", label: "Carriers" },
      { href: "/fleet", label: "Fleet" },
      { href: "/warehouses", label: "Warehouses" },
    ],
  },
  {
    group: "Customer",
    items: [
      { href: "/customers", label: "Customers" },
      { href: "/support", label: "Support inbox" },
      { href: "/track", label: "Preview chat" },
    ],
  },
  {
    group: "Records",
    items: [
      { href: "/communications", label: "Communications" },
      { href: "/documents", label: "Documents" },
      { href: "/analytics", label: "Analytics" },
    ],
  },
  {
    group: "System",
    items: [
      { href: "/activity", label: "Activity" },
      { href: "/queue", label: "Work queue" },
      { href: "/settings", label: "Settings" },
    ],
  },
];

export function Nav({ orgName }: { orgName?: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      {orgName ? (
        <div className="brand">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M8 1.5L14 5V11L8 14.5L2 11V5L8 1.5Z" strokeLinejoin="round" />
                <circle cx="8" cy="8" r="2" fill="currentColor" />
              </svg>
            </span>
            <div className="brand-text">
              <span>Control Tower</span>
              <strong>{orgName}</strong>
            </div>
          </div>
          <button
            type="button"
            className="nav-toggle"
            aria-expanded={open}
            aria-controls="primary-navigation"
            onClick={() => setOpen((prev) => !prev)}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              {open ? (
                <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" strokeLinecap="round" />
              ) : (
                <path d="M2.5 4.5H13.5M2.5 8H13.5M2.5 11.5H13.5" strokeLinecap="round" />
              )}
            </svg>
            <span>{open ? "Close" : "Menu"}</span>
          </button>
        </div>
      ) : null}

      <nav id="primary-navigation" aria-label="Primary" className="nav">
        {SECTIONS.map((section) => (
          <div key={section.group}>
            <div className="nav-group">{section.group}</div>
            {section.items.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-active={active}
                  aria-current={active ? "page" : undefined}
                >
                  {ICONS[item.href]}
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );
}
