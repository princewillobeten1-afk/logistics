export interface ShipmentFilterable {
  id: string;
  reference: string;
  state: string;
  customer_ref: string | null;
  customer_name?: string | null;
  origin: Record<string, unknown>;
  destination: Record<string, unknown>;
  cargo: Record<string, unknown>;
  deadline: Date | string | null;
  updated_at: Date | string;
}

const STATE_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  NEEDS_INFO: "Needs info",
  VALIDATED: "Validated",
  ALLOCATED: "Allocated",
  PLANNED: "Planned",
  SOURCING: "Sourcing",
  AWAITING_APPROVAL: "Awaiting approval",
  BOOKED: "Booked",
  IN_TRANSIT: "In transit",
  EXCEPTION: "Exception",
  DELIVERED: "Delivered",
  POD_VERIFIED: "POD verified",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
  AT_ORIGIN: "At origin",
  AT_DESTINATION: "At destination",
  HANDED_OFF: "Handed off",
  COMPLETED: "Completed",
  PENDING: "Pending",
  RUNNING: "Running",
  DONE: "Done",
  DEAD: "Dead letter",
  OK: "Healthy",
  ALERT: "Action needed",
  ERROR: "Error",
  INVALID_OUTPUT: "Invalid output",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  INBOUND: "Inbound",
  OUTBOUND: "Outbound",
  CLEARED: "Cleared",
  HELD: "Held",
  SUBMITTED: "Submitted",
  VERIFIED: "Verified",
  LIVE: "Live",
  CONNECTED: "Connected",
  RECEIVED: "Received",
  SENT: "Sent",
  ROAD: "Road",
  AIR: "Air",
  SEA: "Sea",
  RAIL: "Rail",
  API: "API",
  MANUAL: "Manual",
  EMAIL: "Email",
  TELEGRAM: "Telegram",
  WHATSAPP: "WhatsApp",
  WIDGET: "Widget",
  GMAIL: "Gmail",
  GOOGLE_SIGN_IN: "Google Sign-In",
  REQUIRE_APPROVAL: "Require approval",
  HUMAN: "Human",
  SYSTEM: "System",
  AGENT: "Agent",
  PARSED: "Parsed",
  QUOTED: "Quoted",
  SELECTED: "Selected",
};

export function formatStateLabel(state: string): string {
  const key = state.trim().toUpperCase().replace(/\s+/g, "_");
  if (STATE_LABELS[key]) return STATE_LABELS[key];
  const cleaned = state.replace(/[_-]+/g, " ").trim().toLowerCase();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "—";
}

export function extractCity(loc: Record<string, unknown> | null | undefined): string {
  if (!loc) return "";
  return String(loc.city ?? loc.warehouse ?? loc.address ?? "").trim();
}

function locationSearchText(loc: Record<string, unknown> | null | undefined): string {
  if (!loc) return "";
  return [loc.city, loc.warehouse, loc.address, loc.country, loc.code]
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
    .map((v) => String(v).trim())
    .join(" ")
    .toLowerCase();
}

export function filterShipments<T extends ShipmentFilterable>(
  shipments: T[],
  options: { query?: string; state?: string },
): T[] {
  const targetState = options.state?.trim().toUpperCase();
  const q = options.query?.trim().toLowerCase();

  return shipments.filter((s) => {
    if (targetState && targetState !== "ALL" && s.state.toUpperCase() !== targetState) {
      return false;
    }
    if (!q) return true;

    const originText = locationSearchText(s.origin);
    const destinationText = locationSearchText(s.destination);

    // Support directional route queries like "Lagos -> Abuja" or "Lagos → Abuja"
    const arrowMatch = q.match(/^(.*?)\s*(?:->|→)\s*(.*)$/);
    if (arrowMatch) {
      const fromTerm = arrowMatch[1].trim();
      const toTerm = arrowMatch[2].trim();
      const fromOk = !fromTerm || originText.includes(fromTerm);
      const toOk = !toTerm || destinationText.includes(toTerm);
      return fromOk && toOk;
    }

    const originCity = extractCity(s.origin);
    const destCity = extractCity(s.destination);
    const routePhrase = originCity && destCity ? `${originCity} to ${destCity}` : "";

    const haystack = [
      s.reference,
      s.state,
      formatStateLabel(s.state),
      s.customer_ref ?? "",
      s.customer_name ?? "",
      originText,
      destinationText,
      routePhrase,
      String(s.cargo?.description ?? ""),
      String(s.cargo?.sku ?? ""),
    ]
      .join(" ")
      .toLowerCase();

    if (haystack.includes(q)) return true;

    const tokens = q.split(/\s+/).filter(Boolean);
    return tokens.length > 1 && tokens.every((token) => haystack.includes(token));
  });
}
