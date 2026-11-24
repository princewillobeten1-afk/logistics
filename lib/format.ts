/** Shipment states, grouped by what the operator must do about them. */
export type Tone = "neutral" | "progress" | "waiting" | "alert" | "done";

const TONES: Record<string, Tone> = {
  DRAFT: "neutral",
  NEEDS_INFO: "waiting",
  VALIDATED: "progress",
  ALLOCATED: "progress",
  PLANNED: "progress",
  SOURCING: "waiting",
  AWAITING_APPROVAL: "alert",
  BOOKED: "progress",
  IN_TRANSIT: "progress",
  EXCEPTION: "alert",
  DELIVERED: "done",
  POD_VERIFIED: "done",
  CLOSED: "done",
  CANCELLED: "neutral",
  FAILED: "alert",
  // leg states
  AT_ORIGIN: "progress",
  AT_DESTINATION: "progress",
  HANDED_OFF: "waiting",
  COMPLETED: "done",
  // work item + run states
  PENDING: "neutral",
  RUNNING: "progress",
  DONE: "done",
  DEAD: "alert",
  OK: "done",
  ERROR: "alert",
  INVALID_OUTPUT: "alert",
};

export function toneFor(state: string): Tone {
  return TONES[state] ?? "neutral";
}

/** Money is integer minor units. Two decimals covers every currency in use;
 *  JPY would need the exponent from the currencies table. */
export function money(minor: string | number | null, currency = "NGN"): string {
  if (minor === null || minor === undefined) return "—";
  const value = Number(minor) / 100;
  const symbol = { NGN: "₦", USD: "$", EUR: "€", GBP: "£" }[currency] ?? "";
  return `${symbol}${value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

export function when(date: Date | string | null): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function whenUtc(date: Date | string | null): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

export function relative(date: Date | string | null): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  const seconds = (Date.now() - d.getTime()) / 1000;
  const future = seconds < 0;
  const s = Math.abs(seconds);

  const [value, unit] =
    s < 60 ? [Math.round(s), "s"]
    : s < 3600 ? [Math.round(s / 60), "m"]
    : s < 86400 ? [Math.round(s / 3600), "h"]
    : [Math.round(s / 86400), "d"];

  return future ? `in ${value}${unit}` : `${value}${unit} ago`;
}

export function labelFor(key: string): string {
  return key.replace(/[._]/g, " ");
}

export function city(location: Record<string, unknown> | null): string {
  if (!location) return "—";
  return (
    (location.city as string) ||
    (location.warehouse as string) ||
    (location.address as string) ||
    "—"
  );
}
