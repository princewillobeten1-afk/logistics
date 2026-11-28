export type CommandGroup =
  | "Quick Actions"
  | "Operations"
  | "Network"
  | "Customer"
  | "Records"
  | "System";

export interface CommandItem {
  id: string;
  label: string;
  description: string;
  href: string;
  group: CommandGroup;
  keywords: string[];
}

export const COMMAND_ITEMS: CommandItem[] = [
  // Operations
  {
    id: "route-overview",
    label: "Overview",
    description: "Executive control tower KPIs, corridor map, and live telemetry",
    href: "/",
    group: "Operations",
    keywords: ["dashboard", "home", "kpi", "control tower"],
  },
  {
    id: "route-intelligence",
    label: "Business Intelligence",
    description: "Executive operational insights, benchmarks, and margin signals",
    href: "/intelligence",
    group: "Operations",
    keywords: ["bi", "insights", "metrics", "reports"],
  },
  {
    id: "route-tactics",
    label: "Logistics Tactics",
    description: "Scenario modeling, mode optimization, and corridor strategy",
    href: "/tactics",
    group: "Operations",
    keywords: ["strategy", "optimization", "playbooks"],
  },
  {
    id: "route-map",
    label: "Shipments Map",
    description: "Live geospatial map of corridors, hubs, and active freight",
    href: "/map",
    group: "Operations",
    keywords: ["geo", "gps", "corridor", "routes", "tracking"],
  },
  {
    id: "route-orders",
    label: "Orders",
    description: "Intake, 3PL multi-client fulfillment, and international freight orders",
    href: "/orders",
    group: "Operations",
    keywords: ["intake", "new order", "3pl", "customs", "freight", "create"],
  },
  {
    id: "route-shipments",
    label: "Shipments",
    description: "End-to-end consignment tracking, milestones, and proof of delivery",
    href: "/shipments",
    group: "Operations",
    keywords: ["consignments", "tracking", "pod", "delivery", "dispatch"],
  },
  {
    id: "route-planning",
    label: "Planning",
    description: "Route planning, load allocation, and carrier dispatch scheduling",
    href: "/planning",
    group: "Operations",
    keywords: ["routing", "dispatch", "schedule", "allocation"],
  },
  {
    id: "route-returns",
    label: "Returns & RMA",
    description: "Reverse logistics authorizations, inspections, and disposition",
    href: "/returns",
    group: "Operations",
    keywords: ["rma", "reverse", "refund", "claims"],
  },
  {
    id: "route-exceptions",
    label: "Exceptions",
    description: "Delay escalations, customs holds, and incident remediation",
    href: "/exceptions",
    group: "Operations",
    keywords: ["delays", "alerts", "incidents", "issues", "escalations"],
  },
  {
    id: "route-approvals",
    label: "Approvals",
    description: "Policy-gated spend authorizations and human-in-the-loop sign-off",
    href: "/approvals",
    group: "Operations",
    keywords: ["spend", "policy", "authorize", "review", "sign-off"],
  },

  // Network
  {
    id: "route-carriers",
    label: "Carriers",
    description: "Carrier directory, rate cards, lane coverage, and SLA scoring",
    href: "/carriers",
    group: "Network",
    keywords: ["vendors", "rates", "sla", "dhl", "fedex", "freight"],
  },
  {
    id: "route-fleet",
    label: "Fleet",
    description: "Vehicles, driver assignments, capacity, and maintenance status",
    href: "/fleet",
    group: "Network",
    keywords: ["vehicles", "trucks", "drivers", "assets"],
  },
  {
    id: "route-warehouses",
    label: "Warehouses",
    description: "Fulfillment centers, bay capacity, inventory, and dock dispatch",
    href: "/warehouses",
    group: "Network",
    keywords: ["hubs", "inventory", "stock", "depots", "storage"],
  },

  // Customer
  {
    id: "route-customers",
    label: "Customers",
    description: "Shipper accounts, SLA tiers, and 3PL client profiles",
    href: "/customers",
    group: "Customer",
    keywords: ["clients", "accounts", "crm", "shippers"],
  },
  {
    id: "route-support",
    label: "Support Inbox",
    description: "Operator triage queue for customer inquiries and AI handoffs",
    href: "/support",
    group: "Customer",
    keywords: ["tickets", "inbox", "helpdesk", "handoff"],
  },
  {
    id: "route-track",
    label: "Customer Support Portal",
    description: "Public shipment lookup and customer self-service status view",
    href: "/track",
    group: "Customer",
    keywords: ["portal", "lookup", "status"],
  },

  // Records
  {
    id: "route-communications",
    label: "Communications",
    description: "Email, WhatsApp, and Telegram dispatch notifications log",
    href: "/communications",
    group: "Records",
    keywords: ["email", "messages", "notifications", "whatsapp", "telegram"],
  },
  {
    id: "route-documents",
    label: "Documents",
    description: "Bills of lading, commercial invoices, customs packs, and PODs",
    href: "/documents",
    group: "Records",
    keywords: ["bol", "awb", "customs", "invoice", "files", "pod"],
  },
  {
    id: "route-analytics",
    label: "Analytics",
    description: "On-time performance, cost per km, carrier reliability, and volume",
    href: "/analytics",
    group: "Records",
    keywords: ["charts", "otif", "kpi", "performance"],
  },

  // System
  {
    id: "route-integrations",
    label: "Integrations",
    description: "Webhooks, ERP connectors, carrier APIs, and channel bridges",
    href: "/integrations",
    group: "System",
    keywords: ["webhooks", "erp", "connectors", "api", "sync"],
  },
  {
    id: "route-api-docs",
    label: "API Docs",
    description: "REST API schemas, authentication, and webhook signatures",
    href: "/api-docs",
    group: "System",
    keywords: ["developer", "openapi", "endpoints", "sdk"],
  },
  {
    id: "route-activity",
    label: "Activity",
    description: "Immutable audit trail of operator actions and agent decisions",
    href: "/activity",
    group: "System",
    keywords: ["audit", "log", "history", "compliance"],
  },
  {
    id: "route-queue",
    label: "Work Queue",
    description: "Background orchestration jobs, retries, and dead-letter triage",
    href: "/queue",
    group: "System",
    keywords: ["jobs", "workers", "dead letter", "retries"],
  },
  {
    id: "route-settings",
    label: "Settings",
    description: "Workspace business configuration, RBAC users, and spend policies",
    href: "/settings",
    group: "System",
    keywords: ["config", "business tier", "rbac", "users", "entitlements", "admin"],
  },
];

