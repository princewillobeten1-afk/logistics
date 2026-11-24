import { Type, type Schema } from "@google/genai";
import { generateAgentJson, getServerGeminiKey } from "@/lib/agents/gemini-client";
import type { AutonomousIntent } from "@/lib/agents/autonomous";
import type { CanonicalEntityType } from "./catalog";

export type DetectedPayloadFormat = "JSON" | "CSV" | "EDI_X12" | "TEXT";

export interface NormalizedLogisticsEvent {
  entityType: CanonicalEntityType;
  intent: AutonomousIntent;
  mappedBy: "FIELD_MAPPING" | "HEURISTIC" | "EDI_PARSER" | "AI_MAPPER";
  confidence: number;
  externalRef: string | null;
  shipmentRef: string | null;
  originCity: string | null;
  destinationCity: string | null;
  cargoDescription: string | null;
  weightKg: number | null;
  quantity: number | null;
  deadlineIso: string | null;
  preferredMode: string | null;
  customerName: string | null;
  customerEmail: string | null;
  hazmat: boolean;
  reefer: boolean;
  currency: string;
  // Telemetry & Fleet
  vehicleRegistration: string | null;
  latitude: number | null;
  longitude: number | null;
  speedKph: number | null;
  temperatureC: number | null;
  // Warehouse Inventory
  warehouseCode: string | null;
  sku: string | null;
  onHand: number | null;
  reserved: number | null;
  // Exceptions & Updates
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | null;
  statusUpdate: string | null;
  notes: string | null;
  summary: string;
  suggestedFieldMapping?: Record<string, string>;
}

export interface PayloadParseResult {
  format: DetectedPayloadFormat;
  records: Record<string, unknown>[];
  rawText?: string;
}

/**
 * Safely reads a nested dot-path (supporting array indices like `line_items.0.title`).
 */
export function getPathValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object" || !path.trim()) return undefined;
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      const record = cur as Record<string, unknown>;
      if (seg in record) {
        cur = record[seg];
      } else {
        // Case-insensitive key lookup fallback
        const foundKey = Object.keys(record).find(
          (k) => k.toLowerCase() === seg.toLowerCase(),
        );
        if (!foundKey) return undefined;
        cur = record[foundKey];
      }
    }
  }
  return cur;
}

/**
 * RFC-4180 compliant CSV parser supporting quoted commas and escaped double quotes.
 */
export function parseCsvRecords(raw: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  const text = raw.replace(/^\uFEFF/, "").trim();
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\r" && next === "\n") {
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else if (ch === "\n" || ch === "\r") {
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  if (row.some((c) => c.length > 0)) rows.push(row);

  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  const records: Record<string, unknown>[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const line = rows[r];
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c];
      if (!key) continue;
      obj[key] = line[c] ?? "";
    }
    records.push(obj);
  }
  return records;
}

/**
 * Parses ANSI EDI X12 documents (204 Motor Carrier Load Tender, 214 Shipment Status, 856 ASN).
 */
