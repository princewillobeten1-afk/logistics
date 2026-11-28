"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  BrainCircuit,
  ChevronDown,
  ClipboardList,
  Compass,
  FileText,
  Layers,
  LayoutGrid,
  Mail,
  Map,
  Menu,
  MessageSquare,
  Package,
  Plug,
  RotateCcw,
  Route,
  Settings,
  ShieldCheck,
  Ship,
  SlidersHorizontal,
  Truck,
  Users,
  Warehouse,
  X,
} from "lucide-react";

const ICONS: Record<string, ReactNode> = {
  "/": <LayoutGrid size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/intelligence": <BrainCircuit size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/tactics": <SlidersHorizontal size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/map": <Map size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/orders": <ClipboardList size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/shipments": <Package size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/planning": <Route size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/returns": <RotateCcw size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/exceptions": <AlertTriangle size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/approvals": <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/carriers": <Ship size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/fleet": <Truck size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/warehouses": <Warehouse size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/customers": <Users size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/support": <MessageSquare size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/track": <Compass size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/communications": <Mail size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/documents": <FileText size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/analytics": <BarChart3 size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/activity": <Activity size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/queue": <Layers size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/integrations": <Plug size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/api-docs": <BookOpen size={15} strokeWidth={1.75} aria-hidden="true" />,
  "/settings": <Settings size={15} strokeWidth={1.75} aria-hidden="true" />,
};

const SECTIONS: { group: string; defaultOpen: boolean; items: { href: string; label: string }[] }[] = [
  {
    group: "Operations",
    defaultOpen: true,
    items: [
      { href: "/", label: "Overview" },
      { href: "/intelligence", label: "Business Intelligence" },
      { href: "/tactics", label: "Logistics tactics" },
      { href: "/map", label: "Shipments map" },
      { href: "/orders", label: "Orders" },
      { href: "/shipments", label: "Shipments" },
      { href: "/planning", label: "Planning" },
      { href: "/returns", label: "Returns & RMA" },
      { href: "/exceptions", label: "Exceptions" },
      { href: "/approvals", label: "Approvals" },
    ],
  },
  {
    group: "Network",
    defaultOpen: true,
    items: [
      { href: "/carriers", label: "Carriers" },
      { href: "/fleet", label: "Fleet" },
      { href: "/warehouses", label: "Warehouses" },
    ],
  },
  {
    group: "Customer",
    defaultOpen: false,
    items: [
      { href: "/customers", label: "Customers" },
      { href: "/support", label: "Support inbox" },
      { href: "/track", label: "Customer support" },
    ],
  },
  {
    group: "Records",
    defaultOpen: false,
    items: [
      { href: "/communications", label: "Communications" },
      { href: "/documents", label: "Documents" },
      { href: "/analytics", label: "Analytics" },
    ],
  },
  {
    group: "System",
    defaultOpen: false,
    items: [
      { href: "/integrations", label: "Integrations" },
      { href: "/api-docs", label: "API Docs" },
      { href: "/activity", label: "Activity" },
      { href: "/queue", label: "Work queue" },
      { href: "/settings", label: "Settings" },
    ],
  },
];

function BrandEmblem() {
  return (
    <span className="brand-mark brand-mark-logo" aria-hidden="true">
      <Image
        src="/images/landing/control-tower-logo.jpg"
        alt=""
        width={28}
        height={28}
        className="brand-mark-img"
        referrerPolicy="no-referrer"
      />
    </span>
  );
}

function activeGroupFor(pathname: string): string | null {
  for (const section of SECTIONS) {
    if (
      section.items.some((item) =>
        item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
      )
    ) {
      return section.group;
    }
  }
  return null;
}

function NavLinks({
  pathname,
  disabledSet,
  onNavigate,
}: {
  pathname: string;
  disabledSet: Set<string>;
  onNavigate?: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    const currentGroup = activeGroupFor(pathname);
    for (const s of SECTIONS) {
      initial[s.group] = s.defaultOpen || s.group === currentGroup;
    }
    return initial;
  });

  useEffect(() => {
    const currentGroup = activeGroupFor(pathname);
    if (currentGroup) {
      setExpanded((prev) =>
        prev[currentGroup] ? prev : { ...prev, [currentGroup]: true },
      );
    }
  }, [pathname]);

  function toggleGroup(group: string) {
    setExpanded((prev) => ({ ...prev, [group]: !prev[group] }));
  }

  return (
    <nav aria-label="Primary" className="nav">
      {SECTIONS.map((section) => {
        const visibleItems = section.items.filter(
          (item) => !disabledSet.has(item.href),
        );
        if (visibleItems.length === 0) return null;
        const isOpen = Boolean(expanded[section.group]);
        const groupId = `nav-group-${section.group.toLowerCase()}`;
        return (
          <div key={section.group} className="nav-section">
            <button
              type="button"
              className="nav-group-btn"
              aria-expanded={isOpen}
              aria-controls={groupId}
              onClick={() => toggleGroup(section.group)}
            >
              <span>{section.group}</span>
              <span className="nav-group-meta">
                {!isOpen ? (
                  <span className="nav-group-count">{visibleItems.length}</span>
                ) : null}
                <ChevronDown
                  size={12}
                  strokeWidth={2}
                  aria-hidden="true"
                  className="nav-group-chevron"
                  data-open={isOpen}
                />
              </span>
            </button>
            {isOpen ? (
              <div id={groupId} className="nav-group-items">
                {visibleItems.map((item) => {
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
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

export function NavShell({
  orgName,
  tierLabel,
  disabledHrefs = [],
  account,
}: {
  orgName?: string;
  tierLabel?: string | null;
  disabledHrefs?: string[];
  account: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const disabledSet = new Set(disabledHrefs);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      {/* Desktop persistent sidebar */}
      <aside className="rail">
        <div className="brand">
          <div className="brand-lockup">
            <BrandEmblem />
            <div className="brand-text">
              <span>{tierLabel ? `Control Tower · ${tierLabel.split(" · ")[0]}` : "Control Tower"}</span>
              <strong>{orgName || "Workspace"}</strong>
            </div>
          </div>
        </div>
        <NavLinks pathname={pathname} disabledSet={disabledSet} />
        {account}
      </aside>

      {/* Mobile compact sticky bar (<= 54px tall) */}
      <div className="mobile-bar">
        <div className="brand-lockup">
          <BrandEmblem />
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
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
            >
              <div className="brand">
                <div className="brand-lockup">
                  <BrandEmblem />
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
              <NavLinks pathname={pathname} disabledSet={disabledSet} onNavigate={() => setOpen(false)} />
              {account}
            </motion.aside>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
