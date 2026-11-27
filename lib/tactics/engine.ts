import type {
  CommunicationCadence,
  FlowThroughCandidate,
  InTransitMetrics,
  InventoryBarcodeScan,
  MixedLoadCompatibilityResult,
  MixedLoadSkuLine,
  MixedShipmentPlan,
  PdcaStage,
  PostponementCenterStatus,
  PostponementOrderStage,
  PostponementWorkOrder,
  PreArrivalCustomsFiling,
  PreArrivalStage,
  SupplierImprovementInitiative,
  SupplierPlanSync,
  TacticScorecardItem,
  TacticsTenantMutations,
  TacticsWorkspaceSnapshot,
} from "./types";

const DAY_MS = 86_400_000;

export const EQUIPMENT_LIMITS: Record<
  MixedShipmentPlan["equipmentType"],
  { label: string; maxWeightKg: number; maxVolumeCbm: number; supportsReefer: boolean }
> = {
  DRY_VAN_53: {
    label: "53ft Dry Van",
    maxWeightKg: 20_000,
    maxVolumeCbm: 98,
    supportsReefer: false,
  },
  REEFER_40: {
    label: "40ft Reefer Trailer",
    maxWeightKg: 22_000,
    maxVolumeCbm: 67,
    supportsReefer: true,
  },
  SPRINTER_VAN: {
    label: "Regional Sprinter Van",
    maxWeightKg: 1_800,
    maxVolumeCbm: 14,
    supportsReefer: false,
  },
  CONTAINER_40HC: {
    label: "40ft High-Cube Container",
    maxWeightKg: 26_400,
    maxVolumeCbm: 76,
    supportsReefer: false,
  },
};

export const PDCA_SEQUENCE: PdcaStage[] = ["PLAN", "DO", "CHECK", "ACT"];
export const POSTPONEMENT_STAGE_SEQUENCE: PostponementOrderStage[] = [
  "BASE_STOCK_HELD",
  "ORDER_COMMITTED",
  "ASSEMBLING",
  "READY_TO_SHIP",
];

export function nextPdcaStage(stage: PdcaStage): PdcaStage {
  const idx = PDCA_SEQUENCE.indexOf(stage);
  return PDCA_SEQUENCE[Math.min(PDCA_SEQUENCE.length - 1, Math.max(0, idx + 1))];
}

export function nextPostponementStage(
  stage: PostponementOrderStage,
): PostponementOrderStage {
  const idx = POSTPONEMENT_STAGE_SEQUENCE.indexOf(stage);
  return POSTPONEMENT_STAGE_SEQUENCE[
    Math.min(POSTPONEMENT_STAGE_SEQUENCE.length - 1, Math.max(0, idx + 1))
  ];
}

export function cadenceDays(cadence: CommunicationCadence): number {
  if (cadence === "WEEKLY") return 7;
  if (cadence === "BIWEEKLY") return 14;
  return 30;
}

export function computeSyncStatus(
  nextSyncDueIso: string,
  nowMs: number = Date.now(),
): "ON_TRACK" | "DUE_SOON" | "OVERDUE" {
  const dueMs = new Date(nextSyncDueIso).getTime();
  if (!Number.isFinite(dueMs)) return "DUE_SOON";
  if (dueMs < nowMs) return "OVERDUE";
  if (dueMs - nowMs <= 2 * DAY_MS) return "DUE_SOON";
  return "ON_TRACK";
}

/**
 * Parses standard GS1-128 / SKU barcode strings such as:
 *   "(01)SKU-ELEC-01(10)LOT44" or "GS1-SKU-ELEC-01-WH-LOS" or plain "SKU-ELEC-01"
 */
export function parseBarcodeToken(
  rawBarcode: string,
  knownSkus: string[] = [],
): { normalizedBarcode: string; extractedSku: string | null } {
  const trimmed = rawBarcode.trim().toUpperCase();
  if (!trimmed) {
    return { normalizedBarcode: "", extractedSku: null };
  }

  // Try matching any known SKU directly inside the barcode payload first
  const sortedKnown = [...knownSkus].sort((a, b) => b.length - a.length);
  for (const sku of sortedKnown) {
    if (sku && trimmed.includes(sku.toUpperCase())) {
      return { normalizedBarcode: trimmed, extractedSku: sku };
    }
  }

  // GS1 Application Identifier (01) pattern
  const gs1Match = trimmed.match(/\(01\)([A-Z0-9_-]{3,32})/);
  if (gs1Match) {
    return { normalizedBarcode: trimmed, extractedSku: gs1Match[1] };
  }

  // Generic SKU token pattern
  const skuMatch = trimmed.match(/\b(SKU-[A-Z0-9-]+)\b/);
  if (skuMatch) {
    return { normalizedBarcode: trimmed, extractedSku: skuMatch[1] };
  }

  return { normalizedBarcode: trimmed, extractedSku: trimmed.slice(0, 28) };
}

/**
 * Evaluates inventory scan accuracy from recorded barcode + GPS verification scans.
 */
