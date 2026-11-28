/**
 * Pure domain engine for Third-Party Logistics (3PL) multi-client operations
 * and International Freight / Customs workflows.
 *
 * Strictly deterministic and side-effect-free for unit testability.
 * Note: 3PL client segregation always operates inside a single authorized
 * Control Tower tenant workspace (never across separate tenants).
 */

export type BillingModel =
  | "PER_PALLET_MONTH"
  | "PER_ORDER_FULFILLMENT"
  | "HYBRID_STORAGE_PICK"
  | "DEDICATED_CONTRACT";

export interface ThirdPartyClientRecord {
  id: string;
  orgId: string;
  clientCode: string;
  clientName: string;
  contactEmail: string | null;
  slaHours: number;
  billingModel: BillingModel;
  dedicatedWarehouses: string[];
  skuPrefixes: string[];
  monthlyStorageRateUsd: number;
  perOrderPickFeeUsd: number;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThirdPartyClientInput {
  clientCode: string;
  clientName: string;
  contactEmail?: string | null;
  slaHours?: number;
  billingModel?: BillingModel;
  dedicatedWarehouses?: string[];
  skuPrefixes?: string[];
  monthlyStorageRateUsd?: number;
  perOrderPickFeeUsd?: number;
  active?: boolean;
  notes?: string | null;
}

export interface ClientInventoryLine {
  warehouse: string;
  sku: string;
  on_hand: number;
  reserved: number;
  available: number;
}

export interface ClientShipmentMetricInput {
  reference: string;
  state: string;
  customer_ref?: string | null;
  deadline?: Date | string | null;
  updated_at?: Date | string | null;
}

export interface ClientFulfillmentReport {
  clientId: string;
  clientCode: string;
  clientName: string;
  billingModel: BillingModel;
  slaHours: number;
  active: boolean;
  matchedSkuLines: number;
  onHandUnits: number;
  reservedUnits: number;
  availableUnits: number;
  totalShipments: number;
  openShipments: number;
  deliveredShipments: number;
  onTimeRatePct: number;
  estimatedMonthlyRevenueUsd: number;
}

export type FreightDirection = "EXPORT" | "IMPORT" | "CROSS_TRADE";
export type FreightMode = "AIR" | "SEA" | "ROAD" | "RAIL";
export type IncotermCode = "EXW" | "FCA" | "FOB" | "CIF" | "DAP" | "DDP";
export type CustomsClearanceStatus =
  | "PENDING_DOCS"
  | "DOCS_VERIFIED"
  | "SUBMITTED"
  | "CLEARED"
  | "HELD";

export interface InternationalFreightRecord {
  id: string;
  orgId: string;
  shipmentReference: string;
  direction: FreightDirection;
  transportMode: FreightMode;
  incoterm: IncotermCode;
  containerOrWaybill: string;
  originCountry: string;
  destinationCountry: string;
  portOfLoading: string | null;
  portOfDischarge: string | null;
  hsCodes: string[];
  declaredValueUsd: number;
  estimatedDutyUsd: number;
  customsBroker: string | null;
  clearanceStatus: CustomsClearanceStatus;
  commercialInvoiceReady: boolean;
  packingListReady: boolean;
  certificateOfOriginReady: boolean;
  milestoneNote: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InternationalFreightInput {
  shipmentReference: string;
  direction?: FreightDirection;
  transportMode?: FreightMode;
  incoterm?: IncotermCode;
  containerOrWaybill: string;
  originCountry: string;
  destinationCountry: string;
  portOfLoading?: string | null;
  portOfDischarge?: string | null;
  hsCodes: string[] | string;
  declaredValueUsd?: number;
  estimatedDutyUsd?: number;
  customsBroker?: string | null;
  clearanceStatus?: CustomsClearanceStatus;
  commercialInvoiceReady?: boolean;
  packingListReady?: boolean;
  certificateOfOriginReady?: boolean;
  milestoneNote?: string | null;
}

export const ALLOWED_BILLING_MODELS: readonly BillingModel[] = [
  "PER_PALLET_MONTH",
  "PER_ORDER_FULFILLMENT",
  "HYBRID_STORAGE_PICK",
  "DEDICATED_CONTRACT",
] as const;

export const ALLOWED_INCOTERMS: readonly IncotermCode[] = [
  "EXW",
  "FCA",
  "FOB",
  "CIF",
  "DAP",
  "DDP",
] as const;

export const ALLOWED_FREIGHT_MODES: readonly FreightMode[] = [
  "AIR",
  "SEA",
  "ROAD",
  "RAIL",
] as const;

export const ALLOWED_DIRECTIONS: readonly FreightDirection[] = [
  "EXPORT",
  "IMPORT",
  "CROSS_TRADE",
] as const;

export const ALLOWED_CUSTOMS_STATUSES: readonly CustomsClearanceStatus[] = [
  "PENDING_DOCS",
  "DOCS_VERIFIED",
  "SUBMITTED",
  "CLEARED",
  "HELD",
] as const;

const TERMINAL_DELIVERED = new Set(["DELIVERED", "POD_VERIFIED", "CLOSED"]);
const CLOSED_STATES = new Set(["CLOSED", "CANCELLED", "FAILED", "DELIVERED", "POD_VERIFIED"]);

/**
 * Validates and normalizes a 3PL client account payload.
 */
export function validateThirdPartyClientInput(
  raw: ThirdPartyClientInput,
): { ok: true; value: Required<Omit<ThirdPartyClientInput, "contactEmail" | "notes">> & { contactEmail: string | null; notes: string | null } } | { ok: false; error: string } {
  const clientCode = String(raw.clientCode ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
  if (clientCode.length < 2 || clientCode.length > 24) {
    return { ok: false, error: "Client code must be 2–24 alphanumeric characters." };
  }

  const clientName = String(raw.clientName ?? "").trim();
  if (clientName.length < 2 || clientName.length > 120) {
    return { ok: false, error: "Client name must be 2–120 characters." };
  }

  const contactEmail = raw.contactEmail ? String(raw.contactEmail).trim().toLowerCase() : null;
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    return { ok: false, error: "Contact email is invalid." };
  }

  const slaHours = Math.max(4, Math.min(720, Math.round(Number(raw.slaHours ?? 48) || 48)));
  const billingModel = ALLOWED_BILLING_MODELS.includes(raw.billingModel as BillingModel)
    ? (raw.billingModel as BillingModel)
    : "HYBRID_STORAGE_PICK";

  const dedicatedWarehouses = Array.isArray(raw.dedicatedWarehouses)
    ? Array.from(
        new Set(
          raw.dedicatedWarehouses
            .map((w) => String(w).trim().toUpperCase())
            .filter(Boolean),
        ),
      ).slice(0, 50)
    : [];

  const skuPrefixes = Array.isArray(raw.skuPrefixes)
    ? Array.from(
        new Set(
          raw.skuPrefixes
            .map((s) => String(s).trim().toUpperCase())
            .filter(Boolean),
        ),
      ).slice(0, 50)
    : [];

  const monthlyStorageRateUsd = Math.max(
    0,
    Math.min(100_000, Number(raw.monthlyStorageRateUsd ?? 18.5) || 0),
  );
  const perOrderPickFeeUsd = Math.max(
    0,
    Math.min(10_000, Number(raw.perOrderPickFeeUsd ?? 3.25) || 0),
  );

  return {
    ok: true,
    value: {
      clientCode,
      clientName,
      contactEmail,
      slaHours,
      billingModel,
      dedicatedWarehouses,
      skuPrefixes,
      monthlyStorageRateUsd: Number(monthlyStorageRateUsd.toFixed(2)),
      perOrderPickFeeUsd: Number(perOrderPickFeeUsd.toFixed(2)),
      active: raw.active !== false,
      notes: raw.notes ? String(raw.notes).trim().slice(0, 400) : null,
    },
  };
}

/**
 * Computes client-specific segregated inventory, fulfillment volume, SLA compliance,
 * and estimated monthly revenue strictly from records inside the 3PL's own workspace.
 */
export function computeClientFulfillmentReports(
  clients: readonly ThirdPartyClientRecord[],
  inventory: readonly ClientInventoryLine[],
  shipments: readonly ClientShipmentMetricInput[],
): ClientFulfillmentReport[] {
  const nowMs = Date.now();
  return clients.map((client) => {
    const whSet = new Set(client.dedicatedWarehouses.map((w) => w.toUpperCase()));
    const prefixes = client.skuPrefixes.map((p) => p.toUpperCase());
    const codeUpper = client.clientCode.toUpperCase();
    const nameLower = client.clientName.toLowerCase();

    const matchedLines = inventory.filter((line) => {
      const skuUpper = line.sku.toUpperCase();
      const whUpper = line.warehouse.toUpperCase();
      const prefixMatch =
        prefixes.length > 0 && prefixes.some((p) => skuUpper.startsWith(p));
      const codeMatch = skuUpper.startsWith(`${codeUpper}-`) || skuUpper.startsWith(`${codeUpper}_`);
      const whMatch = whSet.size > 0 && whSet.has(whUpper);
      if (prefixes.length > 0 && whSet.size > 0) {
        return (prefixMatch || codeMatch) && whMatch;
      }
      if (prefixes.length > 0) return prefixMatch || codeMatch;
      if (whSet.size > 0) return whMatch;
      return codeMatch;
    });

    const onHandUnits = matchedLines.reduce((sum, l) => sum + Math.max(0, l.on_hand), 0);
    const reservedUnits = matchedLines.reduce((sum, l) => sum + Math.max(0, l.reserved), 0);
    const availableUnits = matchedLines.reduce((sum, l) => sum + Math.max(0, l.available), 0);

    const matchedShipments = shipments.filter((s) => {
      const cref = String(s.customer_ref ?? "").trim();
      if (!cref) return false;
      const crefUpper = cref.toUpperCase();
      return (
        crefUpper === codeUpper ||
        crefUpper.startsWith(`${codeUpper}-`) ||
        cref.toLowerCase().includes(nameLower)
      );
    });

    const totalShipments = matchedShipments.length;
    const deliveredShipments = matchedShipments.filter((s) =>
      TERMINAL_DELIVERED.has(s.state),
    ).length;
    const openShipments = matchedShipments.filter((s) => !CLOSED_STATES.has(s.state)).length;

    const overdueCount = matchedShipments.filter((s) => {
      if (TERMINAL_DELIVERED.has(s.state) || !s.deadline) return false;
      const d = new Date(s.deadline).getTime();
      return Number.isFinite(d) && d < nowMs;
    }).length;

    const onTimeRatePct =
      totalShipments === 0
        ? 100
        : Math.max(0, Math.round(((totalShipments - overdueCount) / totalShipments) * 100));

    // Estimate pallet equivalents (~40 units per pallet) + fulfillment pick fees
    const estPallets = Math.ceil(onHandUnits / 40);
    const storageRev = estPallets * client.monthlyStorageRateUsd;
    const fulfillmentRev = totalShipments * client.perOrderPickFeeUsd;
    let estimatedMonthlyRevenueUsd = storageRev + fulfillmentRev;
    if (client.billingModel === "PER_PALLET_MONTH") {
      estimatedMonthlyRevenueUsd = storageRev;
    } else if (client.billingModel === "PER_ORDER_FULFILLMENT") {
      estimatedMonthlyRevenueUsd = fulfillmentRev;
    }

    return {
      clientId: client.id,
      clientCode: client.clientCode,
      clientName: client.clientName,
      billingModel: client.billingModel,
      slaHours: client.slaHours,
      active: client.active,
      matchedSkuLines: matchedLines.length,
      onHandUnits,
      reservedUnits,
      availableUnits,
      totalShipments,
      openShipments,
      deliveredShipments,
      onTimeRatePct,
      estimatedMonthlyRevenueUsd: Number(estimatedMonthlyRevenueUsd.toFixed(2)),
    };
  });
}

/**
 * Normalizes and validates Harmonized System (HS) tariff codes (6 to 10 digits).
 */
export function normalizeHsCodes(raw: string[] | string): {
  valid: string[];
  invalid: string[];
} {
  const tokens = Array.isArray(raw)
    ? raw
    : String(raw ?? "")
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);

