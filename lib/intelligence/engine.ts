import type { Role } from "@/lib/auth";
import { computeLogisticsReadiness } from "@/lib/driver-dispatch";
import { applyBiRoleRedaction, getBiAccessPolicy } from "@/lib/intelligence/access";
import type {
  BiComparisonSuite,
  BiDepartmentId,
  BiPeriodDays,
  BiQueryResponse,
  BiRecommendation,
  BiSnapshot,
  ComparisonRow,
  DataProvenance,
  DepartmentScorecard,
  DepartmentStatus,
  ExecutiveKpi,
  Forecast30dModeProjection,
  Forecast30dPoint,
  Forecast30dWeeklyBucket,
  ForecastSummary,
  MethodologyNote,
  PredictiveForecast30d,
  ProactiveAlert,
  TrendForecastPoint,
} from "@/lib/intelligence/types";
import type {
  ConveyanceRow,
  CustomerRow,
  DocumentRow,
  DriverRow,
  ShipmentRow,
} from "@/lib/queries";

export interface BiLegInput {
  shipment_id: string;
  sequence: number;
  mode: string;
  state: string;
  distance_km: string | number | null;
  cost_minor: string | number | null;
  currency: string | null;
  co2e_kg: string | number | null;
}

export interface BiQuoteInput {
  id: string;
  shipment_id: string;
  state: string;
  amount_minor: string | number | null;
  currency: string | null;
  carrier_name?: string | null;
}

export interface BiWarehouseInput {
  id: string;
  code: string;
  name: string;
  dispatch_lead_hours: string | number;
  handles_hazmat: boolean;
  handles_reefer: boolean;
  active: boolean;
  city: string | null;
  country: string | null;
  skus: string | number | null;
  on_hand: string | number | null;
  reserved: string | number | null;
}

export interface BiInventoryInput {
  warehouse: string;
  sku: string;
  on_hand: number;
  reserved: number;
  available: number;
}

export interface BiOrderInput {
  id: string;
  reference: string;
  state: string;
  source: string;
  currency: string;
  ordered_at: Date | string;
  required_by: Date | string | null;
  customer: string | null;
  items: string | number;
}

export interface BiExceptionInput {
  id: string;
  kind: string;
  severity: string;
  detected_by: string;
  detail: Record<string, unknown>;
  created_at: Date | string;
  reference: string | null;
}

export interface BiApprovalInput {
  id: string;
  summary: string;
  amount_minor: string | number | null;
  currency: string;
  requested_at: Date | string;
  reference: string | null;
}

export interface BiCommunicationInput {
  id: string;
  channel: string;
  direction: string;
  state: string;
  created_at: Date | string;
  reference: string | null;
}

export interface BiCustomsInput {
  id: string;
  direction: string;
  clearance_state: string;
  reference: string | null;
}

export interface BiRawInputs {
  orgName: string;
  currency?: string;
  shipments: ShipmentRow[];
  legs: BiLegInput[];
  quotes: BiQuoteInput[];
  warehouses: BiWarehouseInput[];
  inventory: BiInventoryInput[];
  conveyances: ConveyanceRow[];
  drivers: DriverRow[];
  orders: BiOrderInput[];
  customers: CustomerRow[];
  exceptions: BiExceptionInput[];
  approvals: BiApprovalInput[];
  communications: BiCommunicationInput[];
  documents: DocumentRow[];
  customs: BiCustomsInput[];
  queueCounts: Record<string, number>;
  deadWorkCount: number;
  spendCeilingMinor?: number | null;
}

const DAY_MS = 86_400_000;
const CONVERTED_STATES = new Set([
  "BOOKED",
  "IN_TRANSIT",
  "DELIVERED",
  "POD_VERIFIED",
  "CLOSED",
]);
const CLOSED_STATES = new Set(["DELIVERED", "POD_VERIFIED", "CLOSED"]);
const TERMINAL_STATES = new Set(["CLOSED", "CANCELLED", "FAILED"]);

// Transparently documented fuel proxy coefficients (per km by mode, in USD baseline)
// Converted to workspace currency via CURRENCY_SCALE for ESTIMATE metrics only.
const FUEL_INDEX_USD_PER_KM: Record<string, number> = {
  ROAD: 0.42,
  AIR: 1.85,
  SEA: 0.14,
  RAIL: 0.21,
};

const CURRENCY_BENCHMARK_SCALE: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  NGN: 1550,
};

function benchmarkScale(currency: string): number {
  return CURRENCY_BENCHMARK_SCALE[currency.toUpperCase()] ?? 1;
}

const TARGET_GROSS_MARGIN_RATE = 0.24; // Documented 24% target freight brokerage/3PL margin benchmark (ESTIMATE)

const DEPT_META: Record<BiDepartmentId, { name: string; deepLink: string }> = {
  finance: { name: "Finance", deepLink: "/approvals" },
  operations: { name: "Operations", deepLink: "/exceptions" },
  fleet: { name: "Fleet Management", deepLink: "/fleet" },
  shipments: { name: "Shipments", deepLink: "/shipments" },
  dispatch: { name: "Dispatch", deepLink: "/fleet" },
  warehousing: { name: "Warehousing", deepLink: "/warehouses" },
  sales: { name: "Sales", deepLink: "/orders" },
  customers: { name: "Customers", deepLink: "/customers" },
  hr: { name: "Human Resources", deepLink: "/fleet" },
};