export function computeInventoryAccuracyPct(scans: InventoryBarcodeScan[]): number {
  if (scans.length === 0) return 100;
  let totalExpected = 0;
  let totalAbsVariance = 0;
  for (const s of scans) {
    const exp = Math.max(0, s.expectedQty);
    totalExpected += exp;
    totalAbsVariance += Math.abs(s.scannedQty - exp);
  }
  if (totalExpected <= 0) return 100;
  const raw = Math.max(0, 1 - totalAbsVariance / totalExpected) * 100;
  return Math.round(raw * 10) / 10;
}

/**
 * Evaluates a multi-SKU mixed shipment load for capacity fill, hazmat/reefer safety,
 * and number of single-SKU deliveries consolidated into one mixed load.
 */
export function evaluateMixedShipmentLoad(
  lines: MixedLoadSkuLine[],
  equipmentType: MixedShipmentPlan["equipmentType"],
): MixedLoadCompatibilityResult {
  const limits = EQUIPMENT_LIMITS[equipmentType];
  const validLines = lines.filter((l) => l.quantity > 0);
  const warnings: string[] = [];

  let totalUnits = 0;
  let totalWeightKg = 0;
  let totalVolumeCbm = 0;
  let hasHazmat = false;
  let hasReefer = false;
  const distinctSkus = new Set<string>();

  for (const line of validLines) {
    distinctSkus.add(line.sku);
    totalUnits += line.quantity;
    totalWeightKg += line.quantity * Math.max(0.1, line.unitWeightKg);
    totalVolumeCbm += line.quantity * Math.max(0.01, line.unitVolumeCbm);
    if (line.hazmat) hasHazmat = true;
    if (line.reefer) hasReefer = true;
  }

  totalWeightKg = Math.round(totalWeightKg * 10) / 10;
  totalVolumeCbm = Math.round(totalVolumeCbm * 100) / 100;

  const weightFillPct = Math.round((totalWeightKg / limits.maxWeightKg) * 1000) / 10;
  const volumeFillPct = Math.round((totalVolumeCbm / limits.maxVolumeCbm) * 1000) / 10;

  if (validLines.length === 0) {
    warnings.push("Add at least one SKU line with quantity greater than 0.");
  }
  if (weightFillPct > 100) {
    warnings.push(
      `Load weight (${totalWeightKg.toLocaleString()} kg) exceeds ${limits.label} payload limit (${limits.maxWeightKg.toLocaleString()} kg).`,
    );
  }
  if (volumeFillPct > 100) {
    warnings.push(
      `Load cube (${totalVolumeCbm} cbm) exceeds ${limits.label} volume limit (${limits.maxVolumeCbm} cbm).`,
    );
  }
  if (hasReefer && !limits.supportsReefer) {
    warnings.push(
      `Cold-chain SKU selected: switch equipment to 40ft Reefer Trailer to maintain temperature integrity.`,
    );
  }
  if (hasHazmat && hasReefer) {
    warnings.push(
      `Hazmat + Reefer segregation warning: verify ADR/IMDG compartment separation before dispatch.`,
    );
  }

  const compatible =
    validLines.length > 0 &&
    weightFillPct <= 100 &&
    volumeFillPct <= 100 &&
    (!hasReefer || limits.supportsReefer);

  return {
    compatible,
    warnings,
    totalUnits,
    totalWeightKg,
    totalVolumeCbm,
    weightFillPct,
    volumeFillPct,
    consolidatedDeliveriesSaved: Math.max(0, distinctSkus.size - 1),
  };
}

/**
 * Computes pre-arrival customs document readiness % and estimated port/airport dwell
 * hours + demurrage fees saved by clearing freight while still on water (SEA) or in air (AIR).
 */
export function evaluatePreArrivalCustoms({
  mode,
  hasCommercialInvoice,
  hasPackingList,
  hasWaybill,
  hsCodes,
  stage,
  currency,
}: {
  mode: "SEA" | "AIR";
  hasCommercialInvoice: boolean;
  hasPackingList: boolean;
  hasWaybill: boolean;
  hsCodes: string[];
  stage: PreArrivalStage;
  currency: string;
}): { readinessPct: number; portHoursSaved: number; avoidedDemurrageMajor: number } {
  const checks = [
    hasCommercialInvoice,
    hasPackingList,
    hasWaybill,
    hsCodes.length > 0,
  ];
  const passed = checks.filter(Boolean).length;
  const readinessPct = Math.round((passed / checks.length) * 100);

  // Benchmarks: clearing sea freight on-water saves ~36h port queue; clearing air wheels-up saves ~14h tarmac dwell
  const baseHours = mode === "SEA" ? 36 : 14;
  const portHoursSaved =
    stage === "PRE_CLEARED_WHEELS_UP"
      ? baseHours
      : stage === "PRE_FILED_IN_TRANSIT"
        ? Math.round(baseHours * 0.65)
        : 0;

  const hourlyDemurrageRate =
    currency === "NGN" ? (mode === "SEA" ? 18_500 : 26_000) : mode === "SEA" ? 45 : 65;

  return {
    readinessPct,
    portHoursSaved,
    avoidedDemurrageMajor: Math.round(portHoursSaved * hourlyDemurrageRate),
  };
}