export function parseEdiX12(raw: string): NormalizedLogisticsEvent | null {
  const cleaned = raw.trim();
  if (!/^ISA\*|^ST\*(204|214|856)\*/m.test(cleaned)) return null;

  const segments = cleaned
    .split(/~|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((seg) => seg.split("*"));

  let txSet = "204";
  let externalRef: string | null = null;
  let shipmentRef: string | null = null;
  let originCity: string | null = null;
  let destinationCity: string | null = null;
  let customerName: string | null = null;
  let cargoDescription: string | null = null;
  let weightKg: number | null = null;
  let quantity: number | null = null;
  let deadlineIso: string | null = null;
  let statusUpdate: string | null = null;
  let currentPartyRole: "SH" | "CN" | "OTHER" = "OTHER";

  for (const elements of segments) {
    const tag = elements[0]?.toUpperCase();
    if (tag === "ST" && elements[1]) {
      txSet = elements[1].trim();
    } else if (tag === "B2" && elements[4]) {
      externalRef = elements[4].trim();
    } else if (tag === "B10") {
      if (elements[1]) shipmentRef = elements[1].trim().toUpperCase();
      if (elements[2]) externalRef = externalRef || elements[2].trim();
    } else if (tag === "BSN" && elements[2]) {
      externalRef = externalRef || elements[2].trim();
    } else if (tag === "N1") {
      const qual = elements[1]?.toUpperCase();
      if (qual === "SH" || qual === "SF") {
        currentPartyRole = "SH";
      } else if (qual === "CN" || qual === "ST") {
        currentPartyRole = "CN";
        if (elements[2]) customerName = elements[2].trim();
      } else {
        currentPartyRole = "OTHER";
      }
    } else if (tag === "N4" && elements[1]) {
      const city = elements[1].trim();
      if (currentPartyRole === "SH" && !originCity) originCity = city;
      else if (currentPartyRole === "CN" && !destinationCity) destinationCity = city;
    } else if (tag === "L5" && elements[2]) {
      cargoDescription = cargoDescription
        ? `${cargoDescription}; ${elements[2].trim()}`
        : elements[2].trim();
    } else if (tag === "AT8") {
      const unitCode = elements[2]?.toUpperCase();
      const rawWeight = Number(elements[3]);
      if (Number.isFinite(rawWeight) && rawWeight > 0) {
        weightKg =
          unitCode === "L" ? Math.round(rawWeight * 0.453592) : Math.round(rawWeight);
      }
      const rawQty = Number(elements[4]);
      if (Number.isFinite(rawQty) && rawQty > 0) {
        quantity = Math.round(rawQty);
      }
    } else if (tag === "G62" && elements[2] && /^\d{8}$/.test(elements[2])) {
      const d = elements[2];
      const t = elements[4] && /^\d{4}$/.test(elements[4]) ? elements[4] : "1200";
      deadlineIso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`;
    } else if (tag === "AT7") {
      const statusCode = elements[1]?.trim();
      const reasonCode = elements[2]?.trim();
      const statusMap: Record<string, string> = {
        AF: "Departed pickup location",
        X3: "Arrived at pickup location",
        X1: "Arrived at delivery location",
        D1: "Completed unloading at delivery location",
        SD: "Shipment delayed in transit",
      };
      statusUpdate =
        statusMap[statusCode] ||
        `EDI 214 Status ${statusCode || "UPDATE"}${reasonCode ? ` (${reasonCode})` : ""}`;
    }
  }

  const isStatus = txSet === "214";
  const isDelay = Boolean(statusUpdate && /delay/i.test(statusUpdate));
  const entityType: CanonicalEntityType = isDelay
    ? "EXCEPTION"
    : isStatus
      ? "SHIPMENT_UPDATE"
      : "ORDER";
  const intent: AutonomousIntent = isDelay
    ? "EXCEPTION_REPORT"
    : isStatus
      ? "SHIPMENT_ACTION"
      : "NEW_ORDER";

  return {
    entityType,
    intent,
    mappedBy: "EDI_PARSER",
    confidence: 0.96,
    externalRef,
    shipmentRef,
    originCity,
    destinationCity,
    cargoDescription: cargoDescription || `EDI X12 ${txSet} Freight Load`,
    weightKg,
    quantity,
    deadlineIso,
    preferredMode: "ROAD",
    customerName,
    customerEmail: null,
    hazmat: false,
    reefer: false,
    currency: "USD",
    vehicleRegistration: null,
    latitude: null,
    longitude: null,
    speedKph: null,
    temperatureC: null,
    warehouseCode: null,
    sku: null,
    onHand: null,
    reserved: null,
    severity: isDelay ? "HIGH" : null,
    statusUpdate,
    notes: statusUpdate || `Ingested via EDI X12 ${txSet}`,
    summary: isStatus
      ? `EDI 214 status update (${statusUpdate ?? "milestone"}) for ${shipmentRef ?? externalRef ?? "shipment"}`
      : `EDI ${txSet} load tender ${externalRef ?? ""} from ${originCity ?? "origin"} to ${destinationCity ?? "destination"}`.trim(),
  };
}

export function detectAndParseRawPayload(
  rawInput: string | Record<string, unknown> | Record<string, unknown>[],
  contentType?: string | null,
): PayloadParseResult {
  if (typeof rawInput !== "string") {
    const arr = Array.isArray(rawInput) ? rawInput : [rawInput];
    return {
      format: "JSON",
      records: arr.filter((r): r is Record<string, unknown> => Boolean(r && typeof r === "object")),
    };
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { format: "TEXT", records: [], rawText: "" };
  }

  // EDI X12 detection
  if (/^ISA\*|^ST\*(204|214|856)\*/m.test(trimmed)) {
    return { format: "EDI_X12", records: [{ _ediRaw: trimmed }], rawText: trimmed };
  }

  // JSON / JSON Array / Envelope detection
  const ct = (contentType ?? "").toLowerCase();
  if (
    ct.includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return {
          format: "JSON",
          records: parsed.filter(
            (r): r is Record<string, unknown> => Boolean(r && typeof r === "object"),
          ),
        };
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        // Unwrap common batch envelopes: { records: [...] }, { orders: [...] }, { events: [...] }, { shipments: [...] }
        for (const batchKey of ["records", "orders", "shipments", "events", "items"]) {
          const maybeArr = obj[batchKey];
          if (
            Array.isArray(maybeArr) &&
            maybeArr.length > 0 &&
            typeof maybeArr[0] === "object" &&
            maybeArr[0] !== null &&
            batchKey !== "items" // keep order line items inside parent order unless it's clearly a top-level batch
          ) {
            return {
              format: "JSON",
              records: maybeArr as Record<string, unknown>[],
            };
          }
        }
        return { format: "JSON", records: [obj] };
      }
    } catch {
      // Fall through to CSV / text detection
    }
  }

  // CSV detection
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (
    ct.includes("csv") ||
    (lines.length >= 2 && lines[0].includes(",") && lines[1].includes(","))
  ) {
    const csvRecords = parseCsvRecords(trimmed);
    if (csvRecords.length > 0) {
      return { format: "CSV", records: csvRecords, rawText: trimmed };
    }
  }

  return {
    format: "TEXT",
    records: [{ message: trimmed }],
    rawText: trimmed,
  };
}

function asString(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/,/g, "").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    return /^(true|yes|1|y|on)$/i.test(v.trim());
  }
  return false;
}

function pickFirstString(obj: Record<string, unknown>, paths: string[]): string | null {
  for (const p of paths) {
    const val = asString(getPathValue(obj, p));
    if (val) return val;
  }
  return null;
}

function pickFirstNumber(obj: Record<string, unknown>, paths: string[]): number | null {
  for (const p of paths) {
    const val = asNumber(getPathValue(obj, p));
    if (val !== null) return val;
  }
  return null;
}

function pickFirstBool(obj: Record<string, unknown>, paths: string[]): boolean {
  for (const p of paths) {
    const raw = getPathValue(obj, p);
    if (raw !== undefined && raw !== null && raw !== "") {
      return asBool(raw);
    }
  }
  return false;
}

export function normalizeRecordDeterministically(
  record: Record<string, unknown>,
  fieldMapping: Record<string, string> = {},
): {
  normalized: NormalizedLogisticsEvent;
  needsAiInference: boolean;
} {
  // Handle EDI X12 directly
  if (typeof record._ediRaw === "string") {
    const edi = parseEdiX12(record._ediRaw);
    if (edi) {
      return { normalized: edi, needsAiInference: false };
    }
  }

  let mappedFieldHits = 0;
  const fromMap = (canonicalKey: string): unknown => {
    const path = fieldMapping[canonicalKey];
    if (!path) return undefined;
    const v = getPathValue(record, path);
    if (v !== undefined && v !== null && v !== "") {
      mappedFieldHits += 1;
    }
    return v;
  };

  const externalRef =
    asString(fromMap("externalRef")) ??
    pickFirstString(record, [
      "external_ref",
      "externalRef",
      "order_ref",
      "orderRef",
      "FreightOrderID",
      "FreightOrder",
      "tranId",
      "order_id",
      "orderId",
      "order_number",
      "orderNumber",
      "po_number",
      "poNumber",
      "booking_ref",
      "bookingRef",
      "load_id",
      "loadId",
      "bol_number",
      "bolNumber",
      "Shipment.WaybillNumber",
      "waybill",
      "job_ticket",
      "reference",
      "name",
      "id",
    ]);

  const shipmentRefCandidate =
    asString(fromMap("shipmentRef")) ??
    pickFirstString(record, [
      "shipment_ref",
      "shipmentRef",
      "shipmentReference",
      "tracking_number",
      "trackingNumber",
    ]);
  const shipmentRef = shipmentRefCandidate
    ? shipmentRefCandidate.toUpperCase()
    : externalRef && /^LG-\d+/i.test(externalRef)
      ? externalRef.toUpperCase()
      : null;

  const originCity =
    asString(fromMap("originCity")) ??
    pickFirstString(record, [
      "origin_city",
      "originCity",
      "origin.city",
      "origin",
      "SourceLocation.CityName",
      "SourceLocation",
      "source_location",
      "sourceCity",
      "source_city",
      "originLocation",
      "origin_location",
      "location.city",
      "fulfillment_origin.city",
      "Shipment.PortOfOrigin.Name",
      "ship_from.city",
      "shipFrom.city",
      "pickup_city",
      "pickupCity",
      "pickup_hub",
      "facilityCity",
      "loading_city",
      "departure_city",
      "from_city",
      "from",
    ]);

  const destinationCity =
    asString(fromMap("destinationCity")) ??
    pickFirstString(record, [
      "destination_city",
      "destinationCity",
      "destination.city",
      "destination",
      "DestinationLocation.CityName",
      "DestinationLocation",
      "destination_location",
      "destLocation",
      "dest_location",
      "dest_city",
      "destCity",
      "shippingAddress.city",
      "shipping_address.city",
      "Shipment.PortOfDestination.Name",
      "ship_to.city",
      "shipTo.city",
      "shipToCity",
      "delivery_city",
      "deliveryCity",
      "dropoff_hub",
      "unloading_city",
      "arrival_city",
      "to_city",
      "to",
    ]);

  const cargoDescription =
    asString(fromMap("cargoDescription")) ??
    pickFirstString(record, [
      "cargo_description",
      "cargoDescription",
      "cargo.description",
      "cargo",
      "CargoSummary.MaterialDescription",
      "Shipment.GoodsDescription",
      "line_items.0.title",
      "freight_item",
      "description",
      "item_description",
      "memo",
      "commodity",
    ]);

  let weightKg =
    asNumber(fromMap("weightKg")) ??
    pickFirstNumber(record, [
      "weight_kg",
      "weightKg",
      "GrossWeightKg",
      "totalWeightKg",
      "Shipment.TotalWeight",
      "mass_kg",
      "cargo.weight_kg",
      "weight",
    ]);

  if (weightKg === null) {
    const grams =
      asNumber(fromMap("weightGrams")) ??
      pickFirstNumber(record, ["total_weight", "weight_g", "weightGrams"]);
    if (grams !== null && grams > 0) {
      weightKg = Math.round((grams / 1000) * 100) / 100;
    }
  }
  if (weightKg === null) {
    const lbs =
      asNumber(fromMap("weightLbs")) ??
      pickFirstNumber(record, ["weight_lbs", "weightLbs", "gross_weight_lbs"]);
    if (lbs !== null && lbs > 0) {
      weightKg = Math.round(lbs * 0.453592 * 100) / 100;
    }
  }

  const quantity =
    asNumber(fromMap("quantity")) ??
    pickFirstNumber(record, [
      "quantity",
      "qty",
      "PackageCount",
      "itemCount",
      "Shipment.OuterPacks",
      "line_items.0.quantity",
      "crates",
      "pallets",
      "units",
      "pieces",
    ]);

  const deadlineIso =
    asString(fromMap("deadlineIso")) ??
    pickFirstString(record, [
      "deadline",
      "deadlineIso",
      "deadline_iso",
      "required_by",
      "requiredBy",
      "RequestedDeliveryDateTime",
      "RequestedDeliveryDate",
      "requested_delivery_date",
      "delivery_date",
      "deliveryDate",
      "due_date",
      "dueDate",
      "shipDate",
      "Shipment.EstimatedDelivery",
      "target_eta",
      "eta",
    ]);

  const preferredMode =
    asString(fromMap("preferredMode")) ??
    pickFirstString(record, [
      "preferred_mode",
      "preferredMode",
      "mode",
      "TransportationModeCode",
      "Shipment.TransportMode",
      "transport_mode",
    ]);

  const customerName =
    asString(fromMap("customerName")) ??
    pickFirstString(record, [
      "customer_name",
      "customerName",
      "ShipToParty.BusinessPartnerName",
      "entity.companyName",
      "Shipment.Consignee.CompanyName",
      "customer.first_name",
      "customer.name",
      "client_org",
      "consignee",
      "customer",
    ]);

  const customerEmail =
    asString(fromMap("customerEmail")) ??
    pickFirstString(record, [
      "customer_email",
      "customerEmail",
      "ShipToParty.ContactEmail",
      "entity.email",
      "Shipment.Consignee.Email",
      "email",
    ]);

  const hazmat =
    asBool(fromMap("hazmat")) ||
    pickFirstBool(record, [
      "hazmat",
      "hazmat_flag",
      "CargoSummary.DangerousGoodsIndicator",
      "dangerous_goods",
      "isHazmat",
    ]);

  const reefer =
    asBool(fromMap("reefer")) ||
    pickFirstBool(record, [
      "reefer",
      "temperatureControlled",
      "CargoSummary.TemperatureControlled",
      "cold_chain",
      "isReefer",
    ]);

  const currency =
    (
      asString(fromMap("currency")) ??
      pickFirstString(record, ["currency", "DocumentCurrency", "currency.refName"]) ??
      "USD"
    ).toUpperCase();

  // Telemetry fields
  const vehicleRegistration =
    asString(fromMap("vehicleRegistration")) ??
    pickFirstString(record, [
      "vehicle.licensePlate",
      "vehicle_registration",
      "vehicleRegistration",
      "registration",
      "license_plate",
      "plate",
      "truck_id",
    ]);

  const latitude =
    asNumber(fromMap("latitude")) ??
    pickFirstNumber(record, ["gps.latitude", "latitude", "lat", "position.lat"]);
  const longitude =
    asNumber(fromMap("longitude")) ??
    pickFirstNumber(record, ["gps.longitude", "longitude", "lon", "lng", "position.lon"]);
  const speedKph =
    asNumber(fromMap("speedKph")) ??
    pickFirstNumber(record, ["gps.speedKph", "speed_kph", "speedKph", "speed"]);
  const temperatureC =
    asNumber(fromMap("temperatureC")) ??
    pickFirstNumber(record, ["reefer.ambientTempC", "temperature_c", "temperatureC", "tempC"]);

  // Warehouse Inventory fields
  const warehouseCode =
    asString(fromMap("warehouseCode")) ??
    pickFirstString(record, ["facilityCode", "warehouse_code", "warehouseCode", "warehouse"]);
  const sku =
    asString(fromMap("sku")) ??
    pickFirstString(record, ["skuCode", "sku", "item_sku", "material_code"]);
  const onHand =
    asNumber(fromMap("onHand")) ??
    pickFirstNumber(record, ["qtyOnHand", "on_hand", "onHand", "stock_qty"]);
  const reserved =
    asNumber(fromMap("reserved")) ??
    pickFirstNumber(record, ["qtyAllocated", "reserved", "allocated"]);

  const notes =
    asString(fromMap("notes")) ??
    pickFirstString(record, [
      "notes",
      "urgency_note",
      "alert.message",
      "message",
      "comment",
      "reason",
    ]);

  const rawEventHint = (
    pickFirstString(record, [
      "eventType",
      "EventType",
      "event_type",
      "topic",
      "recordType",
      "MessageType",
      "type",
      "alert.code",
    ]) ?? ""
  ).toLowerCase();

  const statusUpdate = pickFirstString(record, ["status", "milestone", "state", "alert.code"]);

  // Determine canonical entity type & intent
  let entityType: CanonicalEntityType = "ORDER";
  let intent: AutonomousIntent = "NEW_ORDER";
  let severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | null = null;

  const isTempExcursion = temperatureC !== null && (temperatureC > 8 || temperatureC < -25);
  if (
    /exception|delay|damage|incident|accident|alert|breakdown|breach/i.test(rawEventHint) ||
    /exception|delay|damage|breakdown|breach/i.test(notes ?? "") ||
    isTempExcursion
  ) {
    entityType = "EXCEPTION";
    intent = "EXCEPTION_REPORT";
    severity = isTempExcursion || /critical|accident|stolen/i.test(`${rawEventHint} ${notes ?? ""}`)
      ? "CRITICAL"
      : "HIGH";
  } else if (
    (latitude !== null && longitude !== null) ||
    /gps|telemetry|location|position/i.test(rawEventHint)
  ) {
    entityType = "TELEMETRY";
    intent = "TRACKING_INQUIRY";
  } else if (
    (sku && (onHand !== null || reserved !== null)) ||
    /inventory|stock|warehouse|wms/i.test(rawEventHint)
  ) {
    entityType = "INVENTORY_SYNC";
    intent = "PLANNING_ROUTING";
  } else if (/customs|clearance|hs_code|declaration/i.test(rawEventHint)) {
    entityType = "CUSTOMS_DOC";
    intent = "CUSTOMS_DOCS";
  } else if (/quote|rate|bid|tariff/i.test(rawEventHint)) {
    entityType = "CARRIER_QUOTE";
    intent = "BILLING_INVOICE";
  } else if (
    (shipmentRef && !originCity && !destinationCity) ||
    /update|milestone|status|delivered|departed/i.test(rawEventHint)
  ) {
    entityType = "SHIPMENT_UPDATE";
    intent = "SHIPMENT_ACTION";
  } else {
    entityType = "ORDER";
    intent = "NEW_ORDER";
  }

  const hasCoreOrder = Boolean(originCity && destinationCity);
  const hasCoreTelemetry = Boolean(latitude !== null && longitude !== null);
  const hasCoreInventory = Boolean(sku && (onHand !== null || reserved !== null));
  const hasCoreUpdate = Boolean(shipmentRef || (entityType === "EXCEPTION" && notes));

  const needsAiInference = !(
    hasCoreOrder ||
    hasCoreTelemetry ||
    hasCoreInventory ||
    hasCoreUpdate
  );

  const summaryParts = [
    entityType === "ORDER"
      ? `External order ${externalRef ?? ""}${originCity && destinationCity ? ` (${originCity} → ${destinationCity})` : ""}`
      : entityType === "TELEMETRY"
        ? `GPS update for ${vehicleRegistration ?? shipmentRef ?? "vehicle"} (${latitude?.toFixed(4)}, ${longitude?.toFixed(4)})`
        : entityType === "INVENTORY_SYNC"
          ? `Inventory sync ${warehouseCode ?? "WH"} · ${sku ?? "SKU"} (on hand: ${onHand ?? "—"})`
          : entityType === "EXCEPTION"
            ? `External exception alert${shipmentRef ? ` on ${shipmentRef}` : ""}: ${notes ?? statusUpdate ?? "disruption"}`
            : `${entityType.replace(/_/g, " ").toLowerCase()} for ${shipmentRef ?? externalRef ?? "record"}`,
  ];

  return {
    normalized: {
      entityType,
      intent,
      mappedBy: mappedFieldHits >= 2 ? "FIELD_MAPPING" : "HEURISTIC",
      confidence: needsAiInference ? 0.45 : mappedFieldHits >= 2 ? 0.95 : 0.88,
      externalRef,
      shipmentRef,
      originCity,
      destinationCity,
      cargoDescription,
      weightKg,
      quantity: quantity !== null ? Math.round(quantity) : null,
      deadlineIso,
      preferredMode: preferredMode ? preferredMode.toUpperCase() : null,
      customerName,
      customerEmail,
      hazmat,
      reefer,
      currency,
      vehicleRegistration,
      latitude,
      longitude,
      speedKph,
      temperatureC,
      warehouseCode,
      sku,
      onHand: onHand !== null ? Math.round(onHand) : null,
      reserved: reserved !== null ? Math.round(reserved) : null,
      severity,
      statusUpdate,
      notes,
      summary: summaryParts.join(" ").trim(),
    },
    needsAiInference,
  };
}

const AI_MAPPER_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    entityType: {
      type: Type.STRING,
      description:
        "One of: ORDER, SHIPMENT_UPDATE, TELEMETRY, EXCEPTION, INVENTORY_SYNC, CARRIER_QUOTE, CUSTOMS_DOC",
    },
    intent: {
      type: Type.STRING,
      description:
        "One of: NEW_ORDER, PLANNING_ROUTING, SHIPMENT_ACTION, EXCEPTION_REPORT, CUSTOMS_DOCS, BILLING_INVOICE, TRACKING_INQUIRY",
    },
    externalRef: { type: Type.STRING },
    shipmentRef: { type: Type.STRING },
    originCity: { type: Type.STRING },
    destinationCity: { type: Type.STRING },
    cargoDescription: { type: Type.STRING },
    weightKg: { type: Type.NUMBER },
    quantity: { type: Type.INTEGER },
    deadlineIso: { type: Type.STRING },
    preferredMode: { type: Type.STRING },
    customerName: { type: Type.STRING },
    customerEmail: { type: Type.STRING },
    hazmat: { type: Type.BOOLEAN },
    reefer: { type: Type.BOOLEAN },
    currency: { type: Type.STRING },
    vehicleRegistration: { type: Type.STRING },
    latitude: { type: Type.NUMBER },
    longitude: { type: Type.NUMBER },
    speedKph: { type: Type.NUMBER },
    temperatureC: { type: Type.NUMBER },
    warehouseCode: { type: Type.STRING },
    sku: { type: Type.STRING },
    onHand: { type: Type.INTEGER },
    reserved: { type: Type.INTEGER },
    severity: { type: Type.STRING },
    statusUpdate: { type: Type.STRING },
    notes: { type: Type.STRING },
    summary: { type: Type.STRING },
    suggestedMappings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          canonicalField: { type: Type.STRING },
          sourcePath: { type: Type.STRING },
        },
        required: ["canonicalField", "sourcePath"],
      },
    },
  },
  required: ["entityType", "intent", "summary"],
};

const VALID_ENTITIES = new Set<CanonicalEntityType>([
  "ORDER",
  "SHIPMENT_UPDATE",
  "TELEMETRY",
  "EXCEPTION",
  "INVENTORY_SYNC",
  "CARRIER_QUOTE",
  "CUSTOMS_DOC",
]);

const VALID_INTENTS = new Set<AutonomousIntent>([
  "NEW_ORDER",
  "PLANNING_ROUTING",
  "SHIPMENT_ACTION",
  "EXCEPTION_REPORT",
  "CUSTOMS_DOCS",
  "BILLING_INVOICE",
  "TRACKING_INQUIRY",
]);

/**
 * Normalizes ANY company's arbitrary payload into a canonical Control Tower logistics event.
 * Uses deterministic field mapping + heuristics first; invokes Gemini AI Universal Schema Mapper
 * whenever proprietary/unfamiliar schemas or unstructured freight descriptions require semantic extraction.
 */
export async function normalizeExternalRecord(
  record: Record<string, unknown>,
  {
    fieldMapping = {},
    systemName = "External System",
    forceAi = false,
  }: {
    fieldMapping?: Record<string, string>;
    systemName?: string;
    forceAi?: boolean;
  } = {},
): Promise<NormalizedLogisticsEvent> {
  const { normalized, needsAiInference } = normalizeRecordDeterministically(
    record,
    fieldMapping,
  );

  if ((!needsAiInference && !forceAi) || !getServerGeminiKey()) {
    return normalized;
  }

  try {
    const prompt = [
      `External logistics system: ${systemName}`,
      `Extract canonical logistics fields from this raw payload and infer the exact dot-path field mapping for future automated ingestion.`,
      `Convert weights in lbs or grams to weightKg (kilograms). Leave unavailable fields omitted or empty.`,
      `Raw payload:\n${JSON.stringify(record).slice(0, 8000)}`,
    ].join("\n\n");

    const { data } = await generateAgentJson<{
      entityType?: string;
      intent?: string;
      externalRef?: string;
      shipmentRef?: string;
      originCity?: string;
      destinationCity?: string;
      cargoDescription?: string;
      weightKg?: number;
      quantity?: number;
      deadlineIso?: string;
      preferredMode?: string;
      customerName?: string;
      customerEmail?: string;
      hazmat?: boolean;
      reefer?: boolean;
      currency?: string;
      vehicleRegistration?: string;
      latitude?: number;
      longitude?: number;
      speedKph?: number;
      temperatureC?: number;
      warehouseCode?: string;
      sku?: string;
      onHand?: number;
      reserved?: number;
      severity?: string;
      statusUpdate?: string;
      notes?: string;
      summary?: string;
      suggestedMappings?: { canonicalField: string; sourcePath: string }[];
    }>({
      systemInstruction:
        "You are a universal logistics EDI/ERP/WMS/TMS schema mapper. Extract structured logistics entities accurately with zero hallucinated cities or numbers.",
      prompt,
      responseSchema: AI_MAPPER_SCHEMA,
      thinkingDepth: "LOW",
      timeoutMs: 25_000,
      perAttemptTimeoutMs: 15_000,
    });

    const entityType = VALID_ENTITIES.has(data.entityType as CanonicalEntityType)
      ? (data.entityType as CanonicalEntityType)
      : normalized.entityType;
    const intent = VALID_INTENTS.has(data.intent as AutonomousIntent)
      ? (data.intent as AutonomousIntent)
      : normalized.intent;

    const suggestedFieldMapping: Record<string, string> = {};
    for (const m of data.suggestedMappings ?? []) {
      if (m.canonicalField && m.sourcePath) {
        suggestedFieldMapping[m.canonicalField.trim()] = m.sourcePath.trim();
      }
    }

    const rawSev = (data.severity ?? "").toUpperCase();
    const severity = (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(rawSev)
      ? rawSev
      : normalized.severity) as NormalizedLogisticsEvent["severity"];

    return {
      ...normalized,
      entityType,
      intent,
      mappedBy: "AI_MAPPER",
      confidence: 0.92,
      externalRef: asString(data.externalRef) ?? normalized.externalRef,
      shipmentRef:
        (asString(data.shipmentRef)?.toUpperCase() ?? null) || normalized.shipmentRef,
      originCity: asString(data.originCity) ?? normalized.originCity,
      destinationCity: asString(data.destinationCity) ?? normalized.destinationCity,
      cargoDescription: asString(data.cargoDescription) ?? normalized.cargoDescription,
      weightKg: asNumber(data.weightKg) ?? normalized.weightKg,
      quantity: asNumber(data.quantity) ?? normalized.quantity,
      deadlineIso: asString(data.deadlineIso) ?? normalized.deadlineIso,
      preferredMode:
        asString(data.preferredMode)?.toUpperCase() ?? normalized.preferredMode,
      customerName: asString(data.customerName) ?? normalized.customerName,
      customerEmail: asString(data.customerEmail) ?? normalized.customerEmail,
      hazmat: Boolean(data.hazmat ?? normalized.hazmat),
      reefer: Boolean(data.reefer ?? normalized.reefer),
      currency: (asString(data.currency) ?? normalized.currency).toUpperCase(),
      vehicleRegistration:
        asString(data.vehicleRegistration) ?? normalized.vehicleRegistration,
      latitude: asNumber(data.latitude) ?? normalized.latitude,
      longitude: asNumber(data.longitude) ?? normalized.longitude,
      speedKph: asNumber(data.speedKph) ?? normalized.speedKph,
      temperatureC: asNumber(data.temperatureC) ?? normalized.temperatureC,
      warehouseCode: asString(data.warehouseCode) ?? normalized.warehouseCode,
      sku: asString(data.sku) ?? normalized.sku,
      onHand: asNumber(data.onHand) ?? normalized.onHand,
      reserved: asNumber(data.reserved) ?? normalized.reserved,
      severity,
      statusUpdate: asString(data.statusUpdate) ?? normalized.statusUpdate,
      notes: asString(data.notes) ?? normalized.notes,
      summary: asString(data.summary) ?? normalized.summary,
      suggestedFieldMapping:
        Object.keys(suggestedFieldMapping).length > 0
          ? suggestedFieldMapping
          : undefined,
    };
  } catch {
    return normalized;
  }
}
