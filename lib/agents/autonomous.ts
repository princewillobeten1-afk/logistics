import { classifyGeminiError, selectOrchestratorSpecialists, type CoreAgentId } from "./catalog";
import { getServerGeminiKey } from "./gemini-client";
import { scheduleBackgroundAgent } from "./background";
import {
  executeAgentTask,
  runCustomerSupportWithGemini,
  type SupportAutonomousHandoff,
} from "./orchestrator";
import { recordAudit } from "@/lib/audit";
import { identityQuery, query, runWithOrgScope } from "@/lib/db";
import { calculateShipmentPlan } from "@/lib/planning";

export type IntakeSourceChannel =
  | "WEBSITE_CHAT"
  | "WIDGET"
  | "WHATSAPP"
  | "TELEGRAM"
  | "GMAIL"
  | "EMAIL"
  | "WEB_FORM_ORDER"
  | "WEB_FORM_PLANNING"
  | "EXTERNAL_API";

export type AutonomousIntent =
  | SupportAutonomousHandoff["intent"]
  | "FLEET_OPTIMIZE"
  | "APPROVAL_DECISION";

export interface AutonomousStructuredInput {
  originCity?: string | null;
  originAddress?: string | null;
  originCountry?: string | null;
  destinationCity?: string | null;
  destinationAddress?: string | null;
  destinationCountry?: string | null;
  cargoDescription?: string | null;
  weightKg?: number | null;
  quantity?: number | null;
  deadlineIso?: string | null;
  preferredMode?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  shipperName?: string | null;
  shipperPhone?: string | null;
  shipperEmail?: string | null;
  receiverName?: string | null;
  receiverPhone?: string | null;
  receiverEmail?: string | null;
  hsCode?: string | null;
  incoterm?: string | null;
  hazmat?: boolean;
  reefer?: boolean;
  currency?: string | null;
  notes?: string | null;
  missingFields?: string[];
}

export interface AutonomousIntakeInput {
  sourceChannel: IntakeSourceChannel;
  intentHint?: AutonomousIntent;
  message: string;
  reference?: string | null;
  contactId?: string | null;
  externalId?: string | null;
  displayName?: string | null;
  orgId: string | null;
  actorEmail?: string | null;
  structured?: AutonomousStructuredInput;
  mode?: "sync_orchestrate" | "background_orchestrate";
  skipEntityCreation?: boolean;
}

export interface AutonomousDispatchResult {
  intent: AutonomousIntent;
  startedWork: boolean;
  orderReference: string | null;
  shipmentReference: string | null;
  shipmentId: string | null;
  delegatedAgents: CoreAgentId[];
  draftSaved: boolean;
  orchestrationSummary: string | null;
  aiWarning: string | null;
}

export function mapIntakeToSourceAndVia(sourceChannel: IntakeSourceChannel): {
  orderSource: "API" | "ERP" | "CRM" | "EMAIL" | "WHATSAPP" | "CSV" | "PORTAL" | "MANUAL";
  shipmentCreatedVia: "API" | "CHAT" | "CSV" | "EMAIL" | "ERP" | "MANUAL";
  contactChannel: "WIDGET" | "WHATSAPP" | "TELEGRAM" | "GMAIL" | null;
} {
  switch (sourceChannel) {
    case "WHATSAPP":
      return { orderSource: "WHATSAPP", shipmentCreatedVia: "CHAT", contactChannel: "WHATSAPP" };
    case "TELEGRAM":
      return { orderSource: "API", shipmentCreatedVia: "CHAT", contactChannel: "TELEGRAM" };
    case "GMAIL":
    case "EMAIL":
      return { orderSource: "EMAIL", shipmentCreatedVia: "EMAIL", contactChannel: "GMAIL" };
    case "WEB_FORM_ORDER":
      return { orderSource: "PORTAL", shipmentCreatedVia: "MANUAL", contactChannel: null };
    case "WEB_FORM_PLANNING":
      return { orderSource: "MANUAL", shipmentCreatedVia: "MANUAL", contactChannel: null };
    case "EXTERNAL_API":
      return { orderSource: "API", shipmentCreatedVia: "API", contactChannel: null };
    case "WEBSITE_CHAT":
    case "WIDGET":
    default:
      return { orderSource: "PORTAL", shipmentCreatedVia: "CHAT", contactChannel: "WIDGET" };
  }
}

export function classifyAutonomousIntent(
  message: string,
  intentHint?: AutonomousIntent,
  structured?: AutonomousStructuredInput,
): AutonomousIntent {
  if (intentHint) return intentHint;
  const lower = message.toLowerCase();

  if (/\b(damage|damaged|lost|stolen|missing cargo|delay|delayed|late|broken|complaint|refund|claim|accident|stuck|issue|problem)\b/i.test(lower)) {
    return "EXCEPTION_REPORT";
  }
  if (/\b(reroute|route|re-route|replan|re-plan|planning|optimize|optimise|corridor|vehicle|truck|schedule|dispatch|mode)\b/i.test(lower)) {
    return "PLANNING_ROUTING";
  }
  if (/\b(customs|hs code|clearance|manifest|waybill|bol|awb|pod|document|invoice|certificate)\b/i.test(lower)) {
    return /\b(invoice|payment|billing|charge|cost|fee|rate)\b/i.test(lower)
      ? "BILLING_INVOICE"
      : "CUSTOMS_DOCS";
  }
  if (/\b(invoice|billing|payment|overdue|charge|price|quote)\b/i.test(lower)) {
    return "BILLING_INVOICE";
  }
  if (
    Boolean(structured?.originCity && structured?.destinationCity) ||
    /\bfrom\s+[A-Za-z][A-Za-z\s,-]{1,38}?\s+to\s+[A-Za-z]/i.test(lower) ||
    /\b(book|create shipment|new shipment|new order|place order|send\s+\d+|send\s+cargo|deliver|dispatch|ship|transport|pickup from|deliver to|move\s+\d+)\b/i.test(
      lower,
    )
  ) {
    return "NEW_ORDER";
  }
  if (/\b(cancel|hold|reschedule|update address|change delivery|expedite|priority)\b/i.test(lower)) {
    return "SHIPMENT_ACTION";
  }
  return "TRACKING_INQUIRY";
}