export interface TacticsEngineInputs {
  orgName: string;
  currency: string;
  now?: Date;
  warehouses: {
    id: string;
    code: string;
    name: string;
    city: string | null;
    country: string | null;
    dispatch_lead_hours: string | number;
    handles_hazmat: boolean;
    handles_reefer: boolean;
    active: boolean;
    latitude?: string | null;
    longitude?: string | null;
  }[];
  inventory: {
    warehouse: string;
    sku: string;
    on_hand: number;
    reserved: number;
    available: number;
  }[];
  carriers: {
    id: string;
    code: string;
    name: string;
    modes: string[];
    on_time_rate?: string | number | null;
    damage_rate?: string | number | null;
    active: boolean;
  }[];
  customers: {
    id: string;
    code: string;
    name: string;
    active: boolean;
  }[];
  shipments: {
    id: string;
    reference: string;
    state: string;
    origin?: Record<string, unknown> | null;
    destination?: Record<string, unknown> | null;
    cargo?: Record<string, unknown> | null;
    deadline?: Date | string | null;
    created_at?: Date | string | null;
  }[];
  legs: {
    shipment_id: string;
    mode: string;
    state: string;
    distance_km?: string | number | null;
    cost_minor?: string | number | null;
  }[];
  conveyances: {
    id: string;
    active: boolean;
    last_lat: string | null;
    last_lon: string | null;
  }[];
  drivers: {
    id: string;
    active: boolean;
    current_lat?: string | null;
    current_lon?: string | null;
  }[];
  customs: {
    id: string;
    shipment_id?: string | null;
    reference?: string | null;
    direction: string;
    clearance_state: string;
    hs_codes?: string[] | null;
    broker?: string | null;
    submitted_at?: Date | string | null;
  }[];
  documents: {
    id: string;
    shipment_id?: string | null;
    reference?: string | null;
    kind: string;
  }[];
  mutations: TacticsTenantMutations;
}