  const valid: string[] = [];
  const invalid: string[] = [];

  for (const token of tokens) {
    const digits = token.replace(/[^0-9]/g, "");
    if (digits.length >= 6 && digits.length <= 10) {
      const formatted =
        digits.length === 6
          ? `${digits.slice(0, 4)}.${digits.slice(4, 6)}`
          : `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`;
      if (!valid.includes(formatted)) valid.push(formatted);
    } else if (token.trim()) {
      invalid.push(token.trim());
    }
  }
  return { valid, invalid };
}

/**
 * Validates container numbers (ISO 6346 format like MSKU9070323), Air Waybills
 * (3-digit airline prefix + 8 digits like 176-12345678), or Bill of Lading / CMR refs.
 */
export function validateContainerOrWaybill(
  mode: FreightMode,
  rawRef: string,
): { ok: boolean; normalized: string; kind: string; reason?: string } {
  const normalized = String(rawRef ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

  if (normalized.length < 5 || normalized.length > 32) {
    return {
      ok: false,
      normalized,
      kind: "UNKNOWN",
      reason: "Tracking reference must be 5–32 characters.",
    };
  }

  if (mode === "SEA") {
    // ISO 6346 container (4 letters + 7 digits) or Ocean Bill of Lading (alphanumeric >= 6)
    if (/^[A-Z]{4}[0-9]{7}$/.test(normalized)) {
      return { ok: true, normalized, kind: "ISO_CONTAINER" };
    }
    if (/^[A-Z0-9-]{6,32}$/.test(normalized)) {
      return { ok: true, normalized, kind: "BILL_OF_LADING" };
    }
    return {
      ok: false,
      normalized,
      kind: "SEA",
      reason: "Sea freight requires an ISO container number (e.g., MSKU9070323) or Bill of Lading reference.",
    };
  }

  if (mode === "AIR") {
    // IATA Air Waybill (e.g., 176-12345678 or 17612345678)
    if (/^[0-9]{3}-?[0-9]{8}$/.test(normalized)) {
      const formatted = normalized.includes("-")
        ? normalized
        : `${normalized.slice(0, 3)}-${normalized.slice(3)}`;
      return { ok: true, normalized: formatted, kind: "AIR_WAYBILL" };
    }
    return {
      ok: false,
      normalized,
      kind: "AIR",
      reason: "Air freight requires an 11-digit IATA Air Waybill (e.g., 176-12345678).",
    };
  }

  if (/^[A-Z0-9-]{5,32}$/.test(normalized)) {
    return { ok: true, normalized, kind: mode === "RAIL" ? "RAIL_CONSIGNMENT" : "CMR_WAYBILL" };
  }

  return {
    ok: false,
    normalized,
    kind: mode,
    reason: "Consignment reference contains unsupported characters.",
  };
}

/**
 * Valid customs clearance state machine transitions.
 */
const ALLOWED_CUSTOMS_TRANSITIONS: Record<CustomsClearanceStatus, readonly CustomsClearanceStatus[]> = {
  PENDING_DOCS: ["PENDING_DOCS", "DOCS_VERIFIED", "HELD"],
  DOCS_VERIFIED: ["DOCS_VERIFIED", "SUBMITTED", "HELD", "PENDING_DOCS"],
  SUBMITTED: ["SUBMITTED", "CLEARED", "HELD"],
  HELD: ["HELD", "DOCS_VERIFIED", "SUBMITTED", "CLEARED"],
  CLEARED: ["CLEARED"],
};

export function canTransitionCustomsStatus(
  from: CustomsClearanceStatus,
  to: CustomsClearanceStatus,
): boolean {
  return ALLOWED_CUSTOMS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Computes customs documentation readiness score (0–100) and missing blockers.
 */
export function evaluateCustomsReadiness(record: {
  hsCodes: string[];
  commercialInvoiceReady: boolean;
  packingListReady: boolean;
  certificateOfOriginReady: boolean;
  customsBroker: string | null;
  declaredValueUsd: number;
}): { score: number; readyForSubmission: boolean; missing: string[] } {
  const missing: string[] = [];
  let score = 0;

  if (record.hsCodes.length > 0) score += 25;
  else missing.push("HS tariff code");

  if (record.commercialInvoiceReady) score += 25;
  else missing.push("Commercial invoice");

  if (record.packingListReady) score += 20;
  else missing.push("Packing list");

  if (record.certificateOfOriginReady) score += 10;
  else missing.push("Certificate of origin");

  if (record.customsBroker && record.customsBroker.trim()) score += 10;
  else missing.push("Assigned customs broker");

  if (record.declaredValueUsd > 0) score += 10;
  else missing.push("Declared customs value");

  const readyForSubmission =
    record.hsCodes.length > 0 &&
    record.commercialInvoiceReady &&
    record.packingListReady &&
    record.declaredValueUsd > 0;

  return { score, readyForSubmission, missing };
}

export function validateInternationalFreightInput(
  raw: InternationalFreightInput,
): { ok: true; value: Omit<InternationalFreightRecord, "id" | "orgId" | "updatedBy" | "createdAt" | "updatedAt"> } | { ok: false; error: string } {
  const shipmentReference = String(raw.shipmentReference ?? "").trim().toUpperCase();
  if (shipmentReference.length < 3 || shipmentReference.length > 48) {
    return { ok: false, error: "Shipment reference is required (3–48 characters)." };
  }

  const direction = ALLOWED_DIRECTIONS.includes(raw.direction as FreightDirection)
    ? (raw.direction as FreightDirection)
    : "EXPORT";
  const transportMode = ALLOWED_FREIGHT_MODES.includes(raw.transportMode as FreightMode)
    ? (raw.transportMode as FreightMode)
    : "SEA";
  const incoterm = ALLOWED_INCOTERMS.includes(raw.incoterm as IncotermCode)
    ? (raw.incoterm as IncotermCode)
    : "FOB";

  const trackingCheck = validateContainerOrWaybill(transportMode, raw.containerOrWaybill);
  if (!trackingCheck.ok) {
    return { ok: false, error: trackingCheck.reason ?? "Invalid container or waybill reference." };
  }

  const originCountry = String(raw.originCountry ?? "").trim().toUpperCase();
  const destinationCountry = String(raw.destinationCountry ?? "").trim().toUpperCase();
  if (originCountry.length < 2 || destinationCountry.length < 2) {
    return { ok: false, error: "Origin and destination countries are required." };
  }

  const hs = normalizeHsCodes(raw.hsCodes);
  if (hs.invalid.length > 0) {
    return {
      ok: false,
      error: `Invalid HS code(s): ${hs.invalid.join(", ")}. Expected 6–10 digits (e.g., 8471.30).`,
    };
  }
  if (hs.valid.length === 0) {
    return { ok: false, error: "At least one valid 6–10 digit HS code is required." };
  }

  const declaredValueUsd = Math.max(0, Number(raw.declaredValueUsd ?? 0) || 0);
  const estimatedDutyUsd =
    raw.estimatedDutyUsd !== undefined && raw.estimatedDutyUsd !== null
      ? Math.max(0, Number(raw.estimatedDutyUsd) || 0)
      : Number((declaredValueUsd * 0.045).toFixed(2));

  const clearanceStatus = ALLOWED_CUSTOMS_STATUSES.includes(
    raw.clearanceStatus as CustomsClearanceStatus,
  )
    ? (raw.clearanceStatus as CustomsClearanceStatus)
    : "PENDING_DOCS";

  return {
    ok: true,
    value: {
      shipmentReference,
      direction,
      transportMode,
      incoterm,
      containerOrWaybill: trackingCheck.normalized,
      originCountry: originCountry.slice(0, 64),
      destinationCountry: destinationCountry.slice(0, 64),
      portOfLoading: raw.portOfLoading ? String(raw.portOfLoading).trim().slice(0, 80) : null,
      portOfDischarge: raw.portOfDischarge ? String(raw.portOfDischarge).trim().slice(0, 80) : null,
      hsCodes: hs.valid,
      declaredValueUsd: Number(declaredValueUsd.toFixed(2)),
      estimatedDutyUsd: Number(estimatedDutyUsd.toFixed(2)),
      customsBroker: raw.customsBroker ? String(raw.customsBroker).trim().slice(0, 100) : null,
      clearanceStatus,
      commercialInvoiceReady: Boolean(raw.commercialInvoiceReady),
      packingListReady: Boolean(raw.packingListReady),
      certificateOfOriginReady: Boolean(raw.certificateOfOriginReady),
      milestoneNote: raw.milestoneNote ? String(raw.milestoneNote).trim().slice(0, 280) : null,
    },
  };
}

export function summarizeInternationalFreight(records: readonly InternationalFreightRecord[]) {
  return {
    total: records.length,
    airCount: records.filter((r) => r.transportMode === "AIR").length,
    seaCount: records.filter((r) => r.transportMode === "SEA").length,
    roadRailCount: records.filter((r) => r.transportMode === "ROAD" || r.transportMode === "RAIL")
      .length,
    clearedCount: records.filter((r) => r.clearanceStatus === "CLEARED").length,
    heldCount: records.filter((r) => r.clearanceStatus === "HELD").length,
    totalDeclaredUsd: Number(
      records.reduce((sum, r) => sum + r.declaredValueUsd, 0).toFixed(2),
    ),
  };
}
