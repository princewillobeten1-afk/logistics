"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ClipboardList,
  Compass,
  FileText,
  Hexagon,
  Layers,
  LayoutGrid,
  Mail,
  Map,
  Menu,
  MessageSquare,
  Package,
  Plug,
  Route,
  Settings,
  ShieldCheck,
  Ship,
  Truck,
  Users,
  Warehouse,
  X,
} from "lucide-react";

const ICONS: Record<string, ReactNode> = {
  "/": <LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/map": <Map size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/orders": <ClipboardList size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/shipments": <Package size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/planning": <Route size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/exceptions": <AlertTriangle size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/approvals": <ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/carriers": <Ship size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/fleet": <Truck size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/warehouses": <Warehouse size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/customers": <Users size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/support": <MessageSquare size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/track": <Compass size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/communications": <Mail size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/documents": <FileText size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/analytics": <BarChart3 size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/activity": <Activity size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/queue": <Layers size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/integrations": <Plug size={16} strokeWidth={1.75} aria-hidden="true" />,
  "/settings": <Settings size={16} strokeWidth={1.75} aria-hidden="true" />,
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
      { href: "/track", label: "Customer support" },
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
      { href: "/integrations", label: "Integrations" },
      { href: "/activity", label: "Activity" },
      { href: "/queue", label: "Work queue" },
      { href: "/settings", label: "Settings" },
    ],
  },
];

function NavLinks({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Primary" className="nav">
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
                onClick={onNavigate}
              >
                {ICONS[item.href]}
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function NavShell({
  orgName,
  account,
}: {
  orgName?: string;
  account: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* Desktop persistent sidebar */}
      <aside className="rail">
        <div className="brand">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">
              <Hexagon size={16} strokeWidth={2} />
            </span>
            <div className="brand-text">
              <span>Control Tower</span>
              <strong>{orgName || "Workspace"}</strong>
            </div>
          </div>
        </div>
        <NavLinks pathname={pathname} />
        {account}
      </aside>

      {/* Mobile compact sticky bar (<= 52px tall) */}
      <div className="mobile-bar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Hexagon size={15} strokeWidth={2} />
          </span>
          <div className="brand-text">
            <span>Control Tower</span>
            <strong>{orgName || "Workspace"}</strong>
          </div>
        </div>
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="mobile-navigation-drawer"
          onClick={() => setOpen(true)}
        >
          <Menu size={16} strokeWidth={2} aria-hidden="true" />
          <span>Menu</span>
        </button>
      </div>

      {/* Mobile slide-over drawer */}
      <AnimatePresence>
        {open ? (
          <motion.div
            className="mobile-drawer-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={() => setOpen(false)}
          >
            <motion.aside
              id="mobile-navigation-drawer"
              className="mobile-drawer"
              aria-label="Mobile navigation"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="brand">
                <div className="brand-lockup">
                  <span className="brand-mark" aria-hidden="true">
                    <Hexagon size={16} strokeWidth={2} />
                  </span>
                  <div className="brand-text">
                    <span>Control Tower</span>
                    <strong>{orgName || "Workspace"}</strong>
                  </div>
                </div>
                <button
                  type="button"
                  className="nav-close"
                  aria-label="Close navigation menu"
                  onClick={() => setOpen(false)}
                >
                  <X size={16} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
              <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
              {account}
            </motion.aside>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
