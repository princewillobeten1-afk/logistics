export type TransportMode = "ROAD" | "AIR" | "SEA" | "RAIL";

export const KNOWN_HUB_KM: Record<string, number> = {
  "lagos->abuja": 755,
  "abuja->lagos": 755,
  "lagos->kano": 1030,
  "kano->lagos": 1030,
  "lagos->port harcourt": 620,
  "port harcourt->lagos": 620,
  "lagos->ibadan": 130,
  "ibadan->lagos": 130,
  "lagos->accra": 470,
  "accra->lagos": 470,
  "lagos->abidjan": 985,
  "abidjan->lagos": 985,
  "lagos->tema": 445,
  "tema->lagos": 445,
  "lagos->cotonou": 120,
  "cotonou->lagos": 120,
  "kano->abuja": 420,
  "abuja->kano": 420,
  "abuja->port harcourt": 610,
  "port harcourt->abuja": 610,
  "port harcourt->kano": 1025,
  "kano->port harcourt": 1025,
  "apapa port->tema port": 480,
  "tema port->apapa port": 480,
  "lagos->london": 5000,
  "london->lagos": 5000,
  "lagos->rotterdam": 7100,
  "rotterdam->lagos": 7100,
  "hamburg->rotterdam": 460,
  "rotterdam->hamburg": 460,
  "dallas->los angeles": 2310,
  "los angeles->dallas": 2310,
};

const MODE_PROFILE: Record<
  TransportMode,
  { speedKmh: number; minHours: number; costMultiplier: number; co2ePerTonneKm: number }
> = {
  ROAD: { speedKmh: 55, minHours: 8, costMultiplier: 1.0, co2ePerTonneKm: 62 },
  AIR: { speedKmh: 550, minHours: 4, costMultiplier: 3.2, co2ePerTonneKm: 500 },
  RAIL: { speedKmh: 45, minHours: 10, costMultiplier: 0.78, co2ePerTonneKm: 22 },
  SEA: { speedKmh: 30, minHours: 24, costMultiplier: 0.55, co2ePerTonneKm: 16 },
};

export function normalizeTransportMode(raw?: string | null): TransportMode {
  const upper = raw?.trim().toUpperCase();
  if (upper === "AIR" || upper === "SEA" || upper === "RAIL" || upper === "ROAD") {
    return upper;
  }
  return "ROAD";
}

export function estimateLaneKm(origin?: string | null, destination?: string | null): number {
  const cleanOrigin = origin?.trim().toLowerCase() ?? "";
  const cleanDest = destination?.trim().toLowerCase() ?? "";
  if (!cleanOrigin || !cleanDest) return 450;
  if (cleanOrigin === cleanDest) return 25;
  const key = `${cleanOrigin}->${cleanDest}`;
  if (KNOWN_HUB_KM[key]) return KNOWN_HUB_KM[key];
  return 520;
}

export interface ShipmentPlanInput {
  originCity?: string | null;
  destinationCity?: string | null;
  weightKg?: number | null;
  preferredMode?: string | null;
  deadlineIso?: string | null;
  currency?: string | null;
  nowMs?: number;
}

export interface ShipmentPlanEstimate {
  mode: TransportMode;
  distanceKm: number;
  weightKg: number;
  transitHours: number;
  estimatedCostMinor: number;
  currency: string;
  co2eKg: number;
  deadlineIso: string;
  projectedDeliveryIso: string;
  meetsDeadline: boolean;
}

export function calculateShipmentPlan(input: ShipmentPlanInput): ShipmentPlanEstimate {
  const nowMs =
    typeof input.nowMs === "number" && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const mode = normalizeTransportMode(input.preferredMode);
  const profile = MODE_PROFILE[mode];
  const distanceKm = estimateLaneKm(input.originCity, input.destinationCity);
  const weightKg =
    typeof input.weightKg === "number" && Number.isFinite(input.weightKg) && input.weightKg > 0
      ? input.weightKg
      : 250;

  const parsedDeadline = input.deadlineIso ? new Date(input.deadlineIso) : null;
  const deadlineMs =
    parsedDeadline && !Number.isNaN(parsedDeadline.getTime())
      ? parsedDeadline.getTime()
      : nowMs + 72 * 3_600_000;

  const transitHours = Math.max(profile.minHours, Math.round(distanceKm / profile.speedKmh));
  const projectedDeliveryMs = nowMs + transitHours * 3_600_000;
  const meetsDeadline = projectedDeliveryMs <= deadlineMs;

  const baseMajorCost = distanceKm * 850 + weightKg * 120;
  const estimatedCostMinor = Math.round(baseMajorCost * profile.costMultiplier * 100);
  const co2eKg = Math.round(distanceKm * (weightKg / 1000) * profile.co2ePerTonneKm * 10) / 10;
  const currency = input.currency?.trim().toUpperCase() || "NGN";

  return {
    mode,
    distanceKm,
    weightKg,
    transitHours,
    estimatedCostMinor,
    currency,
    co2eKg,
    deadlineIso: new Date(deadlineMs).toISOString(),
    projectedDeliveryIso: new Date(projectedDeliveryMs).toISOString(),
    meetsDeadline,
  };
}

export interface ConveyanceCandidate {
  registration: string | null;
  active: boolean;
  assigned_to: string | null;
  capacity_kg: number | string | null;
  reefer: boolean;
  hazmat_certified: boolean;
  mode?: string | null;
}

export interface ShipmentRequirement {
  weightKg?: number | null;
  hazmat?: boolean;
  reefer?: boolean;
  preferredMode?: string | null;
}

function parseCapacityKg(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Selects the best-fit idle, active, compliant conveyance for a shipment.
 * Enforces hazmat, reefer, and weight capacity constraints and chooses the
 * tightest-capacity match so oversized vehicles stay free for heavier loads.
 */
export function matchBestConveyance(
  req: ShipmentRequirement,
  conveyances: ConveyanceCandidate[],
  excludedRegistrations?: ReadonlySet<string>,
): ConveyanceCandidate | null {
  const requiredWeight =
    typeof req.weightKg === "number" && Number.isFinite(req.weightKg) && req.weightKg > 0
      ? req.weightKg
      : 0;
  const preferredMode = req.preferredMode ? normalizeTransportMode(req.preferredMode) : null;

  const eligible = conveyances.filter((v) => {
    if (!v.active || v.assigned_to || !v.registration?.trim()) return false;
    const regKey = v.registration.trim().toUpperCase();
    if (excludedRegistrations?.has(regKey)) return false;
    if (req.hazmat && !v.hazmat_certified) return false;
    if (req.reefer && !v.reefer) return false;
    const cap = parseCapacityKg(v.capacity_kg);
    if (requiredWeight > 0 && cap !== null && cap < requiredWeight) {
      return false;
    }
    return true;
  });

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    if (preferredMode) {
      const aModeMatch = a.mode?.trim().toUpperCase() === preferredMode ? 0 : 1;
      const bModeMatch = b.mode?.trim().toUpperCase() === preferredMode ? 0 : 1;
      if (aModeMatch !== bModeMatch) return aModeMatch - bModeMatch;
    }
    const aCap = parseCapacityKg(a.capacity_kg) ?? Number.MAX_SAFE_INTEGER;
    const bCap = parseCapacityKg(b.capacity_kg) ?? Number.MAX_SAFE_INTEGER;
    if (aCap !== bCap) return aCap - bCap;
    return (a.registration ?? "").localeCompare(b.registration ?? "");
  });

  return eligible[0];
}