export function isShipmentReference(raw: string): boolean {
  const trimmed = raw.trim();
  return /^[a-z]{2,5}[-_]?\d{3,}$/i.test(trimmed);
}

export function filterCommandItems(
  rawQuery: string,
  items: CommandItem[] = COMMAND_ITEMS,
): CommandItem[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) {
    return items;
  }

  const scored = items
    .map((item) => {
      const label = item.label.toLowerCase();
      const desc = item.description.toLowerCase();
      const group = item.group.toLowerCase();
      const href = item.href.toLowerCase();
      const kw = item.keywords.map((k) => k.toLowerCase());

      let score = 0;
      if (label === q) score = 100;
      else if (label.startsWith(q)) score = 85;
      else if (kw.some((k) => k === q)) score = 80;
      else if (kw.some((k) => k.startsWith(q))) score = 70;
      else if (label.includes(q)) score = 60;
      else if (href.includes(q)) score = 50;
      else if (kw.some((k) => k.includes(q))) score = 45;
      else if (group.startsWith(q)) score = 35;
      else if (desc.includes(q)) score = 25;

      return { item, score };
    })
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
  return scored.map((entry) => entry.item);
}

export function resolveCommandTarget(
  rawQuery: string,
  selectedItem?: CommandItem | null,
): string | null {
  if (selectedItem) {
    return selectedItem.href;
  }
  const trimmed = rawQuery.trim();
  if (!trimmed) return null;
  if (isShipmentReference(trimmed)) {
    return `/shipments/${encodeURIComponent(trimmed.toUpperCase())}`;
  }
  return `/shipments?q=${encodeURIComponent(trimmed)}`;
}
