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

export type StockHealth = "CRITICAL" | "REORDER" | "HEALTHY";

export interface InventoryEconomicsInput {
  onHand: number;
  reserved: number;
  safetyStock: number;
  reorderPoint: number;
  reorderQuantity: number;
  unitCostMinor: number;
  annualHoldingRate: number;
}

export interface InventoryEconomics {
  available: number;
  stockHealth: StockHealth;
  inventoryValueMinor: number;
  annualHoldingCostMinor: number;
  dailyHoldingCostMinor: number;
  suggestedReorderQty: number;
}

/** Compute stock health, valuation, carrying cost, and replenishment size. */
export function computeInventoryEconomics(input: InventoryEconomicsInput): InventoryEconomics {
  const onHand = Math.max(0, Math.round(input.onHand));
  const reserved = Math.max(0, Math.round(input.reserved));
  const available = Math.max(0, onHand - reserved);
  const safety = Math.max(0, Math.round(input.safetyStock));
  const rop = Math.max(0, Math.round(input.reorderPoint));
  const reorderQty = Math.max(1, Math.round(input.reorderQuantity || 100));
  const unitCost = Math.max(0, Math.round(input.unitCostMinor));
  const rate = Number.isFinite(input.annualHoldingRate) && input.annualHoldingRate >= 0
    ? input.annualHoldingRate
    : 0.2;

  const inventoryValueMinor = onHand * unitCost;
  const annualHoldingCostMinor = Math.round(inventoryValueMinor * rate);
  const dailyHoldingCostMinor = annualHoldingCostMinor > 0 ? Math.round(annualHoldingCostMinor / 365) : 0;

  let stockHealth: StockHealth = "HEALTHY";
  if (available <= safety) {
    stockHealth = "CRITICAL";
  } else if (available <= rop) {
    stockHealth = "REORDER";
  }

  const target = rop + safety + reorderQty;
  const suggestedReorderQty = stockHealth === "HEALTHY" ? 0 : Math.max(reorderQty, target - available);

  return {
    available,
    stockHealth,
    inventoryValueMinor,
    annualHoldingCostMinor,
    dailyHoldingCostMinor,
    suggestedReorderQty,
  };
}

export interface ConsolidationCandidateItem {
  shipmentId: string;
  reference: string;
  originCity: string;
  destinationCity: string;
  mode: string;
  loadType: string;
  weightKg: number;
  volumeCbm?: number;
  estimatedCostMinor?: number;
  currency?: string;
}

export interface ConsolidationPoolResult {
  originCity: string;
  destinationCity: string;
  mode: TransportMode;
  loadType: "CONSOLIDATED_LTL" | "CONSOLIDATED_LCL";
  items: ConsolidationCandidateItem[];
  totalWeightKg: number;
  totalVolumeCbm: number;
  utilizationPct: number;
  estimatedSavingsMinor: number;
  currency: string;
}

const CONSOLIDATABLE_TYPES = new Set(["LTL", "LCL", "CONSOLIDATED"]);

/** Pool >= 2 small LTL/LCL shipments on the same lane/mode within vehicle capacity. */
export function poolConsolidatableShipments(
  candidates: ConsolidationCandidateItem[],
  options?: { maxWeightKg?: number; maxVolumeCbm?: number },
): ConsolidationPoolResult[] {
  const maxWeightKg = options?.maxWeightKg && options.maxWeightKg > 0 ? options.maxWeightKg : 15_000;
  const maxVolumeCbm = options?.maxVolumeCbm && options.maxVolumeCbm > 0 ? options.maxVolumeCbm : 45;

  const byLane = new Map<string, ConsolidationCandidateItem[]>();
  for (const cand of candidates) {
    const loadType = cand.loadType.trim().toUpperCase();
    if (!CONSOLIDATABLE_TYPES.has(loadType)) continue;
    const origin = cand.originCity.trim();
    const dest = cand.destinationCity.trim();
    if (!origin || !dest || origin === "—" || dest === "—") continue;
    const mode = normalizeTransportMode(cand.mode);
    const key = `${origin.toLowerCase()}->${dest.toLowerCase()}::${mode}`;
    const list = byLane.get(key) ?? [];
    list.push(cand);
    byLane.set(key, list);
  }

  const pools: ConsolidationPoolResult[] = [];
  for (const items of byLane.values()) {
    if (items.length < 2) continue;
    const sorted = [...items].sort((a, b) => b.weightKg - a.weightKg || a.reference.localeCompare(b.reference));
    let bucket: ConsolidationCandidateItem[] = [];
    let wSum = 0;
    let vSum = 0;

    const flush = () => {
      if (bucket.length < 2) return;
      const mode = normalizeTransportMode(bucket[0].mode);
      const util = Math.round(
        Math.min(100, Math.max((wSum / maxWeightKg) * 100, (vSum / maxVolumeCbm) * 100)) * 100,
      ) / 100;
      const separateCost = bucket.reduce((acc, item) => acc + Math.max(0, item.estimatedCostMinor ?? 0), 0);
      const estimatedSavingsMinor =
        separateCost > 0 ? Math.round(separateCost * 0.28) : (bucket.length - 1) * 4_500_000;
      pools.push({
        originCity: bucket[0].originCity.trim(),
        destinationCity: bucket[0].destinationCity.trim(),
        mode,
        loadType: mode === "SEA" ? "CONSOLIDATED_LCL" : "CONSOLIDATED_LTL",
        items: [...bucket],
        totalWeightKg: Math.round(wSum * 1000) / 1000,
        totalVolumeCbm: Math.round(vSum * 10000) / 10000,
        utilizationPct: util,
        estimatedSavingsMinor,
        currency: bucket[0].currency?.trim().toUpperCase() || "NGN",
      });
    };

    for (const item of sorted) {
      const w = Math.max(0, Number.isFinite(item.weightKg) ? item.weightKg : 0);
      const v =
        typeof item.volumeCbm === "number" && Number.isFinite(item.volumeCbm) && item.volumeCbm > 0
          ? item.volumeCbm
          : Math.max(0.05, w / 333);
      if (bucket.length > 0 && (wSum + w > maxWeightKg || vSum + v > maxVolumeCbm)) {
        flush();
        bucket = [item];
        wSum = w;
        vSum = v;
      } else {
        bucket.push(item);
        wSum += w;
        vSum += v;
      }
    }
    flush();
  }

  return pools;
}