export function extractOrderFieldsFromText(message: string): Partial<AutonomousStructuredInput> & {
  shipmentReference?: string;
} {
  const out: Partial<AutonomousStructuredInput> & { shipmentReference?: string } = {};
  // Support internal, WPCargo, and major international carrier reference formats:
  // LG-xxxxx, CX-xxxxxx, PO-YYYY-xxxx, DEMO-xxx, SHP-xxx, WPC-xxx, WP-TRK-xxx,
  // AWB/DHL/FX/UPS/FLT/TEST prefixed refs, ISO-6346 containers (e.g. MSKU1234567),
  // and explicit tracking/shipment numeric codes (e.g. "shipment 0576420").
  const prefixedRefMatch = message.match(
    /\b((?:LG|CX|DEMO|SHP|WPC|WP-TRK|AWB|DHL|FX|UPS|FLT|TEST)-[A-Z0-9]{2,12}|PO-\d{4}-\d{3,6}|[A-Z]{3}[UJZ]\d{7})\b/i,
  );
  if (prefixedRefMatch) {
    out.shipmentReference = prefixedRefMatch[1].toUpperCase();
  } else {
    const unitSuffixLookahead =
      "(?!\\s*(?:kg|kgs|kilograms?|g|lbs?|km|miles?|cartons?|boxes?|pallets?|units?|crates?|bags?|drums?|usd|ngn|eur)\\b)";
    const labeledRefMatch = message.match(
      new RegExp(
        `\\b(?:shipment|tracking(?:\\s+(?:number|no|id))?|waybill|awb|bol|ref(?:erence)?)\\s*(?:#|:|is)?\\s*([A-Z0-9][A-Z0-9-]{4,21})\\b${unitSuffixLookahead}`,
        "i",
      ),
    );
    if (labeledRefMatch && /\d/.test(labeledRefMatch[1])) {
      out.shipmentReference = labeledRefMatch[1].toUpperCase();
    } else {
      const actionRefMatch = message.match(
        new RegExp(
          `\\b(?:track|locate|find|status(?:\\s+of)?|check|where\\s+is)\\s*(?:#|:|is)?\\s*([A-Z0-9][A-Z0-9-]{5,21})\\b${unitSuffixLookahead}`,
          "i",
        ),
      );
      if (actionRefMatch && /\d/.test(actionRefMatch[1])) {
        out.shipmentReference = actionRefMatch[1].toUpperCase();
      }
    }
  }

  const fromToMatch = message.match(
    /\bfrom\s+([A-Za-z][A-Za-z\s,-]{1,38}?)\s+to\s+([A-Za-z][A-Za-z\s,-]{1,38}?)(?=[.,;!\n]|(?:\s+(?:by|before|with|weight|cargo|on|for|urgently|immediately|today|tomorrow|asap|please|now)\b)|$)/i,
  );
  if (fromToMatch) {
    out.originCity = fromToMatch[1].trim().replace(/,+$/, "");
    out.destinationCity = fromToMatch[2].trim().replace(/,+$/, "");
  }

  const weightMatch = message.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilograms?)\b/i);
  if (weightMatch) {
    out.weightKg = Number(weightMatch[1]);
  }

  const qtyMatch = message.match(/(\d+)\s*(?:cartons?|boxes?|pallets?|units?|crates?|bags?|drums?)\b/i);
  if (qtyMatch) {
    out.quantity = Number(qtyMatch[1]);
  }

  if (/\b(reefer|refrigerat|cold[- ]chain|frozen|chilled|temperature)\b/i.test(message)) {
    out.reefer = true;
  }
  if (/\b(hazmat|hazardous|flammable|chemical|dangerous goods)\b/i.test(message)) {
    out.hazmat = true;
  }

  // Extract shipper / sender and receiver / consignee details when provided in text
  const senderMatch = message.match(
    /\b(?:sender|shipper|from\s+contact)\s*(?::|-)?\s*([A-Za-z][A-Za-z .'-]{1,45})(?:\s*\(\s*([+\d][\d\s()-]{6,20})\s*\))?/i,
  );
  if (senderMatch) {
    out.shipperName = senderMatch[1].trim();
    if (senderMatch[2]) out.shipperPhone = senderMatch[2].trim();
  }
  const receiverMatch = message.match(
    /\b(?:receiver|recipient|consignee|to\s+contact)\s*(?::|-)?\s*([A-Za-z][A-Za-z .'-]{1,45})(?:\s*\(\s*([+\d][\d\s()-]{6,20})\s*\))?/i,
  );
  if (receiverMatch) {
    out.receiverName = receiverMatch[1].trim();
    if (receiverMatch[2]) out.receiverPhone = receiverMatch[2].trim();
  }
  const pickupAddrMatch = message.match(
    /\bpickup(?:\s+address)?\s*(?::|-)?\s*([^;\n.]{5,90})/i,
  );
  if (pickupAddrMatch) {
    out.originAddress = pickupAddrMatch[1].trim();
  }
  const deliveryAddrMatch = message.match(
    /\bdeliver(?:y)?(?:\s+address)?\s*(?::|-)?\s*([^;\n.]{5,90})/i,
  );
  if (deliveryAddrMatch) {
    out.destinationAddress = deliveryAddrMatch[1].trim();
  }
  return out;
}

export function selectDelegatedSpecialistsForIntent(
  intent: AutonomousIntent,
  taskText: string,
): CoreAgentId[] {
  const baseByIntent: Record<AutonomousIntent, CoreAgentId[]> = {
    NEW_ORDER: [
      "order-management",
      "warehouse-coordination",
      "shipment-management",
      "route-optimization",
    ],
    PLANNING_ROUTING: [
      "route-optimization",
      "fleet-management",
      "carrier-management",
    ],
    SHIPMENT_ACTION: [
      "shipment-management",
      "shipment-tracking",
      "customer-communication",
    ],
    EXCEPTION_REPORT: [
      "exception-resolution",
      "human-escalation",
      "customer-communication",
    ],
    CUSTOMS_DOCS: ["workflow-automation", "shipment-management", "human-escalation"],
    BILLING_INVOICE: ["financial-management", "carrier-management"],
    TRACKING_INQUIRY: ["shipment-tracking", "ai-customer-support"],
    FLEET_OPTIMIZE: [
      "route-optimization",
      "fleet-management",
      "shipment-tracking",
      "financial-management",
    ],
    APPROVAL_DECISION: [
      "human-escalation",
      "carrier-management",
      "financial-management",
      "shipment-management",
    ],
  };

  const merged = new Set<CoreAgentId>(baseByIntent[intent] ?? ["shipment-management"]);
  for (const s of selectOrchestratorSpecialists(taskText)) {
    merged.add(s.agentId);
  }
  return Array.from(merged).slice(0, 4);
}

export async function resolveDefaultOrgId(): Promise<string | null> {
  try {
    const rows = await identityQuery<{ id: string }>(
      `SELECT id FROM organisations WHERE active = true ORDER BY created_at ASC LIMIT 1`,
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

function generateOrderRef(): string {
  const suffix = Math.floor(1000 + Math.random() * 8999);
  return `PO-2026-${suffix}`;
}

function generateShipmentRef(): string {
  const suffix = Math.floor(10000 + Math.random() * 89999);
  return `LG-${suffix}`;
}

export async function dispatchToAutonomousAgent(
  input: AutonomousIntakeInput,
): Promise<AutonomousDispatchResult> {
  const effectiveOrgId = input.orgId ?? (await resolveDefaultOrgId());
  const textExtracted = extractOrderFieldsFromText(input.message);
  const structured: AutonomousStructuredInput = {
    ...textExtracted,
    ...(input.structured ?? {}),
    originCity: input.structured?.originCity?.trim() || textExtracted.originCity || null,
    destinationCity:
      input.structured?.destinationCity?.trim() || textExtracted.destinationCity || null,
    weightKg: input.structured?.weightKg ?? textExtracted.weightKg ?? null,
    quantity: input.structured?.quantity ?? textExtracted.quantity ?? null,
    hazmat: Boolean(input.structured?.hazmat ?? textExtracted.hazmat),
    reefer: Boolean(input.structured?.reefer ?? textExtracted.reefer),
  };

  const intent = classifyAutonomousIntent(input.message, input.intentHint, structured);
  const { orderSource, shipmentCreatedVia } = mapIntakeToSourceAndVia(input.sourceChannel);
  const delegatedAgents = selectDelegatedSpecialistsForIntent(intent, input.message);

  let orderReference: string | null = null;
  const requestedReference: string | null =
    input.reference?.trim().toUpperCase() || textExtracted.shipmentReference || null;
  let shipmentReference: string | null = requestedReference;
  let shipmentId: string | null = null;
  let draftSaved = false;
  let startedWork = false;
  let orchestrationSummary: string | null = null;
  let aiWarning: string | null = null;

  await runWithOrgScope(effectiveOrgId, async () => {
    // Resolve existing shipment for ANY reference format (LG-, CX-, WPCargo numeric,
    // DEMO-, ISO-6346 container, carrier AWB, or customer PO reference).
    if (shipmentReference) {
      try {
        const existing = await query<{ id: string; reference: string }>(
          `SELECT id, reference
             FROM shipments
            WHERE upper(reference) = $1 OR upper(customer_ref) = $1
            LIMIT 1`,
          [shipmentReference],
        );
        if (existing[0]) {
          shipmentId = existing[0].id;
          shipmentReference = existing[0].reference;
        } else {
          shipmentReference = null;
        }
      } catch {
        shipmentReference = null;
      }
    }

    const canCreateOrderAndShipment =
      !input.skipEntityCreation &&
      (intent === "NEW_ORDER" ||
        (intent === "PLANNING_ROUTING" && !shipmentId)) &&
      Boolean(structured.originCity && structured.destinationCity);

    if (canCreateOrderAndShipment) {
      orderReference = generateOrderRef();
      const candidateShipRef = generateShipmentRef();
      const quantity = structured.quantity ?? 1;
      const planEstimate = calculateShipmentPlan({
        originCity: structured.originCity,
        destinationCity: structured.destinationCity,
        weightKg: structured.weightKg,
        preferredMode: structured.preferredMode,
        deadlineIso: structured.deadlineIso,
        currency: structured.currency,
      });

      const rawOrder = {
        channel: input.sourceChannel,
        customerName:
          structured.customerName ||
          structured.shipperName ||
          input.displayName ||
          input.actorEmail ||
          "Direct Customer",
        customerEmail:
          structured.customerEmail || structured.shipperEmail || null,
        originCity: structured.originCity,
        destinationCity: structured.destinationCity,
        cargoDescription: structured.cargoDescription || input.message.slice(0, 120),
        weightKg: planEstimate.weightKg,
        quantity,
        itemsCount: quantity,
        hsCode: structured.hsCode || null,
        incoterm: structured.incoterm || null,
        notes: structured.notes || input.message.slice(0, 400),
      };

      // Upsert or resolve customer record when a real customer/shipper name is available
      let customerId: string | null = null;
      const custName = rawOrder.customerName.trim();
      if (custName && custName.toLowerCase() !== "direct customer") {
        try {
          const code = custName
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 18) || `CUST-${Math.floor(1000 + Math.random() * 8999)}`;
          const existingCust = await query<{ id: string }>(
            `SELECT id FROM customers WHERE lower(name) = lower($1) OR upper(code) = upper($2) LIMIT 1`,
            [custName, code],
          );
          if (existingCust[0]) {
            customerId = existingCust[0].id;
          } else {
            const insertedCust = await query<{ id: string }>(
              `INSERT INTO customers (code, name, default_currency, contacts)
               VALUES ($1, $2, $3, $4::jsonb)
               ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name
               RETURNING id`,
              [
                code,
                custName,
                planEstimate.currency,
                JSON.stringify([
                  {
                    name: custName,
                    email: rawOrder.customerEmail ?? undefined,
                    phone: structured.shipperPhone ?? undefined,
                    role: "primary",
                  },
                ]),
              ],
            );
            customerId = insertedCust[0]?.id ?? null;
          }
        } catch {
          customerId = null;
        }
      }

      const orderRows = await query<{ id: string; reference: string }>(
        `INSERT INTO orders (reference, state, source, currency, required_by, raw)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id, reference`,
        [
          orderReference,
          "VALIDATED",
          orderSource,
          planEstimate.currency,
          planEstimate.deadlineIso,
          JSON.stringify(rawOrder),
        ],
      );
      const orderId = orderRows[0]?.id ?? null;
      if (orderRows[0]?.reference) {
        orderReference = orderRows[0].reference;
      }

      if (orderId) {
        if (customerId) {
          await query(`UPDATE orders SET customer_id = $1 WHERE id = $2`, [
            customerId,
            orderId,
          ]).catch(() => {});
        }
        await query(
          `INSERT INTO order_items (order_id, line_no, sku, description, quantity)
           VALUES ($1, 1, 'DEFAULT', $2, $3)
           ON CONFLICT (order_id, line_no) DO NOTHING`,
          [orderId, rawOrder.cargoDescription, Math.max(1, Math.round(quantity))],
        ).catch(() => {});
      }

      const planPayload = {
        lane_label: `${structured.originCity} → ${structured.destinationCity}`,
        modes: [planEstimate.mode],
        preferred_mode: planEstimate.mode,
        distance_km: planEstimate.distanceKm,
        transit_hours: planEstimate.transitHours,
        estimated_cost_minor: planEstimate.estimatedCostMinor,
        currency: planEstimate.currency,
        co2e_kg: planEstimate.co2eKg,
        meets_deadline: planEstimate.meetsDeadline,
        routing_solver: "autonomous-orchestrator",
        requested_via: input.sourceChannel,
        notes: structured.notes || null,
        projected_delivery: planEstimate.projectedDeliveryIso,
      };

      const originObj: Record<string, unknown> = {
        city: structured.originCity,
        ...(structured.originAddress ? { address: structured.originAddress } : {}),
        ...(structured.originCountry ? { country: structured.originCountry } : {}),
        ...(structured.shipperName ? { contact_name: structured.shipperName } : {}),
        ...(structured.shipperPhone ? { contact_phone: structured.shipperPhone } : {}),
        ...(structured.shipperEmail ? { contact_email: structured.shipperEmail } : {}),
      };
      const destObj: Record<string, unknown> = {
        city: structured.destinationCity,
        ...(structured.destinationAddress ? { address: structured.destinationAddress } : {}),
        ...(structured.destinationCountry ? { country: structured.destinationCountry } : {}),
        ...(structured.receiverName ? { contact_name: structured.receiverName } : {}),
        ...(structured.receiverPhone ? { contact_phone: structured.receiverPhone } : {}),
        ...(structured.receiverEmail ? { contact_email: structured.receiverEmail } : {}),
      };

      const shipRows = await query<{ id: string; reference: string }>(
        `INSERT INTO shipments
           (reference, state, customer_ref, origin, destination, cargo, deadline, plan, created_via, origin_contact_id)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10)
         RETURNING id, reference`,
        [
          candidateShipRef,
          "ALLOCATED",
          orderReference,
          JSON.stringify(originObj),
          JSON.stringify(destObj),
          JSON.stringify({
            description: structured.cargoDescription || input.message.slice(0, 120),
            weight_kg: planEstimate.weightKg,
            quantity,
            preferred_mode: planEstimate.mode,
            ...(structured.hsCode ? { hs_code: structured.hsCode } : {}),
            ...(structured.incoterm ? { incoterm: structured.incoterm } : {}),
            hazmat: Boolean(structured.hazmat),
            reefer: Boolean(structured.reefer),
          }),
          planEstimate.deadlineIso,
          JSON.stringify(planPayload),
          shipmentCreatedVia,
          input.contactId ?? null,
        ],
      );

      if (shipRows[0]?.id && customerId) {
        await query(`UPDATE shipments SET customer_id = $1 WHERE id = $2`, [
          customerId,
          shipRows[0].id,
        ]).catch(() => {});
      }

      shipmentId = shipRows[0]?.id ?? null;
      shipmentReference = shipRows[0]?.reference ?? candidateShipRef;
      startedWork = true;

      if (shipmentId) {
        await query(
          `INSERT INTO shipment_events
             (shipment_id, seq, type, from_state, to_state, payload, actor)
           VALUES ($1, 1, $2, $3, $4, $5::jsonb, $6)`,
          [
            shipmentId,
            "order.received",
            null,
            "ALLOCATED",
            JSON.stringify({
              sourceChannel: input.sourceChannel,
              orderReference,
              delegatedAgents,
            }),
            "agent:orchestrator",
          ],
        );

        // Bridge directly into the autonomous Python worker pipeline:
        // 1. planning.plan -> NVIDIA cuOpt VRP + Nemotron advisory -> PLANNED -> carrier.source -> quotes -> book -> track -> POD -> close
        // 2. wpcargo.sync  -> publishes shipment on configured WordPress WPCargo portal asynchronously
        await query(
          `INSERT INTO work_items (shipment_id, kind, state, payload, priority, dedupe_key)
           VALUES ($1, 'planning.plan', 'PENDING', $2::jsonb, 10, $3)
           ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
          [
            shipmentId,
            JSON.stringify({
              sourceChannel: input.sourceChannel,
              orderReference,
              shipmentReference,
            }),
            `plan:${shipmentId}`,
          ],
        );
        await query(
          `INSERT INTO work_items (shipment_id, kind, state, payload, priority, dedupe_key)
           VALUES ($1, 'wpcargo.sync', 'PENDING', $2::jsonb, 20, $3)
           ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
          [
            shipmentId,
            JSON.stringify({
              sourceChannel: input.sourceChannel,
              orderReference,
              customerName: rawOrder.customerName,
              customerEmail: rawOrder.customerEmail,
            }),
            `wpcargo:${shipmentId}`,
          ],
        );
      }

      if (input.contactId && shipmentId) {
        await query(
          `UPDATE channel_contacts
              SET last_shipment_id = $1, draft = NULL, last_seen_at = now()
            WHERE id = $2`,
          [shipmentId, input.contactId],
        );
      }
    } else if (intent === "NEW_ORDER" && input.contactId) {
      // Partial order from chat channel: store progress on channel_contacts.draft
      const draftObj = {
        origin: structured.originCity ?? null,
        destination: structured.destinationCity ?? null,
        cargo: structured.cargoDescription ?? null,
        weight_kg: structured.weightKg ?? null,
        quantity: structured.quantity ?? null,
        missing: structured.missingFields ?? [],
        updated_via: input.sourceChannel,
      };
      await query(
        `UPDATE channel_contacts SET draft = $1::jsonb, last_seen_at = now() WHERE id = $2`,
        [JSON.stringify(draftObj), input.contactId],
      );
      draftSaved = true;
      startedWork = true;
    }

    if (
      (intent === "PLANNING_ROUTING" || intent === "SHIPMENT_ACTION") &&
      shipmentId &&
      !canCreateOrderAndShipment
    ) {
      const planUpdate = {
        reroute_requested: intent === "PLANNING_ROUTING",
        action_requested: intent === "SHIPMENT_ACTION",
        requested_via: input.sourceChannel,
        ...(structured.preferredMode ? { preferred_mode: structured.preferredMode } : {}),
        routing_notes: structured.notes || input.message.slice(0, 240),
        routing_solver: "autonomous-orchestrator",
        requested_at: new Date().toISOString(),
      };
      await query(
        `UPDATE shipments
            SET plan = COALESCE(plan, '{}'::jsonb) || $1::jsonb,
                updated_at = now()
          WHERE id = $2`,
        [JSON.stringify(planUpdate), shipmentId],
      );
      await query(
        `INSERT INTO shipment_events
           (shipment_id, seq, type, from_state, to_state, payload, actor)
         VALUES (
           $1,
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM shipment_events WHERE shipment_id = $1),
           $2, $3, $4, $5::jsonb, $6
         )`,
        [
          shipmentId,
          intent === "PLANNING_ROUTING"
            ? "route.replan_requested"
            : "shipment.action_requested",
          null,
          null,
          JSON.stringify({
            sourceChannel: input.sourceChannel,
            message: input.message.slice(0, 300),
            delegatedAgents,
          }),
          "agent:orchestrator",
        ],
      );
      if (intent === "PLANNING_ROUTING") {
        await query(
          `INSERT INTO work_items (shipment_id, kind, state, payload, priority, dedupe_key)
           VALUES ($1, 'planning.plan', 'PENDING', $2::jsonb, 10, $3)
           ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
          [
            shipmentId,
            JSON.stringify({
              sourceChannel: input.sourceChannel,
              preferredMode: structured.preferredMode ?? null,
              notes: structured.notes || input.message.slice(0, 240),
            }),
            `replan:${shipmentId}:${Math.floor(Date.now() / 15000)}`,
          ],
        );
      }
      startedWork = true;
    }

    if (intent === "EXCEPTION_REPORT" && shipmentId) {
      const summary = input.message.slice(0, 300);
      await query(
        `INSERT INTO exceptions (shipment_id, kind, severity, detected_by, summary, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (shipment_id, kind) WHERE state NOT IN ('RESOLVED', 'ABANDONED')
         DO UPDATE SET summary = EXCLUDED.summary,
                       detail = EXCLUDED.detail,
                       updated_at = now()`,
        [
          shipmentId,
          "CUSTOMER_REPORTED",
          "HIGH",
          "autonomous_intake",
          summary,
          JSON.stringify({
            sourceChannel: input.sourceChannel,
            summary,
          }),
        ],
      );
      await query(
        `INSERT INTO shipment_events
           (shipment_id, seq, type, from_state, to_state, payload, actor)
         VALUES (
           $1,
           (SELECT COALESCE(MAX(seq), 0) + 1 FROM shipment_events WHERE shipment_id = $1),
           $2, $3, $4, $5::jsonb, $6
         )`,
        [
          shipmentId,
          "exception.reported",
          null,
          null,
          JSON.stringify({
            sourceChannel: input.sourceChannel,
            message: summary,
          }),
          "agent:orchestrator",
        ],
      );
      await query(
        `INSERT INTO work_items (shipment_id, kind, state, payload, priority, dedupe_key)
         VALUES ($1, 'exception.investigate', 'PENDING', $2::jsonb, 5, $3)
         ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
        [
          shipmentId,
          JSON.stringify({
            sourceChannel: input.sourceChannel,
            kind: "CUSTOMER_REPORTED",
            summary,
          }),
          `exc-inv:${shipmentId}:${Math.floor(Date.now() / 15000)}`,
        ],
      );
      startedWork = true;
    }

    const hasUnresolvedTargetReference = Boolean(requestedReference && !shipmentId);

    // Record work delegation ledger items for the queue & support delegation views
    const shouldCreateDelegationWork =
      startedWork ||
      (!hasUnresolvedTargetReference && intent !== "TRACKING_INQUIRY") ||
      (input.sourceChannel !== "WIDGET" && Boolean(shipmentId));
    if (shouldCreateDelegationWork) {
      startedWork = true;
      const workKind =
        input.sourceChannel === "WHATSAPP" ||
          input.sourceChannel === "TELEGRAM" ||
          input.sourceChannel === "WIDGET" ||
          input.sourceChannel === "WEBSITE_CHAT"
          ? `support.delegated_${intent.toLowerCase()}`
          : `autonomous.${intent.toLowerCase()}`;

      await query(
        `INSERT INTO work_items (shipment_id, kind, state, payload, priority, dedupe_key)
         VALUES ($1, $2, 'DONE', $3::jsonb, 10, $4)
         ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
        [
          shipmentId,
          workKind,
          JSON.stringify({
            sourceChannel: input.sourceChannel,
            intent,
            orderReference,
            shipmentReference,
            delegatedAgents,
          }),
          `auto:${workKind}:${shipmentReference ?? input.externalId ?? "global"}:${Math.floor(Date.now() / 5000)}`,
        ],
      );
    }

    await recordAudit({
      actor: input.actorEmail || input.externalId || input.sourceChannel.toLowerCase(),
      actorType:
        input.sourceChannel === "EXTERNAL_API" ||
          input.sourceChannel === "WHATSAPP" ||
          input.sourceChannel === "TELEGRAM"
          ? "INTEGRATION"
          : "AGENT",
      orgId: effectiveOrgId,
      action: `AUTONOMOUS_${intent}`,
      entityType: shipmentReference ?? orderReference ?? input.sourceChannel,
      after: {
        sourceChannel: input.sourceChannel,
        intent,
        orderReference,
        shipmentReference,
        delegatedAgents,
      },
    });

    // Orchestrate with Gemini AI Orchestrator Agent (sync for forms/APIs, background for support chat)
    const orchestratorPrompt = [
      `Autonomous intake via ${input.sourceChannel} (${intent}).`,
      shipmentReference ? `Target shipment: ${shipmentReference}.` : "",
      orderReference ? `Order reference: ${orderReference}.` : "",
      structured.originCity && structured.destinationCity
        ? `Lane: ${structured.originCity} -> ${structured.destinationCity}.`
        : "",
      `Delegated specialists: ${delegatedAgents.join(", ")}.`,
      `Request: ${input.message.slice(0, 500)}`,
    ]
      .filter(Boolean)
      .join(" ");

    if (input.mode === "sync_orchestrate" && getServerGeminiKey()) {
      try {
        const execOut = await executeAgentTask({
          agentId: "orchestrator",
          task: orchestratorPrompt,
          reference: shipmentReference ?? undefined,
          actorEmail: input.actorEmail ?? "autonomous@control-tower",
          timeoutMs: 45_000,
        });
        orchestrationSummary = execOut.result.summary;
      } catch (err) {
        aiWarning = classifyGeminiError(err).message;
        scheduleBackgroundAgent({
          workflow: "background.orchestrate",
          orgId: effectiveOrgId,
          reference: shipmentReference ?? undefined,
          task: orchestratorPrompt,
          actorEmail: input.actorEmail ?? "autonomous@control-tower",
          workKind: `autonomous.${intent.toLowerCase()}`,
          cooldownMs: 30_000,
        });
      }
    } else if (
      getServerGeminiKey() &&
      (startedWork || (!hasUnresolvedTargetReference && intent !== "TRACKING_INQUIRY"))
    ) {
      scheduleBackgroundAgent({
        workflow: "background.orchestrate",
        orgId: effectiveOrgId,
        reference: shipmentReference ?? undefined,
        task: orchestratorPrompt,
        actorEmail: input.actorEmail ?? "autonomous@control-tower",
        workKind: `autonomous.${intent.toLowerCase()}`,
        cooldownMs: 15_000,
      });
    }
  });

  return {
    intent,
    startedWork,
    orderReference,
    shipmentReference,
    shipmentId,
    delegatedAgents,
    draftSaved,
    orchestrationSummary,
    aiWarning,
  };
}

export interface OmnichannelSupportTurnResult {
  ok: boolean;
  reply?: string;
  reference?: string | null;
  orderReference?: string | null;
  shouldEscalate?: boolean;
  autonomous?: AutonomousDispatchResult;
  error?: string;
}

/**
 * Single omnichannel entry point for the AI Customer Support Agent across:
 * Website Chat (/track & floating widget), WhatsApp, Telegram, and Email.
 * Every inbound message is answered safely AND routed to the backend Autonomous Agent.
 */
export async function processOmnichannelSupportTurn({
  sourceChannel,
  externalId,
  displayName,
  message,
  reference,
  orgId,
  actorEmail,
}: {
  sourceChannel: "WEBSITE_CHAT" | "WIDGET" | "WHATSAPP" | "TELEGRAM" | "GMAIL";
  externalId: string;
  displayName?: string | null;
  message: string;
  reference?: string | null;
  orgId: string | null;
  actorEmail?: string | null;
}): Promise<OmnichannelSupportTurnResult> {
  const trimmed = message.trim();
  if (!trimmed) {
    return { ok: false, error: "Type a message first." };
  }
  if (trimmed.length > 2000) {
    return { ok: false, error: "Message is too long (max 2000 characters)." };
  }

  const effectiveOrgId = orgId ?? (await resolveDefaultOrgId());
  const dbChannel =
    sourceChannel === "WEBSITE_CHAT" ? "WIDGET" : sourceChannel;
  const trimmedRef = reference?.trim().toUpperCase() || null;

  return runWithOrgScope(effectiveOrgId, async () => {
    let shipmentId: string | null = null;
    let resolvedRef: string | null = trimmedRef;

    // Auto-detect shipment reference in message; explicit reference in message overrides sticky session ref
    const extracted = extractOrderFieldsFromText(trimmed);
    const refCandidate = extracted.shipmentReference || resolvedRef || null;
    const callerPassedExplicitRef =
      Boolean(trimmedRef) &&
      (!extracted.shipmentReference || extracted.shipmentReference === trimmedRef);

    if (refCandidate) {
      const found = await query<{ id: string; reference: string }>(
        `SELECT id, reference
           FROM shipments
          WHERE upper(reference) = $1 OR upper(customer_ref) = $1
          LIMIT 1`,
        [refCandidate],
      );
      if (found[0]) {
        shipmentId = found[0].id;
        resolvedRef = found[0].reference;
      } else if (callerPassedExplicitRef) {
        return { ok: false, error: "We could not find that shipment reference." };
      } else {
        resolvedRef = null;
      }
    }

    const contactRes = await query<{
      id: string;
      last_shipment_id: string | null;
      draft: Record<string, unknown> | null;
    }>(
      `INSERT INTO channel_contacts (channel, external_id, display_name, last_shipment_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, channel, external_id) DO UPDATE
           SET last_seen_at = now(),
               display_name = COALESCE($3, channel_contacts.display_name),
               last_shipment_id = COALESCE($4, channel_contacts.last_shipment_id)
       RETURNING id, last_shipment_id, draft`,
      [dbChannel, externalId, displayName?.trim() || "Customer", shipmentId],
    );

    const contactId = contactRes[0]?.id;
    const effectiveShipmentId =
      shipmentId ?? (!refCandidate ? (contactRes[0]?.last_shipment_id ?? null) : null);

    if (!resolvedRef && effectiveShipmentId) {
      const refRow = await query<{ reference: string }>(
        `SELECT reference FROM shipments WHERE id = $1`,
        [effectiveShipmentId],
      );
      resolvedRef = refRow[0]?.reference ?? null;
    }

    // Touch channel_connections.last_inbound_at for WhatsApp/Telegram/Widget
    try {
      await query(
        `UPDATE channel_connections SET last_inbound_at = now() WHERE channel = $1`,
        [dbChannel],
      );
    } catch {
      // Non-fatal
    }

    await query(
      `INSERT INTO communications
          (shipment_id, contact_id, channel, direction, body, recipient, state, safety_checked)
       VALUES ($1, $2, $3, 'INBOUND', $4, $5, 'RECEIVED', false)`,
      [effectiveShipmentId, contactId ?? null, dbChannel, trimmed, externalId],
    );

    const historyRows = contactId
      ? await query<{ direction: string; body: string }>(
        `SELECT direction, body
             FROM communications
            WHERE contact_id = $1
            ORDER BY created_at ASC
            LIMIT 12`,
        [contactId],
      )
      : [];

    const history = historyRows.map((r) => ({
      role: r.direction === "INBOUND" ? "customer" : "agent",
      text: r.body,
    }));

    let aiReplyText: string | null = null;
    let shouldEscalate = false;
    let escalationReason: string | null = null;
    let handoff: SupportAutonomousHandoff | null = null;
    let aiError: string | null = null;

    if (!getServerGeminiKey()) {
      aiError = "No server AI provider key (NVIDIA_API_KEY / GEMINI_API_KEY) is configured.";
    } else {
      try {
        const aiRes = await runCustomerSupportWithGemini({
          reference: resolvedRef,
          shipmentId: effectiveShipmentId,
          question: trimmed,
          history,
          sourceChannel,
          draftContext: contactRes[0]?.draft ?? null,
        });
        aiReplyText = aiRes.reply;
        shouldEscalate = aiRes.shouldEscalate;
        escalationReason = aiRes.escalationReason;
        handoff = aiRes.autonomousHandoff;
      } catch (err) {
        aiError = classifyGeminiError(err).message;
      }
    }

    const fallbackIntent = classifyAutonomousIntent(trimmed, undefined, extracted);
    const isGreeting = /^(\/(start|help|menu)\b|hi\b|hello\b|hey\b|good\s+(morning|afternoon|evening)\b)/i.test(
      trimmed,
    );
    const isActionableFallback =
      fallbackIntent !== "TRACKING_INQUIRY" ||
      Boolean(extracted.originCity && extracted.destinationCity);

    let fallbackReply: string | null = null;
    if (aiError) {
      if (isGreeting) {
        let activeNote = "";
        if (resolvedRef && effectiveShipmentId) {
          const rows = await query<{
            reference: string;
            state: string;
            origin: Record<string, unknown>;
            destination: Record<string, unknown>;
          }>(
            `SELECT reference, state, origin, destination FROM shipments WHERE id = $1 LIMIT 1`,
            [effectiveShipmentId],
          );
          if (rows[0]) {
            const o = String(rows[0].origin?.city ?? "origin");
            const d = String(rows[0].destination?.city ?? "destination");
            activeNote = `\n\nYour latest shipment ${rows[0].reference} (${o} to ${d}) is currently ${rows[0].state.replace(/_/g, " ")}.`;
          }
        }
        fallbackReply =
          `Hello${displayName && !/^Telegram\s/i.test(displayName) ? ` ${displayName}` : ""}! Welcome to Logistics Support.\n\n` +
          `I can help you:\n` +
          `• Track a shipment (send a reference like LG-10421)\n` +
          `• Book a shipment (e.g. "Ship 500kg electronics from Rotterdam to Munich")\n` +
          `• Report a delay, damage, or customs issue${activeNote}`;
      } else if (fallbackIntent === "TRACKING_INQUIRY" && !refCandidate && !effectiveShipmentId) {
        const recent = await query<{
          reference: string;
          state: string;
          origin: Record<string, unknown>;
          destination: Record<string, unknown>;
        }>(
          `SELECT reference, state, origin, destination FROM shipments ORDER BY updated_at DESC LIMIT 3`,
        );
        if (recent.length > 0) {
          const list = recent
            .map(
              (r) =>
                `• ${r.reference} (${String(r.origin?.city ?? "?")} → ${String(r.destination?.city ?? "?")}): ${r.state.replace(/_/g, " ")}`,
            )
            .join("\n");
          fallbackReply = `Please share a shipment reference (like ${recent[0].reference}) so I can check exact details. Recent active shipments:\n${list}`;
        } else {
          fallbackReply =
            "I'm connected and ready to help. Share a shipment reference (e.g. LG-10421) to track cargo, or tell me your origin and destination cities to book a new shipment.";
        }
      }
    }

    // Hand off directly to the Autonomous Agent (creates orders/shipments/events/exceptions & delegates work immediately)
    const draftOrigin = (contactRes[0]?.draft?.origin as string | undefined) ?? null;
    const draftDest = (contactRes[0]?.draft?.destination as string | undefined) ?? null;
    const autonomousResult =
      isGreeting || (aiError && fallbackReply && !isActionableFallback)
        ? {
          intent: "TRACKING_INQUIRY" as AutonomousIntent,
          startedWork: false,
          orderReference: null,
          shipmentReference: resolvedRef,
          shipmentId: effectiveShipmentId,
          delegatedAgents: [] as CoreAgentId[],
          draftSaved: false,
          orchestrationSummary: null,
          aiWarning: aiError,
        }
        : await dispatchToAutonomousAgent({
          sourceChannel,
          intentHint: handoff?.intent ?? (aiError ? fallbackIntent : undefined),
          message: handoff?.taskSummary || trimmed,
          reference: handoff?.shipmentReference ?? resolvedRef ?? refCandidate,
          contactId: contactId ?? null,
          externalId,
          displayName: displayName ?? null,
          orgId: effectiveOrgId,
          actorEmail: actorEmail ?? null,
          mode: "background_orchestrate",
          structured: {
            originCity: handoff?.originCity ?? extracted.originCity ?? draftOrigin,
            destinationCity: handoff?.destinationCity ?? extracted.destinationCity ?? draftDest,
            cargoDescription: handoff?.cargoDescription ?? null,
            weightKg: handoff?.weightKg ?? extracted.weightKg ?? null,
            quantity: handoff?.quantity ?? extracted.quantity ?? null,
            deadlineIso: handoff?.deadlineIso ?? null,
            customerName: handoff?.customerName ?? displayName ?? null,
            hazmat: handoff?.hazmat ?? extracted.hazmat ?? false,
            reefer: handoff?.reefer ?? extracted.reefer ?? false,
            missingFields: handoff?.missingFields ?? [],
          },
        });

    const lookupRef = autonomousResult.shipmentReference ?? resolvedRef ?? refCandidate;
    const finalShipmentId = autonomousResult.shipmentId ?? effectiveShipmentId;
    const finalRef = finalShipmentId
      ? (autonomousResult.shipmentReference ?? resolvedRef ?? null)
      : null;
    let outboundReply: string;
    if (aiReplyText) {
      outboundReply =
        autonomousResult.orderReference &&
          finalRef &&
          !aiReplyText.includes(finalRef)
          ? `${aiReplyText} Your request has been queued under shipment ${finalRef} (order ${autonomousResult.orderReference}).`
          : aiReplyText;
    } else if (fallbackReply) {
      outboundReply = fallbackReply;
    } else if (autonomousResult.orderReference && finalRef) {
      outboundReply = `Your booking has been accepted and queued for dispatch under shipment ${finalRef} (order ${autonomousResult.orderReference}). Route planning and carrier allocation are underway.`;
    } else if (lookupRef) {
      // Deterministic allowlisted tracking fallback — never exposes buy rates/margins or internal errors.
      const tracked = await query<{
        reference: string;
        state: string;
        origin: Record<string, unknown> | null;
        destination: Record<string, unknown> | null;
        plan: Record<string, unknown> | null;
        booking: Record<string, unknown> | null;
      }>(
        `SELECT reference, state, origin, destination, plan, booking
           FROM shipments
          WHERE upper(reference) = $1
          LIMIT 1`,
        [lookupRef.toUpperCase()],
      ).catch(() => []);
      const row = tracked[0];
      if (row) {
        const fromCity = String(row.origin?.city ?? row.origin?.address ?? "origin");
        const toCity = String(row.destination?.city ?? row.destination?.address ?? "destination");
        const eta = typeof row.plan?.projected_delivery === "string"
          ? ` Estimated arrival: ${row.plan.projected_delivery}.`
          : "";
        const carrier = typeof row.booking?.carrier_code === "string"
          ? ` Assigned carrier: ${row.booking.carrier_code}.`
          : "";
        outboundReply =
          autonomousResult.intent === "EXCEPTION_REPORT"
            ? `We have logged your issue report for shipment ${row.reference} (${fromCity} to ${toCity}, currently ${row.state.toLowerCase().replace(/_/g, " ")}) and alerted our operations team for immediate review.`
            : `Shipment ${row.reference} (${fromCity} to ${toCity}) is currently ${row.state.toLowerCase().replace(/_/g, " ")}.${carrier}${eta}`;
      } else if (autonomousResult.startedWork && autonomousResult.intent !== "TRACKING_INQUIRY") {
        outboundReply = `Your request (${autonomousResult.intent.toLowerCase().replace(/_/g, " ")}) for shipment ${lookupRef} has been logged and routed to our operations team.`;
      } else {
        outboundReply = `I could not locate shipment ${lookupRef}. Please verify the reference number or share your pickup and delivery cities to start a new booking.`;
      }
    } else if (autonomousResult.startedWork) {
      outboundReply = `Your request (${autonomousResult.intent.toLowerCase().replace(/_/g, " ")}) has been logged and routed to our operations team.`;
    } else {
      outboundReply =
        "Please share your shipment tracking reference (for example LG-82931 or your WPCargo tracking number), or tell me the pickup city, destination city, cargo, and weight to book a new shipment.";
    }

    await query(
      `INSERT INTO communications
          (shipment_id, contact_id, channel, direction, body, recipient, state, safety_checked)
       VALUES ($1, $2, $3, 'OUTBOUND', $4, $5, 'SENT', true)`,
      [finalShipmentId, contactId ?? null, dbChannel, outboundReply, externalId],
    );

    if (shouldEscalate && contactId) {
      await query(
        `UPDATE channel_contacts
            SET escalated_at = now(), escalation_reason = $1
          WHERE id = $2`,
        [escalationReason ?? "Customer requested escalation", contactId],
      );
    }

    return {
      ok: true,
      reply: outboundReply,
      reference: finalRef,
      orderReference: autonomousResult.orderReference,
      shouldEscalate,
      autonomous: autonomousResult,
    };
  });
}