function toMs(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const ms = new Date(d).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function pctDelta(current: number, prior: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return null;
  if (prior === 0) {
    if (current === 0) return 0;
    return null;
  }
  return Math.round(((current - prior) / Math.abs(prior)) * 1000) / 10;
}

export function formatMoneyMajor(major: number, currency = "USD"): string {
  const sym =
    currency === "NGN"
      ? "₦"
      : currency === "EUR"
        ? "€"
        : currency === "GBP"
          ? "£"
          : "$";
  const abs = Math.abs(major);
  const sign = major < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${sym}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}${sym}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${sym}${Math.round(abs).toLocaleString("en-US")}`;
}

function statusFromScore(score: number, hasData: boolean): DepartmentStatus {
  if (!hasData) return "NO_DATA";
  if (score >= 78) return "HEALTHY";
  if (score >= 55) return "WATCH";
  return "CRITICAL";
}

function resolveShipmentCostMajor(
  s: ShipmentRow,
  legsByShipment: Map<string, BiLegInput[]>,
  selectedQuoteByShipment: Map<string, BiQuoteInput>,
): { major: number; provenance: DataProvenance } {
  const sLegs = legsByShipment.get(s.id) ?? [];
  const legCostMinor = sLegs.reduce((sum, l) => sum + num(l.cost_minor, 0), 0);
  if (legCostMinor > 0) {
    return { major: legCostMinor / 100, provenance: "VERIFIED" };
  }
  const quote = selectedQuoteByShipment.get(s.id);
  const quoteMinor = quote ? num(quote.amount_minor, 0) : 0;
  if (quoteMinor > 0) {
    return { major: quoteMinor / 100, provenance: "VERIFIED" };
  }
  const planMinor = num((s.plan as Record<string, unknown> | null)?.estimated_cost_minor, 0);
  if (planMinor > 0) {
    return { major: planMinor / 100, provenance: "ESTIMATE" };
  }
  return { major: 0, provenance: "ESTIMATE" };
}

function resolveShipmentKmAndCo2(
  s: ShipmentRow,
  legsByShipment: Map<string, BiLegInput[]>,
  currency: string,
): { km: number; co2eKg: number; primaryMode: string; fuelEstimateMajor: number } {
  const sLegs = legsByShipment.get(s.id) ?? [];
  let km = sLegs.reduce((sum, l) => sum + num(l.distance_km, 0), 0);
  let co2eKg = sLegs.reduce((sum, l) => sum + num(l.co2e_kg, 0), 0);
  const plan = (s.plan ?? {}) as Record<string, unknown>;
  if (km === 0) km = num(plan.distance_km, 0);
  if (co2eKg === 0) co2eKg = num(plan.co2e_kg, 0);

  const planModes = Array.isArray(plan.modes) ? (plan.modes as string[]) : [];
  const primaryMode = String(
    sLegs[0]?.mode ?? planModes[0] ?? "ROAD",
  ).toUpperCase();

  const fx = benchmarkScale(currency);
  let fuelEstimateMajor = 0;
  if (sLegs.length > 0) {
    for (const l of sLegs) {
      const lKm = num(l.distance_km, 0);
      const coeff =
        (FUEL_INDEX_USD_PER_KM[String(l.mode ?? "ROAD").toUpperCase()] ?? 0.42) * fx;
      fuelEstimateMajor += lKm * coeff;
    }
  } else if (km > 0) {
    const coeff = (FUEL_INDEX_USD_PER_KM[primaryMode] ?? 0.42) * fx;
    fuelEstimateMajor = km * coeff;
  }

  return {
    km,
    co2eKg,
    primaryMode,
    fuelEstimateMajor: Math.round(fuelEstimateMajor * 100) / 100,
  };
}

/**
 * Deterministic ordinary least-squares linear trend + ±residual confidence band
 * for short-horizon forecasting. Strictly labeled PREDICTION.
 */
function linearForecastSeries(
  historical: number[],
  horizonDays: number,
): {
  slope: number;
  points: { predicted: number; lower: number; upper: number }[];
  confidenceLevel: "HIGH" | "MODERATE" | "LOW";
} {
  const n = historical.length;
  if (n === 0) {
    return {
      slope: 0,
      points: Array.from({ length: horizonDays }, () => ({
        predicted: 0,
        lower: 0,
        upper: 0,
      })),
      confidenceLevel: "LOW",
    };
  }

  const nonZeroDays = historical.filter((v) => v > 0).length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += i;
    sumY += historical[i];
    sumXY += i * historical[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  const meanY = sumY / n;
  const rawSlope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  // Dampen extreme slopes on sparse datasets so forecasts stay grounded
  const damp = nonZeroDays >= 5 ? 0.85 : nonZeroDays >= 3 ? 0.55 : 0.25;
  const slope = rawSlope * damp;
  const intercept = meanY - slope * ((n - 1) / 2);

  // Residual standard error for transparent confidence interval
  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    const fitted = intercept + slope * i;
    sse += (historical[i] - fitted) ** 2;
  }
  const stdErr = n > 2 ? Math.sqrt(sse / (n - 2)) : Math.max(1, meanY * 0.25);

  const points: { predicted: number; lower: number; upper: number }[] = [];
  for (let h = 1; h <= horizonDays; h += 1) {
    const x = n - 1 + h;
    const rawPred = Math.max(0, intercept + slope * x);
    // Band widens slightly as forecast horizon extends
    const band = Math.max(rawPred * 0.12, stdErr * (1 + h * 0.08));
    points.push({
      predicted: Math.round(rawPred * 10) / 10,
      lower: Math.max(0, Math.round((rawPred - band) * 10) / 10),
      upper: Math.round((rawPred + band) * 10) / 10,
    });
  }

  const confidenceLevel: "HIGH" | "MODERATE" | "LOW" =
    nonZeroDays >= 7 ? "HIGH" : nonZeroDays >= 3 ? "MODERATE" : "LOW";

  return { slope: Math.round(slope * 100) / 100, points, confidenceLevel };
}

/**
 * 30-day horizon dampened OLS regression with optional weekday seasonality
 * and widening ±1σ residual confidence bands. Logarithmic horizon damping
 * prevents short-window trends from over-extrapolating across 30 days.
 */
function build30dLinearSeries(
  historical: { value: number; dayOfWeek: number }[],
  futureDayOfWeeks: number[],
): {
  slope: number;
  points: { predicted: number; lower: number; upper: number }[];
  confidenceLevel: "HIGH" | "MODERATE" | "LOW";
} {
  const n = historical.length;
  const horizonDays = futureDayOfWeeks.length;
  if (n === 0) {
    return {
      slope: 0,
      points: Array.from({ length: horizonDays }, () => ({
        predicted: 0,
        lower: 0,
        upper: 0,
      })),
      confidenceLevel: "LOW",
    };
  }

  const values = historical.map((h) => h.value);
  const nonZeroDays = values.filter((v) => v > 0).length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }

  const denom = n * sumXX - sumX * sumX;
  const meanY = sumY / n;
  const rawSlope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const damp = nonZeroDays >= 14 ? 0.72 : nonZeroDays >= 6 ? 0.45 : 0.2;
  const slope = rawSlope * damp;
  const intercept = meanY - slope * ((n - 1) / 2);

  // Subtle weekday seasonality weights only when sufficient multi-week data exists
  const dowTotals = Array.from({ length: 7 }, () => ({ sum: 0, count: 0 }));
  for (const h of historical) {
    dowTotals[h.dayOfWeek].sum += h.value;
    dowTotals[h.dayOfWeek].count += 1;
  }
  const useSeasonality = nonZeroDays >= 10 && meanY > 0;
  const dowFactors = dowTotals.map((b) => {
    if (!useSeasonality || b.count === 0) return 1;
    const rawFactor = b.sum / b.count / meanY;
    // Blend 35% seasonality with 65% flat baseline to stay conservative
    return Math.max(0.7, Math.min(1.3, 0.65 + 0.35 * rawFactor));
  });

  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    const fitted = intercept + slope * i;
    sse += (values[i] - fitted) ** 2;
  }
  const stdErr = n > 2 ? Math.sqrt(sse / (n - 2)) : Math.max(0.5, meanY * 0.25);

  const points: { predicted: number; lower: number; upper: number }[] = [];
  for (let h = 1; h <= horizonDays; h += 1) {
    // Logarithmic step damping past day 7 prevents runaway 30-day slopes
    const dampedStep =
      h <= 7 ? h : 7 + Math.log1p(h - 7) * 4.5;
    const x = n - 1 + dampedStep;
    const baseTrend = Math.max(0, intercept + slope * x);
    const seasonal = dowFactors[futureDayOfWeeks[h - 1]] ?? 1;
    const rawPred = Math.max(0, baseTrend * seasonal);
    const band = Math.max(
      rawPred * (0.14 + h * 0.004),
      stdErr * (0.85 + Math.sqrt(h) * 0.14),
    );

    const predicted = Math.round(rawPred * 10) / 10;
    const lower = Math.max(0, Math.round((rawPred - band) * 10) / 10);
    const upper = Math.max(predicted, Math.round((rawPred + band) * 10) / 10);
    points.push({ predicted, lower, upper });
  }

  const confidenceLevel: "HIGH" | "MODERATE" | "LOW" =
    nonZeroDays >= 14 ? "HIGH" : nonZeroDays >= 5 ? "MODERATE" : "LOW";

  return {
    slope: Math.round(slope * 100) / 100,
    points,
    confidenceLevel,
  };
}

/**
 * Pure, deterministic cross-departmental Business Intelligence engine.
 * Aggregates actual records across all 9 departments, computes period-over-period comparisons,
 * triggers proactive executive alerts, builds multi-dimensional comparisons, and generates
 * short-horizon predictive forecasts with explicit VERIFIED / ESTIMATE / PREDICTION tags.
 */
export function buildBiSnapshot(
  raw: BiRawInputs,
  options: {
    periodDays?: BiPeriodDays;
    role?: Role;
    acknowledgedAlertIds?: Set<string>;
    now?: Date;
  } = {},
): BiSnapshot {
  const periodDays: BiPeriodDays = options.periodDays ?? 7;
  const role: Role = options.role ?? "ADMIN";
  const acknowledged = options.acknowledgedAlertIds ?? new Set<string>();
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const currency =
    raw.currency ??
    raw.quotes.find((q) => q.currency)?.currency ??
    raw.orders.find((o) => o.currency)?.currency ??
    "USD";

  const currentStartMs = nowMs - periodDays * DAY_MS;
  const priorStartMs = nowMs - periodDays * 2 * DAY_MS;

  // Index legs & quotes by shipment
  const legsByShipment = new Map<string, BiLegInput[]>();
  for (const leg of raw.legs) {
    const arr = legsByShipment.get(leg.shipment_id) ?? [];
    arr.push(leg);
    legsByShipment.set(leg.shipment_id, arr);
  }

  const quotesByShipment = new Map<string, BiQuoteInput[]>();
  const selectedQuoteByShipment = new Map<string, BiQuoteInput>();
  for (const q of raw.quotes) {
    const arr = quotesByShipment.get(q.shipment_id) ?? [];
    arr.push(q);
    quotesByShipment.set(q.shipment_id, arr);
    if (!selectedQuoteByShipment.has(q.shipment_id) || q.state === "SELECTED") {
      selectedQuoteByShipment.set(q.shipment_id, q);
    }
  }

  // Enrich shipments once with cost, distance, CO2, fuel proxy, and period membership
  const enrichedShipments = raw.shipments.map((s) => {
    const createdMs = toMs(s.created_at) ?? nowMs;
    const deadlineMs = toMs(s.deadline);
    const { major: costMajor, provenance: costProvenance } = resolveShipmentCostMajor(
      s,
      legsByShipment,
      selectedQuoteByShipment,
    );
    const { km, co2eKg, primaryMode, fuelEstimateMajor } = resolveShipmentKmAndCo2(
      s,
      legsByShipment,
      currency,
    );
    const isActive = !TERMINAL_STATES.has(s.state);
    const isOverdue =
      deadlineMs !== null &&
      deadlineMs < nowMs &&
      !CLOSED_STATES.has(s.state) &&
      !TERMINAL_STATES.has(s.state);
    const isDelayedOrException = s.state === "EXCEPTION" || isOverdue;
    const originCity =
      typeof s.origin?.city === "string" && s.origin.city.trim()
        ? s.origin.city.trim()
        : "Unassigned Hub";
    const destCity =
      typeof s.destination?.city === "string" && s.destination.city.trim()
        ? s.destination.city.trim()
        : "Destination";
    const lane = `${originCity} → ${destCity}`;
    const inCurrent = createdMs >= currentStartMs && createdMs <= nowMs;
    const inPrior = createdMs >= priorStartMs && createdMs < currentStartMs;

    return {
      raw: s,
      createdMs,
      costMajor,
      costProvenance,
      km,
      co2eKg,
      primaryMode,
      fuelEstimateMajor,
      isActive,
      isOverdue,
      isDelayedOrException,
      originCity,
      destCity,
      lane,
      inCurrent,
      inPrior,
    };
  });

  const currentShips = enrichedShipments.filter((s) => s.inCurrent);
  const priorShips = enrichedShipments.filter((s) => s.inPrior);

  // Fallback window: if no shipments fall in the current N-day window, track all-time totals honestly
  const activeDataset = currentShips.length > 0 ? currentShips : enrichedShipments;
  const usingAllTimeFallback = currentShips.length === 0 && enrichedShipments.length > 0;

  // ---------------- 1. FINANCE METRICS ----------------
  const currentSpend = activeDataset.reduce((s, x) => s + x.costMajor, 0);
  const priorSpend = priorShips.reduce((s, x) => s + x.costMajor, 0);
  const spendDeltaPct = usingAllTimeFallback ? null : pctDelta(currentSpend, priorSpend);

  const currentShipCount = activeDataset.length;
  const priorShipCount = priorShips.length;
  const avgCostCurrent = currentShipCount > 0 ? currentSpend / currentShipCount : 0;
  const avgCostPrior = priorShipCount > 0 ? priorSpend / priorShipCount : 0;
  const avgCostDeltaPct = usingAllTimeFallback ? null : pctDelta(avgCostCurrent, avgCostPrior);

  const currentFuelEst = activeDataset.reduce((s, x) => s + x.fuelEstimateMajor, 0);
  const priorFuelEst = priorShips.reduce((s, x) => s + x.fuelEstimateMajor, 0);
  const currentKm = activeDataset.reduce((s, x) => s + x.km, 0);
  const priorKm = priorShips.reduce((s, x) => s + x.km, 0);
  const fuelPerKmCurrent = currentKm > 0 ? currentFuelEst / currentKm : 0;
  const fuelPerKmPrior = priorKm > 0 ? priorFuelEst / priorKm : 0;
  const fuelPerKmDeltaPct = usingAllTimeFallback ? null : pctDelta(fuelPerKmCurrent, fuelPerKmPrior);

  // Modeled brokerage revenue & gross margin estimate from actual freight spend (clearly ESTIMATE)
  const estRevenueCurrent = currentSpend > 0 ? currentSpend / (1 - TARGET_GROSS_MARGIN_RATE) : 0;
  const estRevenuePrior = priorSpend > 0 ? priorSpend / (1 - TARGET_GROSS_MARGIN_RATE) : 0;
  const estGrossMarginCurrent = estRevenueCurrent - currentSpend;
  const estRevenueDeltaPct = usingAllTimeFallback ? null : pctDelta(estRevenueCurrent, estRevenuePrior);

  const pendingApprovalsTotal = raw.approvals.reduce(
    (sum, a) => sum + num(a.amount_minor, 0) / 100,
    0,
  );

  // Detect unusual expense outliers (> 1.6x median shipment cost)
  const pricedCosts = activeDataset
    .map((x) => x.costMajor)
    .filter((c) => c > 0)
    .sort((a, b) => a - b);
  const medianCost =
    pricedCosts.length > 0
      ? pricedCosts[Math.floor(pricedCosts.length / 2)]
      : 0;
  const expenseOutliers =
    medianCost > 0
      ? activeDataset.filter((x) => x.costMajor > medianCost * 1.6)
      : [];

  // Quote spread check: compare selected quote vs lowest received quote on same shipment
  let avoidableQuoteSpreadMajor = 0;
  let spreadCount = 0;
  for (const [, qList] of quotesByShipment.entries()) {
    const selected = qList.find((q) => q.state === "SELECTED");
    const validAmounts = qList
      .map((q) => num(q.amount_minor, 0))
      .filter((v) => v > 0);
    if (selected && validAmounts.length >= 2) {
      const selAmt = num(selected.amount_minor, 0);
      const minAmt = Math.min(...validAmounts);
      if (selAmt > minAmt * 1.15) {
        avoidableQuoteSpreadMajor += (selAmt - minAmt) / 100;
        spreadCount += 1;
      }
    }
  }

  // ---------------- 2. OPERATIONS METRICS ----------------
  const openExcCount = raw.exceptions.length;
  const criticalExcCount = raw.exceptions.filter(
    (e) => e.severity === "CRITICAL" || e.severity === "HIGH",
  ).length;
  const delayedCount = enrichedShipments.filter((s) => s.isDelayedOrException).length;
  const totalShipsAll = enrichedShipments.length;
  const onTimeRatePct =
    totalShipsAll > 0
      ? Math.round(((totalShipsAll - delayedCount) / totalShipsAll) * 1000) / 10
      : 100;
  const priorDelayed = priorShips.filter((s) => s.isDelayedOrException).length;
  const priorOnTimePct =
    priorShips.length > 0
      ? ((priorShips.length - priorDelayed) / priorShips.length) * 100
      : onTimeRatePct;
  const onTimeDelta =
    priorShips.length > 0
      ? Math.round((onTimeRatePct - priorOnTimePct) * 10) / 10
      : null;

  const customsHeld = raw.customs.filter(
    (c) => /HOLD|REJECT|PENDING|INSPECT/i.test(c.clearance_state),
  ).length;
  const queuePending = num(raw.queueCounts.PENDING, 0) + num(raw.queueCounts.CLAIMED, 0);

  // ---------------- 3. FLEET & DISPATCH & HR METRICS ----------------
  const readiness = computeLogisticsReadiness({
    drivers: raw.drivers,
    shipments: raw.shipments,
    documents: raw.documents,
    nowMs,
  });

  const activeVehicles = raw.conveyances.filter((v) => v.active);
  const assignedVehicles = activeVehicles.filter((v) => Boolean(v.assigned_to));
  const idleVehicles = activeVehicles.filter((v) => !v.assigned_to);
  const fleetUtilPct =
    activeVehicles.length > 0
      ? Math.round((assignedVehicles.length / activeVehicles.length) * 1000) / 10
      : 0;
  const totalCo2eCurrent = activeDataset.reduce((sum, x) => sum + x.co2eKg, 0);
  const totalCo2ePrior = priorShips.reduce((sum, x) => sum + x.co2eKg, 0);
  const co2IntensityPerKm =
    currentKm > 0 ? Math.round((totalCo2eCurrent / currentKm) * 1000) : 0; // g/km

  // HR Workforce metrics
  const activeDrivers = raw.drivers.filter((d) => d.active !== false);
  const hazmatDrivers = activeDrivers.filter((d) => d.hazmat_certified).length;
  const avgHosRemaining =
    activeDrivers.length > 0
      ? Math.round(
          (activeDrivers.reduce(
            (sum, d) => sum + num(d.hos_drive_remaining_hours, 9.5),
            0,
          ) /
            activeDrivers.length) *
            10,
        ) / 10
      : 0;
  const hrCompliancePct =
    activeDrivers.length > 0
      ? Math.round(
          ((activeDrivers.length - readiness.driversExpiredLicence) /
            activeDrivers.length) *
            1000,
        ) / 10
      : 100;

  // ---------------- 4. WAREHOUSING / BRANCHES ----------------
  const activeWarehouses = raw.warehouses.filter((w) => w.active !== false);
  const totalOnHand = activeWarehouses.reduce((s, w) => s + num(w.on_hand, 0), 0);
  const totalReserved = activeWarehouses.reduce((s, w) => s + num(w.reserved, 0), 0);
  const warehouseUtilPct =
    totalOnHand > 0 ? Math.round((totalReserved / totalOnHand) * 1000) / 10 : 0;
  const lowStockSkus = raw.inventory.filter(
    (inv) => inv.on_hand > 0 && inv.available / inv.on_hand < 0.2,
  );
  const avgLeadHours =
    activeWarehouses.length > 0
      ? Math.round(
          (activeWarehouses.reduce(
            (s, w) => s + num(w.dispatch_lead_hours, 0),
            0,
          ) /
            activeWarehouses.length) *
            10,
        ) / 10
      : 0;

  // ---------------- 5. SALES & CUSTOMERS ----------------
  const currentOrders = raw.orders.filter((o) => {
    const ms = toMs(o.ordered_at);
    return ms !== null && ms >= currentStartMs && ms <= nowMs;
  });
  const priorOrders = raw.orders.filter((o) => {
    const ms = toMs(o.ordered_at);
    return ms !== null && ms >= priorStartMs && ms < currentStartMs;
  });
  const ordersDeltaPct =
    priorOrders.length > 0
      ? pctDelta(currentOrders.length, priorOrders.length)
      : null;

  const convertedCount = activeDataset.filter((s) =>
    CONVERTED_STATES.has(s.raw.state),
  ).length;
  const conversionRatePct =
    activeDataset.length > 0
      ? Math.round((convertedCount / activeDataset.length) * 1000) / 10
      : 0;
  const priorConverted = priorShips.filter((s) =>
    CONVERTED_STATES.has(s.raw.state),
  ).length;
  const priorConversionPct =
    priorShips.length > 0 ? (priorConverted / priorShips.length) * 100 : 0;
  const conversionDelta =
    priorShips.length > 0
      ? Math.round((conversionRatePct - priorConversionPct) * 10) / 10
      : null;

  const activeCustomers = raw.customers.filter((c) => c.active !== false);
  const customersAtSlaRisk = activeCustomers.filter((c) => num(c.late, 0) > 0);
  const inboundSupportCount = raw.communications.filter(
    (m) => m.direction === "INBOUND",
  ).length;

  // ---------------- 6. PROACTIVE ALERT ENGINE ----------------
  const alerts: ProactiveAlert[] = [];
  const pushAlert = (alert: Omit<ProactiveAlert, "acknowledged" | "detectedAt" | "departmentName">) => {
    alerts.push({
      ...alert,
      departmentName: DEPT_META[alert.department].name,
      acknowledged: acknowledged.has(alert.id),
      detectedAt: now.toISOString(),
    });
  };

  // Alert 1: Rising Fuel / Cost per Shipment
  if (avgCostDeltaPct !== null && avgCostDeltaPct >= 15 && avgCostCurrent > 0) {
    pushAlert({
      id: `cost-spike-${periodDays}d`,
      severity: avgCostDeltaPct >= 30 ? "CRITICAL" : "HIGH",
      category: "COST_ANOMALY",
      department: "finance",
      title: `Cost per shipment surged ${avgCostDeltaPct.toFixed(1)}% vs prior ${periodDays}d`,
      summary: `Average unit freight cost rose from ${formatMoneyMajor(avgCostPrior, currency)} to ${formatMoneyMajor(avgCostCurrent, currency)} across ${currentShipCount} shipments.`,
      observedValue: formatMoneyMajor(avgCostCurrent, currency),
      baselineValue: formatMoneyMajor(avgCostPrior, currency),
      deltaPct: avgCostDeltaPct,
      estimatedImpact: `+${formatMoneyMajor((avgCostCurrent - avgCostPrior) * currentShipCount, currency)} period cost drag`,
      provenance: "VERIFIED",
      formula: "(Current period freight spend ÷ Current shipments) vs prior equal window",
      recommendedAction:
        "Audit spot-rate bookings on top cost corridors and enforce contracted carrier rate cards before approval.",
      deepLink: "/approvals",
    });
  }

  if (fuelPerKmDeltaPct !== null && fuelPerKmDeltaPct >= 12 && fuelPerKmCurrent > 0) {
    pushAlert({
      id: `fuel-intensity-${periodDays}d`,
      severity: fuelPerKmDeltaPct >= 25 ? "HIGH" : "MEDIUM",
      category: "COST_ANOMALY",
      department: "fleet",
      title: `Estimated fuel intensity up ${fuelPerKmDeltaPct.toFixed(1)}% per km`,
      summary: `Mode-weighted fuel cost proxy climbed to ${formatMoneyMajor(fuelPerKmCurrent, currency)}/km (vs ${formatMoneyMajor(fuelPerKmPrior, currency)}/km prior), driven by high-burn mode mix.`,
      observedValue: `${formatMoneyMajor(fuelPerKmCurrent, currency)}/km`,
      baselineValue: `${formatMoneyMajor(fuelPerKmPrior, currency)}/km`,
      deltaPct: fuelPerKmDeltaPct,
      estimatedImpact: `${formatMoneyMajor(currentFuelEst, currency)} modeled period fuel exposure`,
      provenance: "ESTIMATE",
      formula: "Sum(leg distance_km × mode fuel factor: Road $0.42, Air $1.85, Sea $0.14, Rail $0.21) ÷ total km",
      recommendedAction:
        "Shift non-urgent air/express legs to rail or consolidated road linehaul to recover fuel margin.",
      deepLink: "/planning",
    });
  }

  // Alert 2: Unusual Expense Outliers & Quote Spread Leakage
  if (expenseOutliers.length > 0) {
    const topOutlier = [...expenseOutliers].sort((a, b) => b.costMajor - a.costMajor)[0];
    const excess = expenseOutliers.reduce((sum, x) => sum + (x.costMajor - medianCost), 0);
    pushAlert({
      id: `expense-outliers-${periodDays}d`,
      severity: expenseOutliers.length >= 3 ? "HIGH" : "MEDIUM",
      category: "COST_ANOMALY",
      department: "finance",
      title: `${expenseOutliers.length} unusual expense outlier${expenseOutliers.length === 1 ? "" : "s"} (>1.6× median)`,
      summary: `Shipment ${topOutlier.raw.reference} (${topOutlier.lane}) is priced at ${formatMoneyMajor(topOutlier.costMajor, currency)} vs workspace median ${formatMoneyMajor(medianCost, currency)}.`,
      observedValue: formatMoneyMajor(topOutlier.costMajor, currency),
      baselineValue: `${formatMoneyMajor(medianCost, currency)} median`,
      deltaPct: pctDelta(topOutlier.costMajor, medianCost),
      estimatedImpact: `${formatMoneyMajor(excess, currency)} above median unit spend`,
      provenance: topOutlier.costProvenance,
      formula: "Flagged where shipment cost > 1.6 × workspace median shipment cost",
      recommendedAction:
        "Review carrier surcharge breakdowns and require dual approval on loads exceeding 150% of lane median.",
      deepLink: `/shipments/${encodeURIComponent(topOutlier.raw.reference)}`,
    });
  }

  if (avoidableQuoteSpreadMajor > 50 && spreadCount > 0) {
    pushAlert({
      id: `quote-spread-leakage`,
      severity: "OPPORTUNITY",
      category: "GROWTH_OPPORTUNITY",
      department: "finance",
      title: `Carrier rate consolidation opportunity across ${spreadCount} booking${spreadCount === 1 ? "" : "s"}`,
      summary: `Selected carrier quotes exceeded the lowest received bid by >15% on ${spreadCount} shipments.`,
      observedValue: formatMoneyMajor(avoidableQuoteSpreadMajor, currency),
      baselineValue: "Lowest received bid",
      deltaPct: null,
      estimatedImpact: `Up to ${formatMoneyMajor(avoidableQuoteSpreadMajor, currency)} recoverable margin`,
      provenance: "VERIFIED",
      formula: "Sum(selected_quote_amount − min_received_quote_amount) where spread > 15%",
      recommendedAction:
        "Re-benchmark secondary carriers on those lanes to lock in lower contract tiers without sacrificing SLA.",
      deepLink: "/carriers",
    });
  }

  // Alert 3: Declining Freight Volume / Revenue Intake
  const volDeltaPct = usingAllTimeFallback ? null : pctDelta(currentShipCount, priorShipCount);
  if (
    (volDeltaPct !== null && volDeltaPct <= -15) ||
    (estRevenueDeltaPct !== null && estRevenueDeltaPct <= -15)
  ) {
    const dropPct = estRevenueDeltaPct ?? volDeltaPct ?? -15;
    pushAlert({
      id: `revenue-decline-${periodDays}d`,
      severity: dropPct <= -30 ? "CRITICAL" : "HIGH",
      category: "REVENUE_DECLINE",
      department: "sales",
      title: `Freight intake & modeled revenue down ${Math.abs(dropPct).toFixed(1)}% vs prior ${periodDays}d`,
      summary: `Shipment volume shifted from ${priorShipCount} to ${currentShipCount} loads (${formatMoneyMajor(estRevenueCurrent, currency)} est. revenue vs ${formatMoneyMajor(estRevenuePrior, currency)} prior).`,
      observedValue: `${currentShipCount} loads`,
      baselineValue: `${priorShipCount} loads`,
      deltaPct: dropPct,
      estimatedImpact: `${formatMoneyMajor(estRevenueCurrent - estRevenuePrior, currency)} revenue variance`,
      provenance: "ESTIMATE",
      formula: "Period-over-period comparison of booked shipment volume & modeled revenue (spend ÷ 0.76)",
      recommendedAction:
        "Engage inactive top accounts and follow up on unconverted quotes in Sales/Orders immediately.",
      deepLink: "/orders",
    });
  }

  // Alert 4: Delayed Shipments, Open Exceptions & Dock Detention
  if (delayedCount > 0 || openExcCount > 0) {
    pushAlert({
      id: `delayed-shipments-active`,
      severity: criticalExcCount > 0 || delayedCount >= 3 ? "CRITICAL" : "HIGH",
      category: "SHIPMENT_DELAY",
      department: "operations",
      title: `${delayedCount} delayed/exception load${delayedCount === 1 ? "" : "s"} & ${openExcCount} open exception${openExcCount === 1 ? "" : "s"}`,
      summary: `On-time health stands at ${onTimeRatePct.toFixed(1)}% with ${criticalExcCount} critical/high disruptions requiring immediate recovery routing.`,
      observedValue: `${onTimeRatePct.toFixed(1)}% on-time`,
      baselineValue: "95.0% SLA target",
      deltaPct: Math.round((onTimeRatePct - 95) * 10) / 10,
      estimatedImpact: `${delayedCount} active customer SLAs exposed`,
      provenance: "VERIFIED",
      formula: "(Total shipments − overdue or EXCEPTION shipments) ÷ Total shipments",
      recommendedAction:
        "Triage open exceptions in Control Tower and dispatch backup carriers on overdue corridors.",
      deepLink: "/exceptions",
    });
  }

  if (readiness.detentionRisks.length > 0) {
    const worst = readiness.detentionRisks[0];
    const totalDetentionHours =
      Math.round(
        (readiness.detentionRisks.reduce((s, r) => s + r.estimatedExposureMinutes, 0) /
          60) *
          10,
      ) / 10;
    const hourlyDetentionMajor = 75 * benchmarkScale(currency);
    pushAlert({
      id: `dock-detention-exposure`,
      severity: readiness.detentionRisks.some((r) => r.severity === "HIGH")
        ? "HIGH"
        : "MEDIUM",
      category: "SHIPMENT_DELAY",
      department: "dispatch",
      title: `${readiness.detentionRisks.length} load${readiness.detentionRisks.length === 1 ? "" : "s"} exceeding 2h dock detention free-time`,
      summary: `Longest dwell is ${worst.reference} (${worst.hoursSinceUpdate.toFixed(1)}h without handoff${worst.city ? ` in ${worst.city}` : ""}).`,
      observedValue: `${totalDetentionHours}h exposure`,
      baselineValue: "2.0h free time",
      deltaPct: null,
      estimatedImpact: `~${formatMoneyMajor(totalDetentionHours * hourlyDetentionMajor, currency)} est. detention fees (${formatMoneyMajor(hourlyDetentionMajor, currency)}/hr benchmark)`,
      provenance: "ESTIMATE",
      formula: `Sum(hours_since_update − 2h free time) × ${formatMoneyMajor(hourlyDetentionMajor, currency)}/hr detention benchmark`,
      recommendedAction:
        "Assign nearby available drivers immediately from Fleet Dispatch and clear dock gate bottlenecks.",
      deepLink: "/fleet",
    });
  }

  // Alert 5: Deteriorating Branch / Warehouse Performance
  const strainedWarehouses = activeWarehouses.filter((w) => {
    const oh = num(w.on_hand, 0);
    const res = num(w.reserved, 0);
    const ratio = oh > 0 ? res / oh : 0;
    return ratio >= 0.85 || num(w.dispatch_lead_hours, 0) >= 8;
  });

  if (strainedWarehouses.length > 0 || lowStockSkus.length > 0) {
    const worstWh = strainedWarehouses[0];
    pushAlert({
      id: `branch-warehouse-pressure`,
      severity: strainedWarehouses.length >= 2 || lowStockSkus.length >= 3 ? "HIGH" : "MEDIUM",
      category: "BRANCH_PERFORMANCE",
      department: "warehousing",
      title: worstWh
        ? `Branch ${worstWh.code} (${worstWh.city ?? worstWh.name}) showing capacity/lead-time strain`
        : `${lowStockSkus.length} SKU${lowStockSkus.length === 1 ? "" : "s"} below 20% available safety stock`,
      summary: worstWh
        ? `${strainedWarehouses.length} branch hub(s) exceed 85% reservation utilization or 8h dispatch lead time; ${lowStockSkus.length} SKU(s) are near stockout.`
        : `${lowStockSkus.length} warehouse SKUs have fewer than 20% unreserved units available for allocation.`,
      observedValue: worstWh
        ? `${num(worstWh.dispatch_lead_hours, 0)}h lead / ${warehouseUtilPct}% util`
        : `${lowStockSkus.length} low SKUs`,
      baselineValue: "< 85% util & < 8h lead",
      deltaPct: null,
      estimatedImpact: "Elevated order backorder & split-shipment cost risk",
      provenance: "VERIFIED",
      formula: "Warehouse reserved ÷ on_hand >= 85% OR dispatch_lead_hours >= 8h OR SKU available < 20%",
      recommendedAction:
        "Rebalance inventory allocation toward underutilized branches and trigger replenishment transfers.",
      deepLink: "/warehouses",
    });
  }

  // Alert 6: Fleet Idle Asset Drag or Unassigned Loads
  if (activeVehicles.length > 0 && fleetUtilPct < 45) {
    pushAlert({
      id: `fleet-underutilization`,
      severity: "OPPORTUNITY",
      category: "FLEET_EFFICIENCY",
      department: "fleet",
      title: `${idleVehicles.length} of ${activeVehicles.length} active vehicles currently idle (${(100 - fleetUtilPct).toFixed(0)}%)`,
      summary: `Fleet utilization is ${fleetUtilPct.toFixed(1)}% while ${readiness.unassignedActiveShipments} active loads still await driver/vehicle assignment.`,
      observedValue: `${fleetUtilPct.toFixed(1)}% utilized`,
      baselineValue: "75.0% target",
      deltaPct: Math.round((fleetUtilPct - 75) * 10) / 10,
      estimatedImpact: "Recoverable internal capacity to displace higher-cost third-party spot carriers",
      provenance: "VERIFIED",
      formula: "Assigned active conveyances ÷ Total active conveyances",
      recommendedAction:
        "Prioritize internal fleet matching on unassigned corridors before tendering to spot carriers.",
      deepLink: "/fleet",
    });
  }

  // Alert 7: HR / Driver Compliance & HOS Fatigue Exposure
  if (
    readiness.driversExpiredLicence > 0 ||
    readiness.driversExpiringSoon > 0 ||
    readiness.driversLowHos > 0
  ) {
    pushAlert({
      id: `hr-driver-compliance-risk`,
      severity: readiness.driversExpiredLicence > 0 ? "CRITICAL" : "HIGH",
      category: "COMPLIANCE_HR",
      department: "hr",
      title:
        readiness.driversExpiredLicence > 0
          ? `${readiness.driversExpiredLicence} driver${readiness.driversExpiredLicence === 1 ? "" : "s"} with expired CDL licence`
          : `${readiness.driversExpiringSoon} CDL renewals due & ${readiness.driversLowHos} low-HOS driver${readiness.driversLowHos === 1 ? "" : "s"}`,
      summary: `Roster compliance is ${hrCompliancePct.toFixed(1)}% (${readiness.driversDispatchReady}/${readiness.driversTotal} dispatch-ready). ${readiness.driversLowHos} driver(s) have under 2.5h HOS drive clock.`,
      observedValue: `${readiness.driversExpiredLicence} expired / ${readiness.driversLowHos} low HOS`,
      baselineValue: "0 expired / >= 2.5h HOS",
      deltaPct: null,
      estimatedImpact: "DOT/regulatory non-compliance fines & last-minute dispatch cancellations",
      provenance: "VERIFIED",
      formula: "Count(drivers where days_to_expiry < 0 OR <= 30 OR hos_drive_remaining < 2.5h)",
      recommendedAction:
        "Hold expired-licence drivers from dispatch, schedule CDL renewals, and rotate rested relief drivers.",
      deepLink: "/fleet",
    });
  }

  // Alert 8: Pending Spend Approvals Bottleneck
  if (raw.approvals.length > 0) {
    pushAlert({
      id: `pending-spend-approvals`,
      severity: raw.approvals.length >= 3 ? "HIGH" : "MEDIUM",
      category: "COST_ANOMALY",
      department: "finance",
      title: `${raw.approvals.length} spend approval${raw.approvals.length === 1 ? "" : "s"} awaiting authorization (${formatMoneyMajor(pendingApprovalsTotal, currency)})`,
      summary: `Shipments held in approval queue risk missing booking cutoffs and triggering higher re-quote rates.`,
      observedValue: `${raw.approvals.length} pending`,
      baselineValue: "0 backlog",
      deltaPct: null,
      estimatedImpact: `${formatMoneyMajor(pendingApprovalsTotal, currency)} freight spend paused`,
      provenance: "VERIFIED",
      formula: "Sum(approvals.amount_minor where state = 'PENDING')",
      recommendedAction:
        "Review and clear pending policy approvals to lock in quoted carrier rates before expiry.",
      deepLink: "/approvals",
    });
  }

  // Alert 9: Customer SLA Concentration Risk
  if (customersAtSlaRisk.length > 0) {
    const worstCust = [...customersAtSlaRisk].sort((a, b) => num(b.late, 0) - num(a.late, 0))[0];
    pushAlert({
      id: `customer-sla-exposure`,
      severity: num(worstCust.late, 0) >= 2 ? "HIGH" : "MEDIUM",
      category: "SHIPMENT_DELAY",
      department: "customers",
      title: `${customersAtSlaRisk.length} customer account${customersAtSlaRisk.length === 1 ? "" : "s"} experiencing active SLA delays`,
      summary: `${worstCust.name} has ${worstCust.late} overdue shipment(s) out of ${worstCust.open} open loads.`,
      observedValue: `${customersAtSlaRisk.length} accounts`,
      baselineValue: "0 overdue accounts",
      deltaPct: null,
      estimatedImpact: "Customer churn risk & SLA service-credit exposure",
      provenance: "VERIFIED",
      formula: "Count(active customers where overdue open shipments > 0)",
      recommendedAction:
        "Send proactive ETA updates to affected account contacts and escalate recovery routing.",
      deepLink: "/customers",
    });
  }

  // Sort alerts: unacknowledged first, then severity rank
  const severityOrder: Record<string, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    OPPORTUNITY: 3,
  };
  alerts.sort((a, b) => {
    if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
    return (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9);
  });

  // ---------------- 7. ALL 9 DEPARTMENT SCORECARDS ----------------
  const alertCountByDept = (dept: BiDepartmentId) =>
    alerts.filter((a) => a.department === dept && !a.acknowledged).length;

  const financeScore = Math.max(
    25,
    Math.min(
      100,
      92 -
        (avgCostDeltaPct && avgCostDeltaPct > 15 ? 20 : 0) -
        expenseOutliers.length * 8 -
        raw.approvals.length * 5,
    ),
  );
  const opsScore = Math.max(
    20,
    Math.min(
      100,
      Math.round(onTimeRatePct - criticalExcCount * 8 - raw.deadWorkCount * 10 - customsHeld * 4),
    ),
  );
  const fleetScore =
    activeVehicles.length === 0
      ? 0
      : Math.max(
          25,
          Math.min(
            100,
            Math.round(50 + Math.min(40, fleetUtilPct * 0.5) + (readiness.driversWithGps > 0 ? 10 : 0)),
          ),
        );
  const shipmentsScore =
    totalShipsAll === 0
      ? 0
      : Math.max(25, Math.min(100, Math.round(onTimeRatePct * 0.7 + conversionRatePct * 0.3)));
  const dispatchScore =
    activeDrivers.length === 0 && totalShipsAll === 0
      ? 0
      : Math.max(
          20,
          Math.min(
            100,
            95 -
              readiness.unassignedActiveShipments * 8 -
              readiness.detentionRisks.length * 10 -
              readiness.unverifiedPodBolCount * 4,
          ),
        );
  const warehouseScore =
    activeWarehouses.length === 0
      ? 0
      : Math.max(
          25,
          Math.min(100, Math.round(94 - strainedWarehouses.length * 16 - lowStockSkus.length * 6)),
        );
  const salesScore =
    raw.orders.length === 0 && totalShipsAll === 0
      ? 0
      : Math.max(
          25,
          Math.min(
            100,
            Math.round(55 + conversionRatePct * 0.4 - (volDeltaPct && volDeltaPct < -15 ? 20 : 0)),
          ),
        );
  const customerScore =
    activeCustomers.length === 0
      ? 0
      : Math.max(
          25,
          Math.min(
            100,
            Math.round(96 - customersAtSlaRisk.length * 14 - Math.min(20, inboundSupportCount)),
          ),
        );
  const hrScore =
    activeDrivers.length === 0
      ? 0
      : Math.max(
          20,
          Math.min(
            100,
            Math.round(
              hrCompliancePct -
                readiness.driversExpiredLicence * 20 -
                readiness.driversExpiringSoon * 5 -
                readiness.driversLowHos * 8,
            ),
          ),
        );

  const departments: DepartmentScorecard[] = [
    {
      id: "finance",
      name: "Finance",
      status: statusFromScore(financeScore, currentSpend > 0 || raw.approvals.length > 0),
      healthScore: financeScore,
      headlineLabel: "Freight Spend",
      headlineValue: formatMoneyMajor(currentSpend, currency),
      deltaPct: spendDeltaPct,
      higherIsBetter: false,
      provenance: activeDataset.some((s) => s.costProvenance === "VERIFIED")
        ? "VERIFIED"
        : "ESTIMATE",
      formula: "Sum(shipment leg costs or selected carrier quotes; fallback to planned estimate)",
      metrics: [
        {
          label: "Cost / Shipment",
          value: currentShipCount > 0 ? formatMoneyMajor(avgCostCurrent, currency) : "—",
          provenance: "VERIFIED",
        },
        {
          label: "Est. Gross Margin",
          value: estGrossMarginCurrent > 0 ? formatMoneyMajor(estGrossMarginCurrent, currency) : "—",
          provenance: "ESTIMATE",
        },
        {
          label: "Pending Approvals",
          value: `${raw.approvals.length} (${formatMoneyMajor(pendingApprovalsTotal, currency)})`,
          provenance: "VERIFIED",
        },
      ],
      alertCount: alertCountByDept("finance"),
      summary:
        expenseOutliers.length > 0
          ? `${expenseOutliers.length} cost outlier(s) above 1.6× median; ${raw.approvals.length} pending spend hold(s).`
          : `Unit freight costs tracking within expected corridor range (${formatMoneyMajor(avgCostCurrent, currency)}/load).`,
      deepLink: "/approvals",
    },
    {
      id: "operations",
      name: "Operations",
      status: statusFromScore(opsScore, totalShipsAll > 0 || openExcCount > 0),
      healthScore: opsScore,
      headlineLabel: "On-Time SLA Health",
      headlineValue: `${onTimeRatePct.toFixed(1)}%`,
      deltaPct: onTimeDelta,
      higherIsBetter: true,
      provenance: "VERIFIED",
      formula: "(Total shipments − overdue/EXCEPTION shipments) ÷ Total shipments × 100",
      metrics: [
        { label: "Open Exceptions", value: String(openExcCount), provenance: "VERIFIED" },
        { label: "Customs Holds", value: String(customsHeld), provenance: "VERIFIED" },
        {
          label: "Queue / Stalled",
          value: `${queuePending} / ${raw.deadWorkCount}`,
          provenance: "VERIFIED",
        },
      ],
      alertCount: alertCountByDept("operations"),
      summary:
        openExcCount > 0
          ? `${openExcCount} active exception(s) (${criticalExcCount} critical/high) and ${raw.deadWorkCount} stalled work item(s).`
          : "All active corridors operating without unresolved operational exceptions.",
      deepLink: "/exceptions",
    },
    {
      id: "fleet",
      name: "Fleet Management",
      status: statusFromScore(fleetScore, activeVehicles.length > 0),
      healthScore: fleetScore,
      headlineLabel: "Asset Utilization",
      headlineValue: `${fleetUtilPct.toFixed(1)}%`,
      deltaPct: fuelPerKmDeltaPct,
      higherIsBetter: true,
      provenance: "VERIFIED",
      formula: "Vehicles committed to active shipment legs ÷ Total active vehicles × 100",
      metrics: [
        {
          label: "Active / Idle",
          value: `${assignedVehicles.length} / ${idleVehicles.length}`,
          provenance: "VERIFIED",
        },
        {
          label: "Est. Fuel Proxy",
          value: currentFuelEst > 0 ? formatMoneyMajor(currentFuelEst, currency) : "—",
          provenance: "ESTIMATE",
        },
        {
          label: "CO₂e Intensity",
          value: co2IntensityPerKm > 0 ? `${co2IntensityPerKm} g/km` : "—",
          provenance: "VERIFIED",
        },
      ],
      alertCount: alertCountByDept("fleet"),
      summary: `${assignedVehicles.length} of ${activeVehicles.length} vehicles assigned; ${Math.round(currentKm).toLocaleString()} planned km (${totalCo2eCurrent.toFixed(0)} kg CO₂e).`,
      deepLink: "/fleet",
    },
    {
      id: "shipments",
      name: "Shipments",
      status: statusFromScore(shipmentsScore, totalShipsAll > 0),
      healthScore: shipmentsScore,
      headlineLabel: usingAllTimeFallback ? "Total Shipments" : `Volume (${periodDays}d)`,
      headlineValue: String(currentShipCount),
      deltaPct: volDeltaPct,
      higherIsBetter: true,
      provenance: "VERIFIED",
      formula: "Count of shipment records created inside active comparison window",
      metrics: [
        {
          label: "Active In-Flight",
          value: String(enrichedShipments.filter((s) => s.isActive).length),
          provenance: "VERIFIED",
        },
        {
          label: "Delayed / Exception",
          value: String(delayedCount),
          provenance: "VERIFIED",
        },
        {
          label: "Avg Distance",
          value:
            currentShipCount > 0 && currentKm > 0
              ? `${Math.round(currentKm / currentShipCount).toLocaleString()} km`
              : "—",
          provenance: "VERIFIED",
        },
      ],
      alertCount: alertCountByDept("shipments"),
      summary: `${enrichedShipments.filter((s) => s.isActive).length} open shipments tracked across ${new Set(enrichedShipments.map((s) => s.lane)).size} corridors.`,
      deepLink: "/shipments",
    },
    {
      id: "dispatch",
      name: "Dispatch",
      status: statusFromScore(
        dispatchScore,
        activeDrivers.length > 0 || totalShipsAll > 0,
      ),
      healthScore: dispatchScore,
      headlineLabel: "Dispatch-Ready Drivers",
      headlineValue: `${readiness.driversDispatchReady}/${readiness.driversTotal}`,
      deltaPct: null,
      higherIsBetter: true,
      provenance: "VERIFIED",
      formula: "Available active drivers with valid CDL licence and >= 2.5h HOS drive remaining",
      metrics: [
        {
          label: "Unassigned Loads",
          value: String(readiness.unassignedActiveShipments),
          provenance: "VERIFIED",
        },
        {
          label: "Dock Detention >2h",
          value: String(readiness.detentionRisks.length),
          provenance: "ESTIMATE",
        },
        {
          label: "Unverified POD/BOL",
          value: String(readiness.unverifiedPodBolCount),
          provenance: "VERIFIED",
        },
      ],
      alertCount: alertCountByDept("dispatch"),
      summary: `${readiness.unassignedActiveShipments} active load(s) awaiting driver match; ${readiness.detentionRisks.length} dock dwell alert(s).`,
      deepLink: "/fleet",
    },
    {
      id: "warehousing",
      name: "Warehousing",
      status: statusFromScore(warehouseScore, activeWarehouses.length > 0),
      healthScore: warehouseScore,
      headlineLabel: "Stock Utilization",
      headlineValue: `${warehouseUtilPct.toFixed(1)}%`,
      deltaPct: null,
      higherIsBetter: false,
      provenance: "VERIFIED",
      formula: "Sum(inventory.reserved) ÷ Sum(inventory.on_hand) across active hubs",
      metrics: [
        {
          label: "Active Branches",
          value: String(activeWarehouses.length),
          provenance: "VERIFIED",
        },
        {
          label: "Low-Stock SKUs",
          value: String(lowStockSkus.length),
          provenance: "VERIFIED",
        },
        {
          label: "Avg Lead Time",
          value: `${avgLeadHours}h`,
          provenance: "VERIFIED",
        },
      ],
      alertCount: alertCountByDept("warehousing"),
      summary: `${totalOnHand.toLocaleString()} units on hand (${(totalOnHand - totalReserved).toLocaleString()} available) across ${activeWarehouses.length} branch hub(s).`,
      deepLink: "/warehouses",
    },
    {
      id: "sales",
      name: "Sales",
      status: statusFromScore(
        salesScore,
        raw.orders.length > 0 || totalShipsAll > 0,
      ),
      healthScore: salesScore,
      headlineLabel: "Quote-to-Booking",
      headlineValue: `${conversionRatePct.toFixed(1)}%`,
      deltaPct: conversionDelta,
      higherIsBetter: true,
      provenance: "VERIFIED",
      formula: "Shipments reaching BOOKED/IN_TRANSIT/DELIVERED/CLOSED ÷ Total shipments",
      metrics: [
        {
          label: `Orders (${periodDays}d)`,
          value: String(currentOrders.length || raw.orders.length),
          provenance: "VERIFIED",
        },
        {
          label: "Orders Trend",
          value:
            ordersDeltaPct !== null
              ? `${ordersDeltaPct >= 0 ? "+" : ""}${ordersDeltaPct.toFixed(1)}%`
              : "Baseline",
          provenance: "VERIFIED",
        },
        {
          label: "Est. Pipeline Value",
          value: formatMoneyMajor(estRevenueCurrent, currency),
          provenance: "ESTIMATE",
        },
      ],
      alertCount: alertCountByDept("sales"),
      summary: `${raw.orders.length} total orders recorded; ${raw.quotes.length} carrier quotes scored across active sourcing rounds.`,
      deepLink: "/orders",
    },
    {
      id: "customers",
      name: "Customers",
      status: statusFromScore(customerScore, activeCustomers.length > 0),
      healthScore: customerScore,
      headlineLabel: "Active Accounts",
      headlineValue: String(activeCustomers.length),
      deltaPct: null,
      higherIsBetter: true,
      provenance: "VERIFIED",
      formula: "Count of active customer records linked to shipment & support history",
      metrics: [
        {
          label: "SLA-Risk Accounts",
          value: String(customersAtSlaRisk.length),
          provenance: "VERIFIED",
        },
        {
          label: "Inbound Support",
          value: String(inboundSupportCount),
          provenance: "VERIFIED",
        },
        {
          label: "Avg SLA Target",
          value: (() => {
            const slas = activeCustomers
              .map((c) => c.sla_hours)
              .filter((v): v is number => typeof v === "number" && v > 0);
            return slas.length > 0
              ? `${Math.round(slas.reduce((a, b) => a + b, 0) / slas.length)}h`
              : "—";
          })(),
          provenance: "VERIFIED",
        },
      ],
      alertCount: alertCountByDept("customers"),
      summary:
        customersAtSlaRisk.length > 0
          ? `${customersAtSlaRisk.length} account(s) have active overdue shipments needing proactive communication.`
          : "Zero active customer accounts currently breaching SLA deadlines.",
      deepLink: "/customers",
    },
    {
      id: "hr",
      name: "Human Resources",
      status: statusFromScore(hrScore, activeDrivers.length > 0),
      healthScore: hrScore,
      headlineLabel: "CDL Compliance",
      headlineValue: `${hrCompliancePct.toFixed(1)}%`,
      deltaPct: null,
      higherIsBetter: true,
      provenance: "VERIFIED",
      formula: "(Active drivers − Expired CDL drivers) ÷ Active drivers × 100",
      metrics: [
        {
          label: "Active Roster",
          value: `${activeDrivers.length} (${hazmatDrivers} hazmat)`,
          provenance: "VERIFIED",
        },
        {
          label: "Avg HOS Drive Left",
          value: activeDrivers.length > 0 ? `${avgHosRemaining}h` : "—",
          provenance: "VERIFIED",
        },
        {
          label: "Expiring / Low HOS",
          value: `${readiness.driversExpiringSoon} / ${readiness.driversLowHos}`,
          provenance: "VERIFIED",
        },
      ],
      alertCount: alertCountByDept("hr"),
      summary: `${readiness.driversWithGps}/${activeDrivers.length} drivers reporting live GPS; ${readiness.driversExpiredLicence} expired CDL block(s).`,
      deepLink: "/fleet",
    },
  ];

  // ---------------- 8. EXECUTIVE KPI STRIP ----------------
  const executiveKpis: ExecutiveKpi[] = [
    {
      id: "modeled_revenue",
      label: `Modeled Freight Revenue (${periodDays}d)`,
      valueFormatted: formatMoneyMajor(estRevenueCurrent, currency),
      numericValue: Math.round(estRevenueCurrent),
      unit: currency,
      priorValueFormatted: priorSpend > 0 ? formatMoneyMajor(estRevenuePrior, currency) : null,
      deltaPct: estRevenueDeltaPct,
      higherIsBetter: true,
      provenance: "ESTIMATE",
      formula: "Verified freight spend ÷ (1 − 0.24 target 3PL gross margin benchmark)",
      department: "finance",
    },
    {
      id: "freight_spend",
      label: `Total Freight Spend (${periodDays}d)`,
      valueFormatted: formatMoneyMajor(currentSpend, currency),
      numericValue: Math.round(currentSpend),
      unit: currency,
      priorValueFormatted: priorSpend > 0 ? formatMoneyMajor(priorSpend, currency) : null,
      deltaPct: spendDeltaPct,
      higherIsBetter: false,
      provenance: activeDataset.some((s) => s.costProvenance === "VERIFIED")
        ? "VERIFIED"
        : "ESTIMATE",
      formula: "Sum of booked leg costs / selected quotes (fallback: planned cost estimate)",
      department: "finance",
    },
    {
      id: "gross_margin_est",
      label: `Est. Gross Margin (${periodDays}d)`,
      valueFormatted: formatMoneyMajor(estGrossMarginCurrent, currency),
      numericValue: Math.round(estGrossMarginCurrent),
      unit: currency,
      priorValueFormatted:
        priorSpend > 0
          ? formatMoneyMajor(estRevenuePrior - priorSpend, currency)
          : null,
      deltaPct: estRevenueDeltaPct,
      higherIsBetter: true,
      provenance: "ESTIMATE",
      formula: "Modeled revenue − verified freight spend (24% benchmark rate)",
      department: "finance",
    },
    {
      id: "on_time_sla",
      label: "On-Time SLA Performance",
      valueFormatted: `${onTimeRatePct.toFixed(1)}%`,
      numericValue: onTimeRatePct,
      unit: "%",
      priorValueFormatted: priorShips.length > 0 ? `${priorOnTimePct.toFixed(1)}%` : null,
      deltaPct: onTimeDelta,
      higherIsBetter: true,
      provenance: "VERIFIED",
      formula: "(All shipments − overdue or EXCEPTION shipments) ÷ All shipments",
      department: "operations",
    },
    {
      id: "fleet_utilization",
      label: "Fleet Utilization",
      valueFormatted: `${fleetUtilPct.toFixed(1)}%`,
      numericValue: fleetUtilPct,
      unit: "%",
      priorValueFormatted: null,
      deltaPct: null,
      higherIsBetter: true,
      provenance: "VERIFIED",
      formula: "Vehicles assigned to active shipment legs ÷ Total active fleet",
      department: "fleet",
    },
    {
      id: "cost_per_shipment",
      label: "Avg Cost / Shipment",
      valueFormatted: currentShipCount > 0 ? formatMoneyMajor(avgCostCurrent, currency) : "—",
      numericValue: Math.round(avgCostCurrent),
      unit: currency,
      priorValueFormatted: priorShipCount > 0 ? formatMoneyMajor(avgCostPrior, currency) : null,
      deltaPct: avgCostDeltaPct,
      higherIsBetter: false,
      provenance: "VERIFIED",
      formula: "Total period freight spend ÷ Period shipment count",
      department: "shipments",
    },
  ];

  // ---------------- 9. MULTI-DIMENSIONAL COMPARISONS ----------------
  const departmentComparisons: ComparisonRow[] = departments.map((d) => ({
    id: d.id,
    name: d.name,
    subtitle: d.headlineLabel,
    status: d.status,
    primaryMetricLabel: "Health Score",
    primaryMetricValue: d.healthScore,
    primaryMetricFormatted: d.status === "NO_DATA" ? "No records" : `${d.healthScore}/100`,
    secondaryMetricLabel: "Headline Metric",
    secondaryMetricValue: d.healthScore,
    secondaryMetricFormatted: d.headlineValue,
    efficiencyLabel: "Key Metric",
    efficiencyFormatted: d.metrics[0] ? `${d.metrics[0].label}: ${d.metrics[0].value}` : "—",
    riskLabel: "Active Alerts",
    riskCount: d.alertCount,
    deltaPct: d.deltaPct,
    provenance: d.provenance,
    deepLink: d.deepLink,
  }));

  // Branches / Warehouses comparison
  const branchComparisons: ComparisonRow[] = activeWarehouses.map((w) => {
    const oh = num(w.on_hand, 0);
    const res = num(w.reserved, 0);
    const util = oh > 0 ? Math.round((res / oh) * 1000) / 10 : 0;
    const leadH = num(w.dispatch_lead_hours, 0);
    const cityLower = (w.city ?? "").toLowerCase();
    const branchShips = enrichedShipments.filter(
      (s) =>
        cityLower &&
        (s.originCity.toLowerCase().includes(cityLower) ||
          s.destCity.toLowerCase().includes(cityLower)),
    );
    const branchDelayed = branchShips.filter((s) => s.isDelayedOrException).length;
    const branchLowSkus = lowStockSkus.filter((inv) => inv.warehouse === w.code).length;
    const riskCount = branchDelayed + branchLowSkus + (util >= 85 ? 1 : 0);
    const score = Math.max(20, 95 - riskCount * 15 - (leadH >= 8 ? 15 : 0));

    return {
      id: w.id,
      name: `${w.code} · ${w.name}`,
      subtitle: [w.city, w.country].filter(Boolean).join(", ") || "Regional Hub",
      status: statusFromScore(score, true),
      primaryMetricLabel: "Stock Utilization",
      primaryMetricValue: util,
      primaryMetricFormatted: `${util.toFixed(1)}% (${res.toLocaleString()}/${oh.toLocaleString()})`,
      secondaryMetricLabel: "Linked Shipments",
      secondaryMetricValue: branchShips.length,
      secondaryMetricFormatted: `${branchShips.length} loads`,
      efficiencyLabel: "Dispatch Lead",
      efficiencyFormatted: `${leadH}h · ${num(w.skus, 0)} SKUs`,
      riskLabel: "Risks / Low SKUs",
      riskCount,
      deltaPct: null,
      provenance: "VERIFIED",
      deepLink: "/warehouses",
    };
  });

  // Vehicles comparison
  const vehicleComparisons: ComparisonRow[] = activeVehicles.map((v) => {
    const capKg = num(v.capacity_kg, 0);
    const assigned = Boolean(v.assigned_to);
    const hasGps = Boolean(v.last_lat && v.last_lon);
    const speed = num(v.last_speed, 0);
    const assignedShip = v.assigned_to
      ? enrichedShipments.find((s) => s.raw.reference === v.assigned_to)
      : undefined;
    const riskCount =
      (assignedShip?.isDelayedOrException ? 1 : 0) + (!hasGps && assigned ? 1 : 0);
    const status: DepartmentStatus =
      riskCount > 0 ? "CRITICAL" : assigned ? "HEALTHY" : "WATCH";

    return {
      id: v.id,
      name: v.registration || v.kind || `Unit ${v.id.slice(0, 6)}`,
      subtitle: `${v.mode} · ${v.carrier_name ?? v.carrier_code ?? "Own Fleet"}`,
      status,
      primaryMetricLabel: "Assignment",
      primaryMetricValue: assigned ? 100 : 0,
      primaryMetricFormatted: assigned ? `Active (${v.assigned_to})` : "Idle / Available",
      secondaryMetricLabel: "Capacity",
      secondaryMetricValue: capKg,
      secondaryMetricFormatted: capKg > 0 ? `${capKg.toLocaleString()} kg` : "—",
      efficiencyLabel: "Telemetry",
      efficiencyFormatted: hasGps
        ? `Live GPS${speed > 0 ? ` · ${Math.round(speed)} kph` : ""}`
        : "No recent ping",
      riskLabel: "Flags",
      riskCount,
      deltaPct: null,
      provenance: "VERIFIED",
      deepLink: "/fleet",
    };
  });

  // Routes / Corridors comparison
  const laneMap = new Map<
    string,
    {
      lane: string;
      count: number;
      priorCount: number;
      spend: number;
      km: number;
      co2: number;
      delayed: number;
      modes: Set<string>;
    }
  >();
  for (const s of enrichedShipments) {
    const cur = laneMap.get(s.lane) ?? {
      lane: s.lane,
      count: 0,
      priorCount: 0,
      spend: 0,
      km: 0,
      co2: 0,
      delayed: 0,
      modes: new Set<string>(),
    };
    if (s.inCurrent || usingAllTimeFallback) {
      cur.count += 1;
      cur.spend += s.costMajor;
      cur.km += s.km;
      cur.co2 += s.co2eKg;
      if (s.isDelayedOrException) cur.delayed += 1;
    } else if (s.inPrior) {
      cur.priorCount += 1;
    }
    cur.modes.add(s.primaryMode);
    laneMap.set(s.lane, cur);
  }

  const routeComparisons: ComparisonRow[] = Array.from(laneMap.values())
    .filter((l) => l.count > 0)
    .sort((a, b) => b.spend - a.spend || b.count - a.count)
    .slice(0, 15)
    .map((l) => {
      const avgUnit = l.count > 0 ? l.spend / l.count : 0;
      const onTime = l.count > 0 ? ((l.count - l.delayed) / l.count) * 100 : 100;
      const costPerKm = l.km > 0 ? l.spend / l.km : 0;
      return {
        id: l.lane,
        name: l.lane,
        subtitle: Array.from(l.modes).join(" / "),
        status: statusFromScore(onTime, true),
        primaryMetricLabel: "Volume",
        primaryMetricValue: l.count,
        primaryMetricFormatted: `${l.count} load${l.count === 1 ? "" : "s"}`,
        secondaryMetricLabel: "Lane Spend",
        secondaryMetricValue: Math.round(l.spend),
        secondaryMetricFormatted: formatMoneyMajor(l.spend, currency),
        efficiencyLabel: "Unit / Intensity",
        efficiencyFormatted:
          costPerKm > 0
            ? `${formatMoneyMajor(avgUnit, currency)}/load · ${formatMoneyMajor(costPerKm, currency)}/km`
            : `${formatMoneyMajor(avgUnit, currency)}/load`,
        riskLabel: "Delayed",
        riskCount: l.delayed,
        deltaPct: l.priorCount > 0 ? pctDelta(l.count, l.priorCount) : null,
        provenance: "VERIFIED",
        deepLink: "/shipments",
      };
    });

  // Customers comparison
  const customerComparisons: ComparisonRow[] = activeCustomers
    .map((c) => {
      const totalLoads = num(c.total, 0);
      const openLoads = num(c.open, 0);
      const lateLoads = num(c.late, 0);
      // Match shipments by customer_ref or orders by customer name
      const custShips = enrichedShipments.filter(
        (s) =>
          (s.raw.customer_ref &&
            (s.raw.customer_ref.toLowerCase().includes(c.code.toLowerCase()) ||
              s.raw.customer_ref.toLowerCase().includes(c.name.toLowerCase()))) ||
          false,
      );
      const spend =
        custShips.length > 0
          ? custShips.reduce((sum, x) => sum + x.costMajor, 0)
          : totalLoads * avgCostCurrent;
      const spendProv: DataProvenance =
        custShips.length > 0 ? "VERIFIED" : "ESTIMATE";
      const onTime =
        totalLoads > 0 ? Math.round(((totalLoads - lateLoads) / totalLoads) * 100) : 100;
      return {
        id: c.id,
        name: c.name,
        subtitle: `${c.code}${c.payment_terms ? ` · ${c.payment_terms}` : ""}`,
        status: statusFromScore(onTime - lateLoads * 12, totalLoads > 0),
        primaryMetricLabel: "Shipments",
        primaryMetricValue: totalLoads,
        primaryMetricFormatted: `${totalLoads} total (${openLoads} open)`,
        secondaryMetricLabel: spendProv === "VERIFIED" ? "Freight Spend" : "Est. Spend",
        secondaryMetricValue: Math.round(spend),
        secondaryMetricFormatted: formatMoneyMajor(spend, currency),
        efficiencyLabel: "SLA Health",
        efficiencyFormatted: `${onTime}%${c.sla_hours ? ` · ${c.sla_hours}h SLA` : ""}`,
        riskLabel: "Overdue",
        riskCount: lateLoads,
        deltaPct: null,
        provenance: spendProv,
        deepLink: `/customers/${encodeURIComponent(c.code)}`,
      };
    })
    .sort((a, b) => b.primaryMetricValue - a.primaryMetricValue || b.secondaryMetricValue - a.secondaryMetricValue);

  const comparisons: BiComparisonSuite = {
    departments: departmentComparisons,
    branches: branchComparisons,
    vehicles: vehicleComparisons,
    routes: routeComparisons,
    customers: customerComparisons,
  };

  // ---------------- 10. HISTORICAL DAILY TREND + 7-DAY PREDICTIVE FORECAST ----------------
  const historyDays = periodDays;
  const forecastHorizon = 7;
  const historicalPoints: TrendForecastPoint[] = [];

  for (let i = historyDays - 1; i >= 0; i -= 1) {
    const d = new Date(nowMs - i * DAY_MS);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const dayEnd = dayStart + DAY_MS;
    const dateIso = new Date(dayStart).toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });

    const dayShips = enrichedShipments.filter(
      (s) => s.createdMs >= dayStart && s.createdMs < dayEnd,
    );
    const count = dayShips.length;
    const spend = Math.round(dayShips.reduce((s, x) => s + x.costMajor, 0));
    const co2 = Math.round(dayShips.reduce((s, x) => s + x.co2eKg, 0) * 10) / 10;
    const unitCost = count > 0 ? Math.round(spend / count) : 0;

    historicalPoints.push({
      dateIso,
      label,
      isForecast: false,
      provenance: "VERIFIED",
      shipments: count,
      freightSpendMajor: spend,
      co2eKg: co2,
      costPerShipmentMajor: unitCost,
    });
  }

  const shipFc = linearForecastSeries(
    historicalPoints.map((p) => p.shipments),
    forecastHorizon,
  );
  const spendFc = linearForecastSeries(
    historicalPoints.map((p) => p.freightSpendMajor),
    forecastHorizon,
  );
  const co2Fc = linearForecastSeries(
    historicalPoints.map((p) => p.co2eKg),
    forecastHorizon,
  );

  const forecastPoints: TrendForecastPoint[] = [];
  for (let h = 1; h <= forecastHorizon; h += 1) {
    const d = new Date(nowMs + h * DAY_MS);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const dateIso = new Date(dayStart).toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    const sp = shipFc.points[h - 1];
    const fn = spendFc.points[h - 1];
    const co = co2Fc.points[h - 1];
    const unitCost = sp.predicted > 0 ? Math.round(fn.predicted / sp.predicted) : 0;

    forecastPoints.push({
      dateIso,
      label,
      isForecast: true,
      provenance: "PREDICTION",
      shipments: sp.predicted,
      shipmentsLower: sp.lower,
      shipmentsUpper: sp.upper,
      freightSpendMajor: Math.round(fn.predicted),
      freightSpendLower: Math.round(fn.lower),
      freightSpendUpper: Math.round(fn.upper),
      co2eKg: co.predicted,
      co2eLower: co.lower,
      co2eUpper: co.upper,
      costPerShipmentMajor: unitCost,
    });
  }

  const projectedShipments = Math.round(
    forecastPoints.reduce((s, p) => s + p.shipments, 0),
  );
  const projectedShipmentsLow = Math.round(
    forecastPoints.reduce((s, p) => s + (p.shipmentsLower ?? p.shipments), 0),
  );
  const projectedShipmentsHigh = Math.round(
    forecastPoints.reduce((s, p) => s + (p.shipmentsUpper ?? p.shipments), 0),
  );
  const projectedSpendMajor = Math.round(
    forecastPoints.reduce((s, p) => s + p.freightSpendMajor, 0),
  );
  const projectedSpendLow = Math.round(
    forecastPoints.reduce((s, p) => s + (p.freightSpendLower ?? p.freightSpendMajor), 0),
  );
  const projectedSpendHigh = Math.round(
    forecastPoints.reduce((s, p) => s + (p.freightSpendUpper ?? p.freightSpendMajor), 0),
  );
  const projectedCo2eKg =
    Math.round(forecastPoints.reduce((s, p) => s + p.co2eKg, 0) * 10) / 10;

  const forecastSummary: ForecastSummary = {
    horizonDays: forecastHorizon,
    projectedShipments,
    projectedShipmentsRange: [projectedShipmentsLow, projectedShipmentsHigh],
    projectedSpendMajor,
    projectedSpendRange: [projectedSpendLow, projectedSpendHigh],
    projectedCo2eKg,
    shipmentSlopePerDay: shipFc.slope,
    confidenceLevel: shipFc.confidenceLevel,
    methodology: `Dampened OLS linear regression over the trailing ${historyDays} daily verified buckets with widening ±1σ residual confidence bands.`,
  };

  // ---------------- 11. 30-DAY PREDICTIVE FORECAST (VOLUME & CARRIER COST) ----------------
  const hist30Days = 30;
  const fc30Horizon = 30 as const;
  const hist30Buckets: {
    dateIso: string;
    label: string;
    dayOfWeek: number;
    shipments: number;
    carrierCostMajor: number;
  }[] = [];

  for (let i = hist30Days - 1; i >= 0; i -= 1) {
    const d = new Date(nowMs - i * DAY_MS);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const dayEnd = dayStart + DAY_MS;
    const dateIso = new Date(dayStart).toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });

    const dayShips = enrichedShipments.filter(
      (s) => s.createdMs >= dayStart && s.createdMs < dayEnd,
    );
    const count = dayShips.length;
    const carrierCostMajor = Math.round(dayShips.reduce((sum, x) => sum + x.costMajor, 0));

    hist30Buckets.push({
      dateIso,
      label,
      dayOfWeek: d.getUTCDay(),
      shipments: count,
      carrierCostMajor,
    });
  }

  const futureDates30 = Array.from({ length: fc30Horizon }, (_, idx) => {
    const d = new Date(nowMs + (idx + 1) * DAY_MS);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return {
      dateIso: new Date(dayStart).toISOString().slice(0, 10),
      label: d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
      dayOfWeek: d.getUTCDay(),
    };
  });

  const shipFc30 = build30dLinearSeries(
    hist30Buckets.map((b) => ({ value: b.shipments, dayOfWeek: b.dayOfWeek })),
    futureDates30.map((f) => f.dayOfWeek),
  );
  const costFc30 = build30dLinearSeries(
    hist30Buckets.map((b) => ({ value: b.carrierCostMajor, dayOfWeek: b.dayOfWeek })),
    futureDates30.map((f) => f.dayOfWeek),
  );

  const dailySeries30: Forecast30dPoint[] = [];
  const lastHistIdx = hist30Buckets.length - 1;
  hist30Buckets.forEach((b, idx) => {
    const isToday = idx === lastHistIdx;
    dailySeries30.push({
      dateIso: b.dateIso,
      label: b.label,
      dayIndex: idx - lastHistIdx, // -29 .. 0
      isForecast: false,
      provenance: "VERIFIED",
      actualShipments: b.shipments,
      // Bridge point on Today connects solid verified series cleanly to dashed forecast line
      projectedShipments: isToday ? b.shipments : null,
      shipmentsLower: isToday ? b.shipments : null,
      shipmentsUpper: isToday ? b.shipments : null,
      shipmentsBandBase: isToday ? b.shipments : null,
      shipmentsBandSpan: isToday ? 0 : null,
      actualCarrierCostMajor: b.carrierCostMajor,
      projectedCarrierCostMajor: isToday ? b.carrierCostMajor : null,
      carrierCostLower: isToday ? b.carrierCostMajor : null,
      carrierCostUpper: isToday ? b.carrierCostMajor : null,
      carrierCostBandBase: isToday ? b.carrierCostMajor : null,
      carrierCostBandSpan: isToday ? 0 : null,
      cumulativeProjectedCostMajor: isToday ? 0 : null,
    });
  });

  let cumulativeCost = 0;
  const futurePointsOnly: Forecast30dPoint[] = [];
  futureDates30.forEach((f, idx) => {
    const sp = shipFc30.points[idx];
    const cs = costFc30.points[idx];
    const projCost = Math.round(cs.predicted);
    const costLow = Math.round(cs.lower);
    const costHigh = Math.max(projCost, Math.round(cs.upper));
    cumulativeCost += projCost;

    const pt: Forecast30dPoint = {
      dateIso: f.dateIso,
      label: f.label,
      dayIndex: idx + 1,
      isForecast: true,
      provenance: "PREDICTION",
      actualShipments: null,
      projectedShipments: sp.predicted,
      shipmentsLower: sp.lower,
      shipmentsUpper: sp.upper,
      shipmentsBandBase: sp.lower,
      shipmentsBandSpan: Math.max(0, Math.round((sp.upper - sp.lower) * 10) / 10),
      actualCarrierCostMajor: null,
      projectedCarrierCostMajor: projCost,
      carrierCostLower: costLow,
      carrierCostUpper: costHigh,
      carrierCostBandBase: costLow,
      carrierCostBandSpan: Math.max(0, costHigh - costLow),
      cumulativeProjectedCostMajor: cumulativeCost,
    };
    dailySeries30.push(pt);
    futurePointsOnly.push(pt);
  });

  const totalProjectedShipments30 = Math.round(
    futurePointsOnly.reduce((s, p) => s + (p.projectedShipments ?? 0), 0),
  );
  const totalShipLow30 = Math.round(
    futurePointsOnly.reduce((s, p) => s + (p.shipmentsLower ?? 0), 0),
  );
  const totalShipHigh30 = Math.round(
    futurePointsOnly.reduce((s, p) => s + (p.shipmentsUpper ?? 0), 0),
  );
  const totalProjectedCost30 = futurePointsOnly.reduce(
    (s, p) => s + (p.projectedCarrierCostMajor ?? 0),
    0,
  );
  const totalCostLow30 = futurePointsOnly.reduce(
    (s, p) => s + (p.carrierCostLower ?? 0),
    0,
  );
  const totalCostHigh30 = futurePointsOnly.reduce(
    (s, p) => s + (p.carrierCostUpper ?? 0),
    0,
  );
  const projectedAvgCost30 =
    totalProjectedShipments30 > 0
      ? Math.round(totalProjectedCost30 / totalProjectedShipments30)
      : Math.round(avgCostCurrent);

  const peakPt = futurePointsOnly.reduce(
    (best, cur) =>
      (cur.projectedCarrierCostMajor ?? 0) > (best.projectedCarrierCostMajor ?? 0) ||
      (cur.projectedShipments ?? 0) > (best.projectedShipments ?? 0)
        ? cur
        : best,
    futurePointsOnly[0],
  );

  // Weekly rollup buckets covering all 30 forecast days (7 + 7 + 7 + 9 days)
  const weekSlices: [string, number, number][] = [
    ["Week 1", 0, 7],
    ["Week 2", 7, 14],
    ["Week 3", 14, 21],
    ["Week 4 (9d)", 21, 30],
  ];
  const weeklyRollup: Forecast30dWeeklyBucket[] = weekSlices.map(
    ([weekLabel, start, end]) => {
      const slice = futurePointsOnly.slice(start, end);
      const firstLbl = slice[0]?.label ?? "";
      const lastLbl = slice[slice.length - 1]?.label ?? "";
      return {
        weekLabel,
        dateRangeLabel: firstLbl && lastLbl ? `${firstLbl} – ${lastLbl}` : weekLabel,
        projectedShipments: Math.round(
          slice.reduce((s, p) => s + (p.projectedShipments ?? 0), 0) * 10,
        ) / 10,
        shipmentsLower: Math.round(
          slice.reduce((s, p) => s + (p.shipmentsLower ?? 0), 0),
        ),
        shipmentsUpper: Math.round(
          slice.reduce((s, p) => s + (p.shipmentsUpper ?? 0), 0),
        ),
        projectedCarrierCostMajor: Math.round(
          slice.reduce((s, p) => s + (p.projectedCarrierCostMajor ?? 0), 0),
        ),
        carrierCostLower: Math.round(
          slice.reduce((s, p) => s + (p.carrierCostLower ?? 0), 0),
        ),
        carrierCostUpper: Math.round(
          slice.reduce((s, p) => s + (p.carrierCostUpper ?? 0), 0),
        ),
        provenance: "PREDICTION",
      };
    },
  );

  // Proportional transport mode carrier cost & volume allocation for next 30 days
  const modeCounts = new Map<string, { count: number; spend: number }>();
  for (const s of enrichedShipments) {
    const cur = modeCounts.get(s.primaryMode) ?? { count: 0, spend: 0 };
    cur.count += 1;
    cur.spend += s.costMajor;
    modeCounts.set(s.primaryMode, cur);
  }
  const totalModeCount = Array.from(modeCounts.values()).reduce(
    (s, v) => s + v.count,
    0,
  );
  const totalModeSpend = Array.from(modeCounts.values()).reduce(
    (s, v) => s + v.spend,
    0,
  );
  const modeAllocation: Forecast30dModeProjection[] = Array.from(modeCounts.entries())
    .sort((a, b) => b[1].spend - a[1].spend || b[1].count - a[1].count)
    .map(([mode, stats]) => {
      const sharePct =
        totalModeCount > 0
          ? Math.round((stats.count / totalModeCount) * 1000) / 10
          : 0;
      const spendShare =
        totalModeSpend > 0
          ? stats.spend / totalModeSpend
          : totalModeCount > 0
            ? stats.count / totalModeCount
            : 0;
      const projShip =
        Math.round(((totalProjectedShipments30 * sharePct) / 100) * 10) / 10;
      const projCost = Math.round(totalProjectedCost30 * spendShare);
      return {
        mode,
        sharePct,
        projectedShipments: projShip,
        projectedCarrierCostMajor: projCost,
        avgCostPerShipmentMajor:
          projShip > 0
            ? Math.round(projCost / projShip)
            : stats.count > 0
              ? Math.round(stats.spend / stats.count)
              : 0,
        provenance: "PREDICTION",
      };
    });

  const forecast30d: PredictiveForecast30d = {
    horizonDays: fc30Horizon,
    historicalDaysUsed: hist30Days,
    todayLabel: hist30Buckets[lastHistIdx]?.label ?? "Today",
    totalProjectedShipments: totalProjectedShipments30,
    projectedShipmentsRange: [totalShipLow30, Math.max(totalProjectedShipments30, totalShipHigh30)],
    totalProjectedCarrierCostMajor: totalProjectedCost30,
    projectedCarrierCostRange: [totalCostLow30, Math.max(totalProjectedCost30, totalCostHigh30)],
    projectedAvgCostPerShipmentMajor: projectedAvgCost30,
    dailyShipmentSlope: shipFc30.slope,
    dailyCostSlopeMajor: Math.round(costFc30.slope),
    peakDayLabel: peakPt?.label ?? "—",
    peakDayShipments: peakPt?.projectedShipments ?? 0,
    peakDayCarrierCostMajor: peakPt?.projectedCarrierCostMajor ?? 0,
    confidenceLevel: shipFc30.confidenceLevel,
    methodology:
      "Log-damped OLS trend regression over the trailing 30 daily verified shipment & carrier cost buckets, blended with weekday seasonality (when >=10 active days exist) and widening ±1σ residual confidence bands.",
    dailySeries: dailySeries30,
    weeklyRollup,
    modeAllocation,
  };

  const methodologyNotes: MethodologyNote[] = [
    {
      provenance: "VERIFIED",
      title: "Verified Operational & Financial Records",
      description:
        "Direct counts, sums, and averages from tenant-scoped shipments, legs, quotes, orders, warehouses, inventory, fleet conveyances, drivers, customs, and exceptions.",
    },
    {
      provenance: "ESTIMATE",
      title: "Transparently Modeled Estimates",
      description:
        "Fuel proxy (distance × mode factor), dock detention exposure (>2h free time × regional benchmark), and brokerage gross margin (24% target benchmark) where raw invoices are absent.",
    },
    {
      provenance: "PREDICTION",
      title: "30-Day Predictive Volume & Carrier Cost Forecasts",
      description:
        "Next-30-day shipment volume, carrier cost budgets, and CO₂e projections derived via log-damped linear regression on verified historical daily series with widening ±1σ confidence bounds.",
    },
  ];

  const baseSnapshot: BiSnapshot = {
    orgName: raw.orgName,
    roleScope: getBiAccessPolicy(role),
    periodDays,
    periodLabel: `Last ${periodDays} days`,
    comparisonLabel: `vs prior ${periodDays} days`,
    generatedAt: now.toISOString(),
    currency,
    recordCounts: {
      shipments: raw.shipments.length,
      orders: raw.orders.length,
      vehicles: activeVehicles.length,
      drivers: activeDrivers.length,
      warehouses: activeWarehouses.length,
      customers: activeCustomers.length,
      openExceptions: openExcCount,
    },
    executiveKpis,
    departments,
    proactiveAlerts: alerts,
    comparisons,
    trendWithForecast: [...historicalPoints, ...forecastPoints],
    forecastSummary,
    forecast30d,
    methodologyNotes,
  };

  return applyBiRoleRedaction(baseSnapshot, role);
}

/**
 * Deterministic natural-language BI analyzer used as a truthful fallback whenever
 * GEMINI_API_KEY is unconfigured or unavailable — always tagged `DETERMINISTIC_ENGINE`.
 */
export function answerBiQuestionDeterministically(
  question: string,
  snapshot: BiSnapshot,
): BiQueryResponse {
  const q = question.toLowerCase();
  const currency = snapshot.currency;

  const isFinance = /cost|spend|margin|revenue|fuel|expense|profit|finance|budget|quote/i.test(q);
  const isBranch = /branch|warehouse|hub|stock|inventory|sku/i.test(q);
  const isFleetHr = /fleet|vehicle|truck|driver|hos|cdl|hr|workforce|idle/i.test(q);
  const isCustomer = /customer|client|account|sla|churn|support/i.test(q);
  const isForecast = /forecast|predict|next week|projection|future|trend/i.test(q);
  const isRoute = /route|lane|corridor|delay|exception|late|detention/i.test(q);

  if (isForecast) {
    const wants30d = /30|month|carrier cost|budget|capacity|weekly/i.test(q) && !/7-day|7 day|next week/i.test(q);
    if (wants30d) {
      const f30 = snapshot.forecast30d;
      const costRedacted = Boolean(f30.carrierCostRedacted);
      const costSummaryText = costRedacted
        ? "carrier cost budget figures are restricted for your role"
        : `${formatMoneyMajor(f30.totalProjectedCarrierCostMajor, currency)} projected carrier cost requirement (upper ±1σ reserve ${formatMoneyMajor(f30.projectedCarrierCostRange[1], currency)})`;

      return {
        question,
        answeredBy: "DETERMINISTIC_ENGINE",
        generatedAt: new Date().toISOString(),
        summary: `Next 30 days projected at ${f30.totalProjectedShipments} shipments (±1σ band ${f30.projectedShipmentsRange[0]}–${f30.projectedShipmentsRange[1]}) with ${costSummaryText} (${f30.confidenceLevel} confidence).`,
        explanation: `Trained on trailing ${f30.historicalDaysUsed} verified daily records (slope ${f30.dailyShipmentSlope >= 0 ? "+" : ""}${f30.dailyShipmentSlope} loads/day), peak volume is expected on ${f30.peakDayLabel} (${f30.peakDayShipments} loads). Weekly capacity rollups partition all 30 forecast days for carrier contracting and working-capital planning.`,
        provenanceTags: ["VERIFIED", "PREDICTION"],
        formulasUsed: [f30.methodology],
        chart: {
          type: "bar",
          title: "30-Day Weekly Projected Volume (PREDICTION)",
          unit: "loads",
          provenance: "PREDICTION",
          points: f30.weeklyRollup.map((w) => ({
            label: w.weekLabel,
            value: w.projectedShipments,
            ...(costRedacted
              ? {}
              : {
                  secondaryValue: w.projectedCarrierCostMajor,
                  secondaryLabel: `Carrier Cost (${currency})`,
                }),
          })),
        },
        table: {
          title: "30-Day Weekly Capacity & Carrier Budget Rollup",
          columns: [
            "Window",
            "Dates",
            "Projected Volume",
            "Volume ±1σ",
            "Carrier Cost Req.",
          ],
          rows: f30.weeklyRollup.map((w) => [
            w.weekLabel,
            w.dateRangeLabel,
            `${w.projectedShipments} loads`,
            `${w.shipmentsLower}–${w.shipmentsUpper}`,
            costRedacted
              ? "Restricted"
              : formatMoneyMajor(w.projectedCarrierCostMajor, currency),
          ]),
          provenance: "PREDICTION",
        },
        recommendations: [
          {
            priority: "P1",
            department: "dispatch",
            action: `Pre-commit contracted carrier capacity ahead of peak day ${f30.peakDayLabel} (${f30.peakDayShipments} projected loads) across top transport modes.`,
            expectedImpact: "Prevents spot-market rate spikes during peak 30-day dispatch windows",
            provenance: "PREDICTION",
            deepLink: "/carriers",
          },
          {
            priority: "P2",
            department: "finance",
            action: costRedacted
              ? "Coordinate with Finance/Approvers to align 30-day carrier spend ceilings with projected load volume."
              : `Reserve ${formatMoneyMajor(f30.projectedCarrierCostRange[1], currency)} upper-bound 30-day carrier working capital ceiling.`,
            expectedImpact: "Eliminates approval bottlenecks and keeps carrier settlement on time",
            provenance: "PREDICTION",
            deepLink: "/approvals",
          },
        ],
        followUpQuestions: [
          "Which corridors carry the highest cost per shipment?",
          "What proactive risks need management attention right now?",
          "How are our warehouses performing on stock utilization?",
        ],
        accessNote: snapshot.roleScope.redactionNotes[0] ?? null,
      };
    }

    const fc = snapshot.forecastSummary;
    const fcPts = snapshot.trendWithForecast.filter((p) => p.isForecast);
    return {
      question,
      answeredBy: "DETERMINISTIC_ENGINE",
      generatedAt: new Date().toISOString(),
      summary: `Next ${fc.horizonDays} days projected at ${fc.projectedShipments} shipments (${fc.projectedShipmentsRange[0]}–${fc.projectedShipmentsRange[1]}) and ${formatMoneyMajor(fc.projectedSpendMajor, currency)} freight spend (${fc.confidenceLevel} confidence).`,
      explanation: `Based on trailing ${snapshot.periodDays}-day verified shipment velocity (slope ${fc.shipmentSlopePerDay >= 0 ? "+" : ""}${fc.shipmentSlopePerDay}/day), the deterministic regression model projects ${fc.projectedShipments} loads and ${fc.projectedCo2eKg} kg CO₂e over the coming ${fc.horizonDays} days.`,
      provenanceTags: ["VERIFIED", "PREDICTION"],
      formulasUsed: [fc.methodology],
      chart: {
        type: "line",
        title: `7-Day Shipment Volume Forecast (PREDICTION)`,
        unit: "shipments",
        provenance: "PREDICTION",
        points: fcPts.map((p) => ({
          label: p.label,
          value: p.shipments,
          secondaryValue: p.freightSpendMajor,
          secondaryLabel: `Spend (${currency})`,
        })),
      },
      table: {
        title: "Daily 7-Day Forecast Breakdown",
        columns: ["Date", "Projected Loads", "Confidence Band", "Projected Spend", "Projected CO₂e"],
        rows: fcPts.map((p) => [
          p.label,
          String(p.shipments),
          `${p.shipmentsLower ?? 0} – ${p.shipmentsUpper ?? p.shipments}`,
          formatMoneyMajor(p.freightSpendMajor, currency),
          `${p.co2eKg} kg`,
        ]),
        provenance: "PREDICTION",
      },
      recommendations: [
        {
          priority: "P1",
          department: "dispatch",
          action: `Pre-position available drivers and fleet units to absorb ~${fc.projectedShipments} projected loads next week.`,
          expectedImpact: "Prevents last-minute spot carrier premiums during peak dispatch windows",
          provenance: "PREDICTION",
          deepLink: "/fleet",
        },
        {
          priority: "P2",
          department: "finance",
          action: `Reserve ${formatMoneyMajor(fc.projectedSpendRange[1], currency)} upper-bound working capital ceiling for the coming 7-day cycle.`,
          expectedImpact: "Eliminates policy spend-hold bottlenecks on urgent freight",
          provenance: "PREDICTION",
          deepLink: "/approvals",
        },
      ],
      followUpQuestions: [
        "Which corridors carry the highest cost per shipment?",
        "What proactive risks need management attention right now?",
        "How are our warehouses performing on stock utilization?",
      ],
      accessNote: snapshot.roleScope.redactionNotes[0] ?? null,
    };
  }

  if (isBranch && snapshot.comparisons.branches.length > 0) {
    const branches = snapshot.comparisons.branches;
    return {
      question,
      answeredBy: "DETERMINISTIC_ENGINE",
      generatedAt: new Date().toISOString(),
      summary: `Analyzed ${branches.length} active branch warehouse(s): ${branches.filter((b) => b.status !== "HEALTHY").length} show capacity, stockout, or dispatch lead-time strain.`,
      explanation: `Branch health compares warehouse reservation utilization (reserved ÷ on-hand), dispatch lead hours, low-stock SKUs (<20% available), and linked corridor delays directly from live warehouse & inventory records.`,
      provenanceTags: ["VERIFIED"],
      formulasUsed: [
        "Utilization = reserved ÷ on_hand × 100",
        "Low-stock flag = available ÷ on_hand < 20%",
      ],
      chart: {
        type: "horizontal_bar",
        title: "Branch Stock Utilization (%)",
        unit: "%",
        provenance: "VERIFIED",
        points: branches.slice(0, 8).map((b) => ({
          label: b.name,
          value: b.primaryMetricValue,
        })),
      },
      table: {
        title: "Branch & Warehouse Performance Comparison",
        columns: ["Branch", "Location", "Utilization", "Linked Loads", "Lead Time", "Risks"],
        rows: branches.slice(0, 10).map((b) => [
          b.name,
          b.subtitle ?? "—",
          b.primaryMetricFormatted,
          b.secondaryMetricFormatted,
          b.efficiencyFormatted,
          String(b.riskCount),
        ]),
        provenance: "VERIFIED",
      },
      recommendations: [
        {
          priority: "P1",
          department: "warehousing",
          action: "Rebalance high-velocity SKUs from low-utilization hubs to branches above 85% reserved capacity.",
          expectedImpact: "Reduces split-shipment freight spend and order fulfillment delays",
          provenance: "VERIFIED",
          deepLink: "/warehouses",
        },
      ],
      followUpQuestions: [
        "Which routes have the most shipment delays?",
        "Compare our top customers by volume and SLA risk",
        "Show the 7-day forecast for shipments and spend",
      ],
      accessNote: snapshot.roleScope.redactionNotes[0] ?? null,
    };
  }

  if (isCustomer && snapshot.comparisons.customers.length > 0) {
    const customers = snapshot.comparisons.customers.slice(0, 8);
    return {
      question,
      answeredBy: "DETERMINISTIC_ENGINE",
      generatedAt: new Date().toISOString(),
      summary: `Top ${customers.length} active customer accounts analyzed; ${customers.filter((c) => c.riskCount > 0).length} account(s) currently have overdue shipments.`,
      explanation: `Customer rankings aggregate total and open shipment volume, verified or estimated freight spend, and active overdue SLA breaches across your tenant records.`,
      provenanceTags: customers.some((c) => c.provenance === "ESTIMATE")
        ? ["VERIFIED", "ESTIMATE"]
        : ["VERIFIED"],
      formulasUsed: [
        "SLA Health = (total shipments − overdue open shipments) ÷ total shipments × 100",
      ],
      chart: {
        type: "horizontal_bar",
        title: "Top Customers by Shipment Volume",
        unit: "loads",
        provenance: "VERIFIED",
        points: customers.map((c) => ({
          label: c.name,
          value: c.primaryMetricValue,
        })),
      },
      table: {
        title: "Customer Volume, Spend & SLA Risk",
        columns: ["Customer", "Shipments", "Spend", "SLA Health", "Overdue"],
        rows: customers.map((c) => [
          c.name,
          c.primaryMetricFormatted,
          c.secondaryMetricFormatted,
          c.efficiencyFormatted,
          String(c.riskCount),
        ]),
        provenance: "VERIFIED",
      },
      recommendations: [
        {
          priority: "P1",
          department: "customers",
          action: "Prioritize recovery dispatch and proactive status alerts for accounts with overdue shipments.",
          expectedImpact: "Protects enterprise account retention and avoids SLA service credits",
          provenance: "VERIFIED",
          deepLink: "/customers",
        },
      ],
      followUpQuestions: [
        "What unusual expenses or cost spikes occurred this period?",
        "How is our fleet utilization and driver compliance?",
        "Which routes are causing the most delays?",
      ],
      accessNote: snapshot.roleScope.redactionNotes[0] ?? null,
    };
  }

  if (isFleetHr) {
    const fleetDept = snapshot.departments.find((d) => d.id === "fleet");
    const hrDept = snapshot.departments.find((d) => d.id === "hr");
    const vehicles = snapshot.comparisons.vehicles.slice(0, 8);
    return {
      question,
      answeredBy: "DETERMINISTIC_ENGINE",
      generatedAt: new Date().toISOString(),
      summary: `Fleet utilization is ${fleetDept?.headlineValue ?? "0%"} with HR CDL compliance at ${hrDept?.headlineValue ?? "100%"} across ${snapshot.recordCounts.drivers} active drivers.`,
      explanation: `${fleetDept?.summary ?? ""} ${hrDept?.summary ?? ""}`.trim(),
      provenanceTags: ["VERIFIED", "ESTIMATE"],
      formulasUsed: [
        "Fleet Utilization = Assigned active conveyances ÷ Total active conveyances",
        "CDL Compliance = (Active drivers − Expired CDL drivers) ÷ Active drivers",
      ],
      chart:
        vehicles.length > 0
          ? {
              type: "horizontal_bar",
              title: "Active Fleet Payload Capacity (kg)",
              unit: "kg",
              provenance: "VERIFIED",
              points: vehicles.map((v) => ({
                label: v.name,
                value: v.secondaryMetricValue,
              })),
            }
          : null,
      table:
        vehicles.length > 0
          ? {
              title: "Fleet Vehicle Utilization & Telemetry",
              columns: ["Vehicle", "Carrier / Mode", "Status", "Capacity", "Telemetry"],
              rows: vehicles.map((v) => [
                v.name,
                v.subtitle ?? "—",
                v.primaryMetricFormatted,
                v.secondaryMetricFormatted,
                v.efficiencyFormatted,
              ]),
              provenance: "VERIFIED",
            }
          : null,
      recommendations: [
        {
          priority: "P1",
          department: "hr",
          action: "Resolve any expired or expiring CDL licences and rotate drivers with < 2.5h HOS drive clock.",
          expectedImpact: "Maintains 100% legal dispatch readiness and eliminates compliance holds",
          provenance: "VERIFIED",
          deepLink: "/fleet",
        },
        {
          priority: "P2",
          department: "fleet",
          action: "Assign idle internal vehicles to open regional loads before sourcing spot carriers.",
          expectedImpact: "Improves asset utilization and lowers variable freight spend",
          provenance: "VERIFIED",
          deepLink: "/fleet",
        },
      ],
      followUpQuestions: [
        "Why did freight spend or unit cost change this period?",
        "Which branches have inventory bottlenecks?",
        "What are the top proactive alerts right now?",
      ],
      accessNote: snapshot.roleScope.redactionNotes[0] ?? null,
    };
  }

  if (isFinance || isRoute) {
    const routes = snapshot.comparisons.routes.slice(0, 8);
    const finDept = snapshot.departments.find((d) => d.id === "finance");
    const opsDept = snapshot.departments.find((d) => d.id === "operations");
    return {
      question,
      answeredBy: "DETERMINISTIC_ENGINE",
      generatedAt: new Date().toISOString(),
      summary: `${finDept?.headlineLabel ?? "Freight Spend"}: ${finDept?.headlineValue ?? "—"} across ${snapshot.recordCounts.shipments} shipments, with ${opsDept?.headlineValue ?? "100%"} on-time SLA health across ${routes.length} active corridors.`,
      explanation: `${finDept?.summary ?? ""} ${opsDept?.summary ?? ""}`.trim(),
      provenanceTags: ["VERIFIED", "ESTIMATE"],
      formulasUsed: [
        "Unit Cost = Period freight spend ÷ Period shipment count",
        "Corridor On-Time = (Corridor loads − delayed/exception loads) ÷ Corridor loads",
      ],
      chart:
        routes.length > 0
          ? {
              type: "horizontal_bar",
              title: `Top Corridors by Freight Spend (${currency})`,
              unit: currency,
              provenance: "VERIFIED",
              points: routes.map((r) => ({
                label: r.name,
                value: r.secondaryMetricValue,
              })),
            }
          : null,
      table:
        routes.length > 0
          ? {
              title: "Corridor Cost & Delay Performance",
              columns: ["Corridor", "Mode", "Volume", "Total Spend", "Unit / Cost per km", "Delayed"],
              rows: routes.map((r) => [
                r.name,
                r.subtitle ?? "—",
                r.primaryMetricFormatted,
                r.secondaryMetricFormatted,
                r.efficiencyFormatted,
                String(r.riskCount),
              ]),
              provenance: "VERIFIED",
            }
          : null,
      recommendations: [
        {
          priority: "P1",
          department: "finance",
          action: "Negotiate fixed contract rates on the top 3 highest-spend corridors and audit outlier shipments.",
          expectedImpact: "Stabilizes cost per shipment and protects gross margin",
          provenance: "VERIFIED",
          deepLink: "/carriers",
        },
        {
          priority: "P2",
          department: "operations",
          action: "Pre-stage backup carriers on corridors showing elevated exception or delay counts.",
          expectedImpact: "Lifts on-time SLA performance toward >= 95% target",
          provenance: "VERIFIED",
          deepLink: "/exceptions",
        },
      ],
      followUpQuestions: [
        "Show our 7-day predictive forecast for volume and spend",
        "Compare all 9 departments by health score",
        "Which customers have the highest SLA exposure?",
      ],
      accessNote: snapshot.roleScope.redactionNotes[0] ?? null,
    };
  }

  // General cross-department executive briefing
  const activeAlerts = snapshot.proactiveAlerts.filter((a) => !a.acknowledged);
  const recs: BiRecommendation[] = activeAlerts.slice(0, 3).map((a, idx) => ({
    priority: idx === 0 ? "P1" : idx === 1 ? "P2" : "P3",
    department: a.department,
    action: a.recommendedAction,
    expectedImpact: a.estimatedImpact,
    provenance: a.provenance,
    deepLink: a.deepLink,
  }));
  if (recs.length === 0) {
    recs.push({
      priority: "P2",
      department: "operations",
      action: "Continue daily monitoring of quote-to-booking conversion and fleet utilization as volume scales.",
      expectedImpact: "Sustains healthy SLA and cost discipline across all 9 departments",
      provenance: "VERIFIED",
      deepLink: "/intelligence",
    });
  }

  return {
    question,
    answeredBy: "DETERMINISTIC_ENGINE",
    generatedAt: new Date().toISOString(),
    summary: `Cross-department intelligence across all 9 departments: ${activeAlerts.length} active proactive alert(s), ${snapshot.recordCounts.shipments} shipments, and ${snapshot.forecastSummary.projectedShipments} projected loads over the next 7 days.`,
    explanation: `All 9 departments (Finance, Operations, Fleet, Shipments, Dispatch, Warehousing, Sales, Customers, HR) are scored 0–100 from verified tenant data. Lowest-scoring departments highlight where leadership action yields the fastest cost or SLA recovery.`,
    provenanceTags: ["VERIFIED", "ESTIMATE", "PREDICTION"],
    formulasUsed: [
      "Department Health Score = deterministic composite of verified SLA, utilization, compliance, and cost variance metrics",
    ],
    chart: {
      type: "horizontal_bar",
      title: "Department Health Score Comparison (0–100)",
      unit: "pts",
      provenance: "VERIFIED",
      points: snapshot.departments.map((d) => ({
        label: d.name,
        value: d.healthScore,
      })),
    },
    table: {
      title: "9-Department Executive Scorecard",
      columns: ["Department", "Health", "Status", "Headline Metric", "Open Alerts"],
      rows: snapshot.departments.map((d) => [
        d.name,
        `${d.healthScore}/100`,
        d.status,
        `${d.headlineLabel}: ${d.headlineValue}`,
        String(d.alertCount),
      ]),
      provenance: "VERIFIED",
    },
    recommendations: recs,
    followUpQuestions: [
      "Which corridors have the highest freight cost and delay risk?",
      "Show the 7-day forecast for shipments, spend, and emissions",
      "How are our branches and warehouses performing?",
    ],
    accessNote: snapshot.roleScope.redactionNotes[0] ?? null,
  };
}
