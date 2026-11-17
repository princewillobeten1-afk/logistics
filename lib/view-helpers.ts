export interface ShipmentFilterable {
  id: string;
  reference: string;
  state: string;
  customer_ref: string | null;
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

    const haystack = [
      s.reference,
      s.state,
      formatStateLabel(s.state),
      s.customer_ref ?? "",
      extractCity(s.origin),
      extractCity(s.destination),
      String(s.origin?.address ?? ""),
      String(s.destination?.address ?? ""),
      String(s.cargo?.description ?? ""),
      String(s.cargo?.sku ?? ""),
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(q);
  });
}

export function buildMockAssistantReply(params: {
  reference: string;
  question: string;
  state: string;
  originCity: string;
  destinationCity: string;
  customer: string | null;
  exceptionSummary?: string | null;
  quoteSummary?: string | null;
}): { body: string; next_step: string; confidence: string } {
  const q = params.question.toLowerCase();
  const lane = `${params.originCity || "Origin"} → ${params.destinationCity || "Destination"}`;

  if (q.includes("delay") || q.includes("why") || q.includes("exception")) {
    if (params.exceptionSummary) {
      return {
        body: `${params.reference} (${lane}) is currently flagged under ${formatStateLabel(params.state)}: ${params.exceptionSummary}`,
        next_step: "Review the active exception and confirm reroute or revised ETA with the carrier.",
        confidence: "0.92",
      };
    }
    return {
      body: `${params.reference} (${lane}) is in ${formatStateLabel(params.state)}. No active delay exceptions are raised on this corridor.`,
      next_step: "Monitor the next carrier milestone update on the timeline.",
      confidence: "0.89",
    };
  }

  if (q.includes("alternative") || q.includes("carrier") || q.includes("quote") || q.includes("option")) {
    return {
      body: params.quoteSummary
        ? `Available carrier options for ${params.reference} (${lane}): ${params.quoteSummary}. Quotes are ranked deterministically using cost, on-time history, and damage rate.`
        : `No live carrier quotes have closed for ${params.reference} yet; deterministic routing is evaluating approved road and multimodal carriers on ${lane}.`,
      next_step: "Compare the scored carrier quotes below or approve the top-ranked proposal.",
      confidence: "0.90",
    };
  }

  if (q.includes("customer") || q.includes("told") || q.includes("notify")) {
    return {
      body: `Customer notifications for ${params.customer ?? "this account"} on ${params.reference} are synced through the outbound communications log. Latest shipment status exposed to the customer is "${formatStateLabel(params.state)}".`,
      next_step: "Send a proactive update via Support Inbox or Gmail if an ETA shift exceeds SLA.",
      confidence: "0.87",
    };
  }

  return {
    body: `${params.reference} for ${params.customer ?? "the customer"} (${lane}) is currently ${formatStateLabel(params.state)}. ${params.exceptionSummary ? `Active note: ${params.exceptionSummary}` : "All validation and allocation checks passed."}`,
    next_step:
      params.state === "AWAITING_APPROVAL"
        ? "Open Approvals to authorize or reject the pending carrier spend."
        : "Check the itinerary legs and event timeline below for the next scheduled handoff.",
    confidence: "0.91",
  };
}

export function buildMockSupportReply(params: {
  reference: string | null;
  question: string;
  status?: string;
  origin?: string | null;
  destination?: string | null;
  promisedBy?: string | null;
  carrier?: string | null;
  delayed?: boolean;
}): string {
  const q = params.question.toLowerCase();
  if (!params.reference) {
    if (q.includes("book") || q.includes("send") || q.includes("carton")) {
      return "I can help set up a new shipment booking. Share the pickup address, delivery destination, cargo weight (kg), and target delivery date — or enter an existing shipment reference above (such as LG-82931 or LG-90014) to inspect live tracking.";
    }
    return "Enter a shipment reference above (for example LG-82931, LG-82932, or LG-90014) to view its live status, or tell me the origin, destination, and cargo details for a new shipment request.";
  }

  const lane = `${params.origin ?? "origin"} to ${params.destination ?? "destination"}`;
  if (q.includes("delay") || q.includes("why")) {
    return params.delayed
      ? `Shipment ${params.reference} (${lane}) is currently experiencing a schedule delay while awaiting clearance/rerouting. Our operations team is actively coordinating the next milestone.`
      : `Shipment ${params.reference} (${lane}) is currently ${params.status ?? "in progress"} with no active delays reported.`;
  }
  if (q.includes("who") || q.includes("carrier") || q.includes("deliver")) {
    return params.carrier
      ? `Shipment ${params.reference} is being handled by carrier ${params.carrier}.`
      : `Carrier assignment for ${params.reference} is currently being finalized by our dispatch team.`;
  }
  if (q.includes("when") || q.includes("arrive") || q.includes("eta")) {
    return params.promisedBy
      ? `Shipment ${params.reference} (${lane}) is targeted for delivery by ${new Date(params.promisedBy).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}. Current stage: ${params.status ?? "In progress"}.`
      : `Delivery timing for ${params.reference} (${lane}) is being confirmed. Current stage: ${params.status ?? "In progress"}.`;
  }
  return `Shipment ${params.reference} (${lane}) is currently "${params.status ?? "In progress"}". Let me know if you need the expected arrival window or carrier update.`;
}