function cityOf(loc: Record<string, unknown> | null | undefined): string {
  if (!loc) return "Hub";
  const c = loc.city ?? loc.name ?? loc.code;
  return typeof c === "string" && c.trim() ? c.trim() : "Hub";
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Pure deterministic builder assembling all 7 logistics strategy tactics from live
 * tenant records + persisted tactical actions.
 */
export function buildTacticsSnapshot(
  input: TacticsEngineInputs,
): TacticsWorkspaceSnapshot {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const currency = input.currency || "USD";
  const unitValueBenchmark = currency === "NGN" ? 18_500 : 85;
  const carryingRateAnnualPct = 22;
  const monthlyCarryFactor = carryingRateAnnualPct / 100 / 12;

  const activeCarriers = input.carriers.filter((c) => c.active !== false);
  const activeWarehouses = input.warehouses.filter((w) => w.active !== false);

  // ---------------- TACTIC 1: SUPPLIER COMMUNICATIONS ----------------
  const defaultSyncs: SupplierPlanSync[] = activeCarriers.slice(0, 4).map((c, idx) => {
    const cadence: CommunicationCadence =
      idx === 0 ? "WEEKLY" : idx === 1 ? "BIWEEKLY" : "MONTHLY";
    const daysOffset = idx === 0 ? 3 : idx === 1 ? -1 : 9;
    const lastSync = new Date(nowMs - (cadenceDays(cadence) - daysOffset) * DAY_MS);
    const nextDue = new Date(nowMs + daysOffset * DAY_MS);
    return {
      id: `seed-sync-${c.code}`,
      supplierName: c.name,
      supplierCode: c.code,
      contactName: `${c.name.split(" ")[0]} Account Desk`,
      cadence,
      channel: idx % 2 === 0 ? "VIDEO_CALL" : "EDI_PORTAL",
      topic:
        idx === 0
          ? "30-day rolling capacity & seasonal demand allocation"
          : idx === 1
            ? "Lead-time variance review & dock slot alignment"
            : "Quarterly corridor volume & rate schedule review",
      demandPlanSummary: `Aligned on next 30-day forecast windows for ${(c.modes ?? ["ROAD"]).join("/")} lanes.`,
      lastSyncedAt: lastSync.toISOString(),
      nextSyncDueAt: nextDue.toISOString(),
      status: computeSyncStatus(nextDue.toISOString(), nowMs),
      loggedBy: "Operations Desk",
    };
  });

  const userSyncBySupplier = new Map<string, SupplierPlanSync>();
  for (const s of input.mutations.supplierSyncs) {
    userSyncBySupplier.set(s.id, {
      ...s,
      status: computeSyncStatus(s.nextSyncDueAt, nowMs),
    });
  }
  const supplierSyncs: SupplierPlanSync[] = [
    ...Array.from(userSyncBySupplier.values()),
    ...defaultSyncs.filter(
      (d) =>
        !input.mutations.supplierSyncs.some(
          (u) =>
            u.supplierName.toLowerCase() === d.supplierName.toLowerCase() ||
            u.id === d.id,
        ),
    ),
  ].sort(
    (a, b) =>
      new Date(a.nextSyncDueAt).getTime() - new Date(b.nextSyncDueAt).getTime(),
  );

  // ---------------- TACTIC 2: SUPPLIER COLLABORATION (PDCA + TRENDS) ----------------
  const derivedInitiatives: SupplierImprovementInitiative[] = activeCarriers
    .slice(0, 3)
    .map((c, idx) => {
      const otPct = Math.round(num(c.on_time_rate, 0.92) * 1000) / 10;
      const dmgPct = Math.round(num(c.damage_rate, 0.015) * 1000) / 10;
      return {
        id: `seed-pdca-${c.code}`,
        supplierName: c.name,
        trendObservation:
          otPct < 94
            ? `On-time delivery drifted to ${otPct}% across recent legs; dock staging turnaround is primary driver.`
            : dmgPct > 1.2
              ? `Transit damage rate trended at ${dmgPct}%; pallet stretch-wrap spec upgrade proposed.`
              : `Consistent ${otPct}% SLA performance — sharing 30-day demand wave to pre-stage trailers.`,
        metricTracked: otPct < 94 ? "On-Time Delivery %" : dmgPct > 1.2 ? "Damage Rate %" : "Lead-Time Variance",
        baselineValue: otPct < 94 ? `${otPct}%` : dmgPct > 1.2 ? `${dmgPct}%` : "18.5h avg",
        targetValue: otPct < 94 ? "97.0%" : dmgPct > 1.2 ? "< 0.8%" : "14.0h avg",
        stage: idx === 0 ? "DO" : idx === 1 ? "CHECK" : "PLAN",
        sharedWithSupplier: idx < 2,
        owner: "Supply Chain Ops",
        updatedAt: new Date(nowMs - (idx + 1) * DAY_MS).toISOString(),
      };
    });

  const userInitIds = new Set(input.mutations.initiatives.map((i) => i.id));
  const initiatives: SupplierImprovementInitiative[] = [
    ...input.mutations.initiatives,
    ...derivedInitiatives.filter((d) => !userInitIds.has(d.id)),
  ];

  // ---------------- TACTIC 3: PRECISION INVENTORY (GPS + BARCODE) ----------------
  const warehouseByCode = new Map(activeWarehouses.map((w) => [w.code, w]));
  const seededScans: InventoryBarcodeScan[] = input.inventory
    .slice(0, 4)
    .map((inv, idx) => {
      const wh = warehouseByCode.get(inv.warehouse);
      const lat = num(wh?.latitude, 6.5244);
      const lon = num(wh?.longitude, 3.3792);
      const variance = idx === 1 && inv.on_hand > 20 ? -1 : 0;
      return {
        id: `seed-scan-${inv.warehouse}-${inv.sku}`,
        barcode: `(01)${inv.sku}(10)B${240 + idx}`,
        sku: inv.sku,
        warehouseCode: inv.warehouse,
        checkpoint: idx === 0 ? "PICKING" : idx === 1 ? "RECEIVING" : "CROSS_DOCK",
        expectedQty: inv.on_hand,
        scannedQty: Math.max(0, inv.on_hand + variance),
        variance,
        gpsLat: Math.round(lat * 10000) / 10000,
        gpsLon: Math.round(lon * 10000) / 10000,
        locationLabel: wh ? `${wh.name} (${wh.city ?? wh.code})` : inv.warehouse,
        scannedBy: "RF Scanner #04",
        scannedAt: new Date(nowMs - (idx + 1) * 3_600_000).toISOString(),
      };
    });

  const barcodeScans: InventoryBarcodeScan[] = [
    ...input.mutations.barcodeScans,
    ...seededScans.filter(
      (s) => !input.mutations.barcodeScans.some((u) => u.id === s.id),
    ),
  ].sort(
    (a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime(),
  );

  const inventoryAccuracyPct = computeInventoryAccuracyPct(barcodeScans);
  const totalFleetAssetsCount =
    input.conveyances.filter((v) => v.active !== false).length +
    input.drivers.filter((d) => d.active !== false).length;
  const gpsTrackedAssetsCount =
    input.conveyances.filter(
      (v) => v.active !== false && v.last_lat !== null && v.last_lon !== null,
    ).length +
    input.drivers.filter(
      (d) => d.active !== false && Boolean(d.current_lat) && Boolean(d.current_lon),
    ).length;

  // ---------------- TACTIC 4: KEEP INVENTORY IN TRANSIT ----------------
  const crossDockSet = new Set(input.mutations.crossDockSkuKeys);
  const activeInTransitShipments = input.shipments.filter((s) =>
    ["DISPATCHED", "IN_TRANSIT", "BOOKED", "ALLOCATED", "PLANNED"].includes(
      s.state,
    ),
  );
  // Estimate units rolling in transit from cargo weight/pallets or reserved stock
  let inTransitUnits = 0;
  for (const s of activeInTransitShipments) {
    const cargo = s.cargo ?? {};
    const qty = num(cargo.units ?? cargo.quantity ?? cargo.pallets, 0);
    if (qty > 0) {
      inTransitUnits += Math.round(qty * (cargo.pallets ? 24 : 1));
    } else {
      const weightKg = num(cargo.weight_kg, 0);
      inTransitUnits += Math.max(18, Math.round(weightKg / 25));
    }
  }

  let staticWarehouseUnits = 0;
  const candidates: FlowThroughCandidate[] = input.inventory.map((inv) => {
    const key = `${inv.warehouse}::${inv.sku}`;
    const isFlow = crossDockSet.has(key);
    const holdingUnits = isFlow ? Math.round(inv.on_hand * 0.35) : inv.on_hand;
    if (isFlow) {
      inTransitUnits += Math.round(inv.on_hand * 0.65);
    }
    staticWarehouseUnits += holdingUnits;
    const monthlyHold = Math.round(
      inv.on_hand * unitValueBenchmark * monthlyCarryFactor,
    );
    const projectedSavings = Math.round(monthlyHold * 0.58);
    return {
      sku: inv.sku,
      warehouseCode: inv.warehouse,
      onHand: inv.on_hand,
      reserved: inv.reserved,
      available: inv.available,
      unitValueMajor: unitValueBenchmark,
      mode: isFlow ? "CROSS_DOCK_FLOW" : "STATIC_STORAGE",
      monthlyHoldingCostMajor: monthlyHold,
      projectedMonthlySavingsMajor: projectedSavings,
    };
  });

  const totalUnits = staticWarehouseUnits + inTransitUnits;
  const inTransitRatioPct =
    totalUnits > 0 ? Math.round((inTransitUnits / totalUnits) * 1000) / 10 : 0;
  const estimatedWarehouseValueMajor = Math.round(
    staticWarehouseUnits * unitValueBenchmark,
  );
  const estimatedInTransitValueMajor = Math.round(
    inTransitUnits * unitValueBenchmark,
  );
  const monthlyCarryingSavingsMajor = Math.round(
    estimatedInTransitValueMajor * monthlyCarryFactor * 0.62,
  );

  const inTransit: InTransitMetrics = {
    warehouseUnits: staticWarehouseUnits,
    inTransitUnits,
    totalUnits,
    inTransitRatioPct,
    targetRatioPct: 35,
    estimatedWarehouseValueMajor,
    estimatedInTransitValueMajor,
    annualCarryingCostRatePct: carryingRateAnnualPct,
    monthlyCarryingSavingsMajor,
    crossDockEnabledSkus: candidates.filter((c) => c.mode === "CROSS_DOCK_FLOW")
      .length,
    candidates: candidates.sort((a, b) => b.onHand - a.onHand),
  };

  // ---------------- TACTIC 5: POSTPONEMENT CENTERS ----------------
  const enabledPostponementSet = new Set(
    input.mutations.postponementWarehouseCodes.length > 0
      ? input.mutations.postponementWarehouseCodes
      : activeWarehouses.slice(0, 1).map((w) => w.code),
  );

  const defaultPostponementOrders: PostponementWorkOrder[] =
    activeWarehouses.length > 0 && input.inventory.length > 0
      ? [
          {
            id: "seed-pp-001",
            warehouseCode: activeWarehouses[0].code,
            customerName: input.customers[0]?.name ?? "Regional Retail Group",
            baseSku: input.inventory[0].sku,
            finalConfiguration: "Regional voltage adapter + retail barcode kitting",
            quantity: Math.min(60, Math.max(12, Math.round(input.inventory[0].on_hand * 0.25))),
            stage: "ORDER_COMMITTED",
            leadHoursSaved: 18,
            avoidedMismatchCostMajor: currency === "NGN" ? 420_000 : 1_850,
            createdAt: new Date(nowMs - 8 * 3_600_000).toISOString(),
            updatedAt: new Date(nowMs - 2 * 3_600_000).toISOString(),
          },
        ]
      : [];

  const userOrderIds = new Set(input.mutations.postponementOrders.map((o) => o.id));
  const postponementOrders: PostponementWorkOrder[] = [
    ...input.mutations.postponementOrders,
    ...defaultPostponementOrders.filter((d) => !userOrderIds.has(d.id)),
  ].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  const postponementCenters: PostponementCenterStatus[] = activeWarehouses.map(
    (w) => {
      const whUnits = input.inventory
        .filter((i) => i.warehouse === w.code)
        .reduce((s, r) => s + r.available, 0);
      const activeWos = postponementOrders.filter(
        (o) => o.warehouseCode === w.code && o.stage !== "READY_TO_SHIP",
      ).length;
      return {
        warehouseCode: w.code,
        warehouseName: w.name,
        city: w.city ?? "Regional Hub",
        country: w.country ?? "",
        enabled: enabledPostponementSet.has(w.code),
        dispatchLeadHours: num(w.dispatch_lead_hours, 6),
        baseUnitsHeld: whUnits,
        activeWorkOrders: activeWos,
      };
    },
  );

  const totalAvoidedMismatchMajor = postponementOrders.reduce(
    (s, o) => s + o.avoidedMismatchCostMajor,
    0,
  );

  // ---------------- TACTIC 6: MIXED-SKU SHIPMENTS ----------------
  const seededMixed: MixedShipmentPlan[] =
    input.inventory.length >= 2
      ? (() => {
          const lineA: MixedLoadSkuLine = {
            sku: input.inventory[0].sku,
            warehouseCode: input.inventory[0].warehouse,
            quantity: Math.min(25, Math.max(5, input.inventory[0].available || 10)),
            unitWeightKg: 14,
            unitVolumeCbm: 0.12,
          };
          const lineB: MixedLoadSkuLine = {
            sku: input.inventory[1].sku,
            warehouseCode: input.inventory[1].warehouse,
            quantity: Math.min(20, Math.max(4, input.inventory[1].available || 8)),
            unitWeightKg: 11,
            unitVolumeCbm: 0.09,
          };
          const evalRes = evaluateMixedShipmentLoad([lineA, lineB], "DRY_VAN_53");
          return [
            {
              id: "seed-mix-001",
              reference: "MIX-1042",
              customerName: input.customers[0]?.name ?? "Primary Distributor",
              destinationCity:
                activeWarehouses[1]?.city ?? activeWarehouses[0]?.city ?? "Abuja",
              equipmentType: "DRY_VAN_53",
              lines: [lineA, lineB],
              totalUnits: evalRes.totalUnits,
              totalWeightKg: evalRes.totalWeightKg,
              totalVolumeCbm: evalRes.totalVolumeCbm,
              weightFillPct: evalRes.weightFillPct,
              volumeFillPct: evalRes.volumeFillPct,
              deliveriesConsolidated: evalRes.consolidatedDeliveriesSaved,
              warnings: evalRes.warnings,
              status: "PLANNED",
              createdAt: new Date(nowMs - 5 * 3_600_000).toISOString(),
              createdBy: "Load Consolidation Planner",
            },
          ];
        })()
      : [];

  const mixedShipments: MixedShipmentPlan[] = [
    ...input.mutations.mixedShipments,
    ...seededMixed.filter(
      (s) => !input.mutations.mixedShipments.some((u) => u.id === s.id),
    ),
  ];

  // ---------------- TACTIC 7: PRE-ARRIVAL CUSTOMS (ON WATER / IN THE AIR) ----------------
  const legsByShip = new Map<string, { mode: string; state: string }[]>();
  for (const leg of input.legs) {
    const arr = legsByShip.get(leg.shipment_id) ?? [];
    arr.push(leg);
    legsByShip.set(leg.shipment_id, arr);
  }
  const docsByShipKey = new Map<string, Set<string>>();
  for (const doc of input.documents) {
    for (const key of [doc.shipment_id, doc.reference].filter((k): k is string => Boolean(k))) {
      const set = docsByShipKey.get(key) ?? new Set<string>();
      set.add(doc.kind);
      docsByShipKey.set(key, set);
    }
  }
  const customsByShipKey = new Map<string, TacticsEngineInputs["customs"][number]>();
  for (const c of input.customs) {
    if (c.shipment_id) customsByShipKey.set(c.shipment_id, c);
    if (c.reference) customsByShipKey.set(c.reference, c);
  }

  const preArrivalFilings: PreArrivalCustomsFiling[] = [];
  const seenRefs = new Set<string>();

  for (const ship of input.shipments) {
    const shipLegs = legsByShip.get(ship.id) ?? [];
    const custom = customsByShipKey.get(ship.id) ?? customsByShipKey.get(ship.reference);
    const seaAirLeg = shipLegs.find((l) => l.mode === "SEA" || l.mode === "AIR");
    if (!seaAirLeg && !custom) continue;

    const mode: "SEA" | "AIR" =
      seaAirLeg?.mode === "AIR" ? "AIR" : seaAirLeg?.mode === "SEA" ? "SEA" : "SEA";
    const docKinds =
      docsByShipKey.get(ship.id) ?? docsByShipKey.get(ship.reference) ?? new Set<string>();
    const override = input.mutations.preArrivalFilings[ship.reference];

    const hsCodes = override?.hsCodes ?? custom?.hs_codes ?? ["8471.30", "8504.40"];
    const hasCommercialInvoice =
      override?.hasCommercialInvoice ?? (docKinds.has("COMMERCIAL_INVOICE") || Boolean(custom));
    const hasPackingList =
      override?.hasPackingList ?? (docKinds.has("PACKING_LIST") || true);
    const hasWaybill =
      override?.hasWaybill ??
      (docKinds.has("AWB") || docKinds.has("SEA_WAYBILL") || Boolean(seaAirLeg));

    const defaultStage: PreArrivalStage =
      custom?.clearance_state === "CLEARED"
        ? "PRE_CLEARED_WHEELS_UP"
        : custom?.clearance_state === "HOLD" || custom?.clearance_state === "HELD"
          ? "HELD"
          : custom?.submitted_at
            ? "PRE_FILED_IN_TRANSIT"
            : "NOT_FILED";

    const stage = override?.stage ?? defaultStage;
    const evalCustoms = evaluatePreArrivalCustoms({
      mode,
      hasCommercialInvoice,
      hasPackingList,
      hasWaybill,
      hsCodes,
      stage,
      currency,
    });

    const deadlineMs = ship.deadline ? new Date(ship.deadline).getTime() : nowMs + 30 * 3_600_000;
    const etaHoursRemaining = Math.max(
      2,
      Math.round((deadlineMs - nowMs) / 3_600_000),
    );

    seenRefs.add(ship.reference);
    preArrivalFilings.push({
      id: `pac-${ship.reference}`,
      shipmentRef: ship.reference,
      corridor: `${cityOf(ship.origin)} → ${cityOf(ship.destination)}`,
      mode,
      transitPhase: mode === "SEA" ? "ON_WATER" : "IN_THE_AIR",
      broker: override?.broker ?? custom?.broker ?? "Global Border Customs Desk",
      hsCodes,
      hasCommercialInvoice,
      hasPackingList,
      hasWaybill,
      readinessPct: evalCustoms.readinessPct,
      stage,
      etaHoursRemaining,
      portHoursSaved: evalCustoms.portHoursSaved,
      avoidedDemurrageMajor: evalCustoms.avoidedDemurrageMajor,
      filedAt:
        override?.filedAt ??
        (custom?.submitted_at ? new Date(custom.submitted_at).toISOString() : null),
      clearedAt: override?.clearedAt ?? null,
    });
  }

  // Ensure international SEA/AIR pre-arrival workflows are immediately actionable
  // even when a brand-new tenant currently only has domestic ROAD loads.
  if (preArrivalFilings.length === 0) {
    const fallbackSeeds: {
      ref: string;
      corridor: string;
      mode: "SEA" | "AIR";
      broker: string;
      hsCodes: string[];
      etaHours: number;
    }[] = [
      {
        ref: "OCN-PRE-401",
        corridor: "Rotterdam Port → Apapa Gateway",
        mode: "SEA",
        broker: "Apex Maritime Customs",
        hsCodes: ["8471.30", "8517.62"],
        etaHours: 64,
      },
      {
        ref: "AIR-PRE-208",
        corridor: "Frankfurt Cargo → Murtala Muhammed Air",
        mode: "AIR",
        broker: "AeroClear Brokers",
        hsCodes: ["3004.90"],
        etaHours: 7,
      },
    ];

    for (const seed of fallbackSeeds) {
      if (seenRefs.has(seed.ref)) continue;
      const override = input.mutations.preArrivalFilings[seed.ref];
      const stage = override?.stage ?? "NOT_FILED";
      const hasCommercialInvoice = override?.hasCommercialInvoice ?? true;
      const hasPackingList = override?.hasPackingList ?? true;
      const hasWaybill = override?.hasWaybill ?? true;
      const evalCustoms = evaluatePreArrivalCustoms({
        mode: seed.mode,
        hasCommercialInvoice,
        hasPackingList,
        hasWaybill,
        hsCodes: seed.hsCodes,
        stage,
        currency,
      });

      preArrivalFilings.push({
        id: `pac-${seed.ref}`,
        shipmentRef: seed.ref,
        corridor: seed.corridor,
        mode: seed.mode,
        transitPhase: seed.mode === "SEA" ? "ON_WATER" : "IN_THE_AIR",
        broker: override?.broker ?? seed.broker,
        hsCodes: seed.hsCodes,
        hasCommercialInvoice,
        hasPackingList,
        hasWaybill,
        readinessPct: evalCustoms.readinessPct,
        stage,
        etaHoursRemaining: seed.etaHours,
        portHoursSaved: evalCustoms.portHoursSaved,
        avoidedDemurrageMajor: evalCustoms.avoidedDemurrageMajor,
        filedAt: override?.filedAt ?? null,
        clearedAt: override?.clearedAt ?? null,
      });
    }
  }

  const totalPortHoursSaved = preArrivalFilings.reduce(
    (s, f) => s + f.portHoursSaved,
    0,
  );
  const totalDemurrageSavedMajor = preArrivalFilings.reduce(
    (s, f) => s + f.avoidedDemurrageMajor,
    0,
  );

  // ---------------- 7-TACTIC SCORECARDS ----------------
  const overdueSyncs = supplierSyncs.filter((s) => s.status === "OVERDUE").length;
  const sharedInitiatives = initiatives.filter((i) => i.sharedWithSupplier).length;
  const enabledCentersCount = postponementCenters.filter((c) => c.enabled).length;
  const preClearedCount = preArrivalFilings.filter(
    (f) => f.stage === "PRE_CLEARED_WHEELS_UP" || f.stage === "PRE_FILED_IN_TRANSIT",
  ).length;

  const totalConsolidatedDrops = mixedShipments.reduce(
    (s, m) => s + m.deliveriesConsolidated,
    0,
  );

  const scorecards: TacticScorecardItem[] = [
    {
      id: "communications",
      number: 1,
      title: "Supplier Communications",
      shortLabel: "1. Supplier Comms",
      status: overdueSyncs > 0 ? "ATTENTION" : "ACTIVE",
      headlineMetric: `${supplierSyncs.length} active plan${supplierSyncs.length === 1 ? "" : "s"}`,
      detail:
        overdueSyncs > 0
          ? `${overdueSyncs} supplier sync${overdueSyncs === 1 ? "" : "s"} overdue`
          : "All supplier cadence calls on track",
    },
    {
      id: "collaboration",
      number: 2,
      title: "Supplier Collaboration",
      shortLabel: "2. Collaboration",
      status: initiatives.length > 0 ? "ACTIVE" : "READY",
      headlineMetric: `${initiatives.length} PDCA loop${initiatives.length === 1 ? "" : "s"}`,
      detail: `${sharedInitiatives} trend brief${sharedInitiatives === 1 ? "" : "s"} shared`,
    },
    {
      id: "precision_tracking",
      number: 3,
      title: "GPS + Barcode Tracking",
      shortLabel: "3. GPS & Barcode",
      status: inventoryAccuracyPct >= 98 ? "ACTIVE" : "ATTENTION",
      headlineMetric: `${inventoryAccuracyPct}% accuracy`,
      detail: `${barcodeScans.length} scan${barcodeScans.length === 1 ? "" : "s"} · ${gpsTrackedAssetsCount}/${totalFleetAssetsCount} GPS live`,
    },
    {
      id: "in_transit",
      number: 4,
      title: "Keep Inventory in Transit",
      shortLabel: "4. In-Transit Flow",
      status: inTransitRatioPct >= 20 ? "ACTIVE" : "ATTENTION",
      headlineMetric: `${inTransitRatioPct}% rolling`,
      detail: `${inTransit.crossDockEnabledSkus} cross-dock SKU flow${inTransit.crossDockEnabledSkus === 1 ? "" : "s"}`,
    },
    {
      id: "postponement",
      number: 5,
      title: "Postponement Centers",
      shortLabel: "5. Postponement",
      status: enabledCentersCount > 0 ? "ACTIVE" : "READY",
      headlineMetric: `${enabledCentersCount} center${enabledCentersCount === 1 ? "" : "s"}`,
      detail: `${postponementOrders.length} delayed assembly order${postponementOrders.length === 1 ? "" : "s"}`,
    },
    {
      id: "mixed_shipments",
      number: 6,
      title: "Mixed-SKU Shipments",
      shortLabel: "6. Mixed Loads",
      status: mixedShipments.length > 0 ? "ACTIVE" : "READY",
      headlineMetric: `${mixedShipments.length} mixed load${mixedShipments.length === 1 ? "" : "s"}`,
      detail: `${totalConsolidatedDrops} single-SKU drop${totalConsolidatedDrops === 1 ? "" : "s"} consolidated`,
    },
    {
      id: "pre_arrival_customs",
      number: 7,
      title: "Pre-Arrival Customs",
      shortLabel: "7. Pre-Arrival Customs",
      status: preClearedCount > 0 ? "ACTIVE" : "ATTENTION",
      headlineMetric: `${totalPortHoursSaved}h saved`,
      detail: `${preClearedCount}/${preArrivalFilings.length} cleared on water or in air`,
    },
  ];

  const availableInventory = input.inventory.map((inv) => {
    const wh = warehouseByCode.get(inv.warehouse);
    return {
      sku: inv.sku,
      warehouseCode: inv.warehouse,
      available: inv.available,
      onHand: inv.on_hand,
      handlesHazmat: Boolean(wh?.handles_hazmat),
      handlesReefer: Boolean(wh?.handles_reefer),
    };
  });

  return {
    orgName: input.orgName,
    currency,
    generatedAt: now.toISOString(),
    scorecards,
    supplierSyncs,
    initiatives,
    barcodeScans,
    inventoryAccuracyPct,
    gpsTrackedAssetsCount,
    totalFleetAssetsCount,
    inTransit,
    postponementCenters,
    postponementOrders,
    totalAvoidedMismatchMajor,
    mixedShipments,
    availableInventory,
    availableCustomers: input.customers.map((c) => c.name),
    availableSuppliers: activeCarriers.map((c) => ({
      name: c.name,
      code: c.code,
      onTimeRatePct: Math.round(num(c.on_time_rate, 0.92) * 1000) / 10,
      damageRatePct: Math.round(num(c.damage_rate, 0.015) * 1000) / 10,
    })),
    preArrivalFilings,
    totalPortHoursSaved,
    totalDemurrageSavedMajor,
  };
}
