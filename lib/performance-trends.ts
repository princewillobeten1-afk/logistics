export interface DailyPerformancePoint {
  dateIso: string;
  label: string;
  weekday: string;
  shipments: number;
  emissionsKg: number;
  totalCostMinor: number;
  costPerShipmentMinor: number;
}

export interface PerformanceShipmentInput {
  id: string;
  created_at: Date | string;
  plan?: Record<string, unknown> | null;
}

export interface PerformanceLegInput {
  shipment_id: string;
  cost_minor: string | number | null;
  co2e_kg?: string | number | null;
}

export interface PerformanceQuoteInput {
  shipment_id: string;
  state: string;
  amount_minor: string | number | null;
}

function toPositiveNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Computes a 7-day UTC daily operational performance series strictly from real
 * shipment, leg, and quote records:
 * - daily shipment count
 * - daily CO2e emissions (kg)
 * - daily total freight cost & average cost per shipment (minor currency units)
 */
export function buildSevenDayPerformanceTrend({
  shipments,
  legs,
  quotes,
  now = new Date(),
  days = 7,
}: {
  shipments: PerformanceShipmentInput[];
  legs: PerformanceLegInput[];
  quotes: PerformanceQuoteInput[];
  now?: Date;
  days?: number;
}): DailyPerformancePoint[] {
  const safeDays = Math.max(1, Math.min(30, Math.round(days)));

  const legStatsByShipment = new Map<
    string,
    { costMinor: number; co2eKg: number }
  >();
  for (const leg of legs) {
    const prev = legStatsByShipment.get(leg.shipment_id) ?? {
      costMinor: 0,
      co2eKg: 0,
    };
    prev.costMinor += toPositiveNumber(leg.cost_minor);
    prev.co2eKg += toPositiveNumber(leg.co2e_kg);
    legStatsByShipment.set(leg.shipment_id, prev);
  }

  const quoteCostByShipment = new Map<
    string,
    { selected: number | null; lowest: number | null }
  >();
  for (const q of quotes) {
    const amt = toPositiveNumber(q.amount_minor);
    if (amt <= 0) continue;
    const prev = quoteCostByShipment.get(q.shipment_id) ?? {
      selected: null,
      lowest: null,
    };
    if (q.state === "SELECTED") {
      prev.selected = amt;
    }
    if (prev.lowest === null || amt < prev.lowest) {
      prev.lowest = amt;
    }
    quoteCostByShipment.set(q.shipment_id, prev);
  }

  const todayUtcStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );

  const buckets: Array<{
    dayStart: number;
    dayEnd: number;
    dateIso: string;
    label: string;
    weekday: string;
    shipments: number;
    emissionsKg: number;
    totalCostMinor: number;
  }> = [];

  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const dayStart = todayUtcStart - offset * 86_400_000;
    const dayEnd = dayStart + 86_400_000;
    const d = new Date(dayStart);
    buckets.push({
      dayStart,
      dayEnd,
      dateIso: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
      weekday: d.toLocaleDateString("en-US", {
        weekday: "short",
        timeZone: "UTC",
      }),
      shipments: 0,
      emissionsKg: 0,
      totalCostMinor: 0,
    });
  }

  const windowStart = buckets[0].dayStart;
  const windowEnd = buckets[buckets.length - 1].dayEnd;

  for (const s of shipments) {
    const createdMs = new Date(s.created_at).getTime();
    if (!Number.isFinite(createdMs)) continue;
    if (createdMs < windowStart || createdMs >= windowEnd) continue;

    const bucketIdx = Math.floor((createdMs - windowStart) / 86_400_000);
    const bucket = buckets[bucketIdx];
    if (!bucket) continue;

    const plan = (s.plan ?? {}) as Record<string, unknown>;
    const legStats = legStatsByShipment.get(s.id);
    const quoteStats = quoteCostByShipment.get(s.id);

    const planCo2 = toPositiveNumber(plan.co2e_kg);
    const shipmentCo2 = planCo2 > 0 ? planCo2 : (legStats?.co2eKg ?? 0);

    const planCost = toPositiveNumber(plan.estimated_cost_minor);
    const legCost = legStats?.costMinor ?? 0;
    const quoteCost = quoteStats?.selected ?? quoteStats?.lowest ?? 0;
    const shipmentCost =
      planCost > 0 ? planCost : legCost > 0 ? legCost : quoteCost;

    bucket.shipments += 1;
    bucket.emissionsKg += shipmentCo2;
    bucket.totalCostMinor += shipmentCost;
  }

  return buckets.map((b) => {
    const roundedEmissions = Math.round(b.emissionsKg * 10) / 10;
    const roundedTotalCost = Math.round(b.totalCostMinor);
    const costPerShipmentMinor =
      b.shipments > 0 ? Math.round(roundedTotalCost / b.shipments) : 0;

    return {
      dateIso: b.dateIso,
      label: b.label,
      weekday: b.weekday,
      shipments: b.shipments,
      emissionsKg: roundedEmissions,
      totalCostMinor: roundedTotalCost,
      costPerShipmentMinor,
    };
  });
}

export function summarizeSevenDayPerformance(series: DailyPerformancePoint[]): {
  totalShipments: number;
  totalEmissionsKg: number;
  totalCostMinor: number;
  avgCostPerShipmentMinor: number;
  avgEmissionsPerShipmentKg: number;
  hasAnyData: boolean;
} {
  const totalShipments = series.reduce((sum, d) => sum + d.shipments, 0);
  const totalEmissionsKg =
    Math.round(series.reduce((sum, d) => sum + d.emissionsKg, 0) * 10) / 10;
  const totalCostMinor = Math.round(
    series.reduce((sum, d) => sum + d.totalCostMinor, 0),
  );
  const avgCostPerShipmentMinor =
    totalShipments > 0 ? Math.round(totalCostMinor / totalShipments) : 0;
  const avgEmissionsPerShipmentKg =
    totalShipments > 0
      ? Math.round((totalEmissionsKg / totalShipments) * 10) / 10
      : 0;

  return {
    totalShipments,
    totalEmissionsKg,
    totalCostMinor,
    avgCostPerShipmentMinor,
    avgEmissionsPerShipmentKg,
    hasAnyData:
      totalShipments > 0 || totalEmissionsKg > 0 || totalCostMinor > 0,
  };
}
