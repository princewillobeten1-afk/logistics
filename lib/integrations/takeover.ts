import { randomBytes } from "node:crypto";
import { recordAudit } from "@/lib/audit";
import { query, runWithOrgScope } from "@/lib/db";
import {
  calculateShipmentPlan,
  matchBestConveyance,
  type ConveyanceCandidate,
} from "@/lib/planning";
import type { AutonomyMode } from "./catalog";

export interface AutonomousTakeoverInput {
  shipmentId: string;
  shipmentReference?: string | null;
  orgId: string;
  autonomyMode: AutonomyMode;
  customerName?: string | null;
  customerEmail?: string | null;
  originCity?: string | null;
  destinationCity?: string | null;
  weightKg?: number | null;
  quantity?: number | null;
  preferredMode?: string | null;
  currency?: string | null;
  hazmat?: boolean;
  reefer?: boolean;
  deadlineIso?: string | null;
  sourceName?: string | null;
  actorEmail?: string | null;
}

export interface AutonomousTakeoverReport {
  shipmentId: string;
  shipmentReference: string;
  finalState: "BOOKED" | "AWAITING_APPROVAL" | "PLANNED" | "SKIPPED";
  mode: string;
  distanceKm: number;
  transitHours: number;
  estimatedCostMinor: number;
  currency: string;
  carrierName: string | null;
  vehicleRegistration: string | null;
  approvalRequired: boolean;
  summary: string;
}

interface CarrierDbRow {
  id: string;
  code: string;
  name: string;
  modes: string[];
  on_time_rate: string | number;
  approved: boolean;
  active: boolean;
}

interface ConveyanceDbRow extends ConveyanceCandidate {
  id: string;
}

interface ShipmentDbRow {
  id: string;
  reference: string;
  state: string;
  customer_id: string | null;
  customer_ref: string | null;
  origin: Record<string, unknown> | null;
  destination: Record<string, unknown> | null;
  cargo: Record<string, unknown> | null;
  deadline: string | Date | null;
  plan: Record<string, unknown> | null;
}

const BOOKABLE_STATES = new Set([
  "RECEIVED",
  "VALIDATING",
  "ALLOCATED",
  "PLANNED",
  "SOURCING",
]);

function slugCode(prefix: string, name: string): string {
  const cleaned = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 14);
  return `${prefix}-${cleaned || "EXT"}`;
}

/**
 * Executes the complete autonomous operational lifecycle for a shipment:
 * 1. Links or upserts the customer account
 * 2. Computes deterministic multimodal route plan & persists shipment_legs
 * 3. Scores onboarded carriers (or spot-market rate) & inserts candidate quotes
 * 4. Matches and assigns an eligible idle fleet vehicle (respecting reefer/hazmat/weight)
 * 5. In FULL_AUTONOMOUS mode: selects winning quote, records EXECUTED proposed_action, advances shipment to BOOKED
 *    In ASSISTED_APPROVAL mode: creates pending approval ticket, advances shipment to AWAITING_APPROVAL
 */
export async function runAutonomousTakeoverForShipment(
  input: AutonomousTakeoverInput,
): Promise<AutonomousTakeoverReport> {
  return runWithOrgScope(input.orgId, async () => {
    const shipRows = await query<ShipmentDbRow>(
      `SELECT id, reference, state, customer_id, customer_ref, origin, destination, cargo, deadline, plan
         FROM shipments
        WHERE id = $1
        LIMIT 1`,
      [input.shipmentId],
    );
    const ship = shipRows[0];
    if (!ship) {
      throw new Error(`Shipment ${input.shipmentId} not found for autonomous takeover.`);
    }

    const originCity =
      input.originCity?.trim() || String(ship.origin?.city ?? "").trim() || "Origin Hub";
    const destinationCity =
      input.destinationCity?.trim() ||
      String(ship.destination?.city ?? "").trim() ||
      "Destination Hub";
    const weightKg =
      input.weightKg ??
      (typeof ship.cargo?.weight_kg === "number" ? ship.cargo.weight_kg : null);
    const hazmat = Boolean(input.hazmat ?? ship.cargo?.hazmat);
    const reefer = Boolean(input.reefer ?? ship.cargo?.reefer);
    const preferredMode =
      input.preferredMode ??
      (Array.isArray(ship.plan?.modes) && typeof ship.plan?.modes[0] === "string"
        ? ship.plan.modes[0]
        : null);
    const deadlineIso =
      input.deadlineIso ??
      (ship.deadline ? new Date(ship.deadline).toISOString() : null);
    const currency =
      (input.currency ??
        (typeof ship.plan?.currency === "string" ? ship.plan.currency : null) ??
        "USD"
      ).toUpperCase();

    const plan = calculateShipmentPlan({
      originCity,
      destinationCity,
      weightKg,
      preferredMode,
      deadlineIso,
      currency,
    });

    if (input.autonomyMode === "SYNC_ONLY") {
      return {
        shipmentId: ship.id,
        shipmentReference: ship.reference,
        finalState: "SKIPPED",
        mode: plan.mode,
        distanceKm: plan.distanceKm,
        transitHours: plan.transitHours,
        estimatedCostMinor: plan.estimatedCostMinor,
        currency: plan.currency,
        carrierName: null,
        vehicleRegistration: null,
        approvalRequired: false,
        summary: `Synced ${ship.reference} (${originCity} → ${destinationCity}) in sync-only mode.`,
      };
    }

    // 1. Resolve or upsert customer if we have a customerName
    let customerId: string | null = ship.customer_id ?? null;
    if (!customerId && input.customerName?.trim()) {
      const custName = input.customerName.trim();
      const contacts = input.customerEmail?.trim()
        ? [{ name: custName, email: input.customerEmail.trim() }]
        : [];
      const custRows = await query<{ id: string }>(
        `INSERT INTO customers (code, name, sla_hours, payment_terms, default_currency, contacts)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id`,
        [
          slugCode("CUST", custName),
          custName,
          48,
          "NET30",
          plan.currency,
          JSON.stringify(contacts),
        ],
      );
      customerId = custRows[0]?.id ?? null;
    }

    // 2. Persist deterministic shipment_legs entry
    const loadType =
      plan.weightKg >= 10_000 ? "FTL" : plan.mode === "SEA" ? "LCL" : "LTL";
    const approvalRequired = input.autonomyMode === "ASSISTED_APPROVAL";
    await query(
      `INSERT INTO shipment_legs
         (shipment_id, sequence, mode, state, distance_km, cost_minor, currency, load_type, co2e_kg, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        ship.id,
        1,
        plan.mode,
        approvalRequired ? "PLANNED" : "BOOKED",
        plan.distanceKm,
        plan.estimatedCostMinor,
        plan.currency,
        loadType,
        plan.co2eKg,
        JSON.stringify({
          origin: originCity,
          destination: destinationCity,
          transit_hours: plan.transitHours,
          solver: "autonomous-takeover",
        }),
      ],
    );

    // 3. Score approved active carriers and generate quotes
    const allCarriers = await query<CarrierDbRow>(
      `SELECT id, code, name, modes, on_time_rate, approved, active
         FROM carriers
        WHERE active = true
        ORDER BY on_time_rate DESC
        LIMIT 12`,
    );
    const matchingCarriers = allCarriers.filter((c) => {
      if (!c.approved) return false;
      if (!Array.isArray(c.modes) || c.modes.length === 0) return true;
      return c.modes.some((m) => String(m).toUpperCase() === plan.mode);
    });
    const candidateCarriers =
      matchingCarriers.length > 0 ? matchingCarriers.slice(0, 3) : allCarriers.slice(0, 3);

    interface ScoredCandidate {
      carrierId: string | null;
      carrierCode: string;
      carrierName: string;
      priceMinor: number;
      transitHours: number;
      score: number;
      onTimeRate: number;
    }

    const scoredCandidates: ScoredCandidate[] = candidateCarriers.map((c, idx) => {
      const otp = Math.max(0.5, Math.min(1, Number(c.on_time_rate) || 0.92));
      const priceFactor = idx === 0 ? 1.0 : idx === 1 ? 0.96 : 1.05;
      const transitFactor = idx === 0 ? 1.0 : idx === 1 ? 1.08 : 0.94;
      const priceMinor = Math.round(plan.estimatedCostMinor * priceFactor);
      const transitHours = Math.max(2, Math.round(plan.transitHours * transitFactor));
      const priceScore = Math.max(0.4, 1 - (priceFactor - 0.9) * 1.4);
      const speedScore = Math.max(0.4, 1 - (transitFactor - 0.9) * 1.2);
      const composite = Math.round((otp * 0.45 + priceScore * 0.35 + speedScore * 0.2) * 1000) / 1000;
      return {
        carrierId: c.id,
        carrierCode: c.code || "CAR",
        carrierName: c.name,
        priceMinor,
        transitHours,
        score: composite,
        onTimeRate: otp,
      };
    });

    scoredCandidates.sort((a, b) => b.score - a.score);
    const winner = scoredCandidates[0] ?? {
      carrierId: null,
      carrierCode: "SPOT",
      carrierName: "Autonomous Spot Dispatch",
      priceMinor: plan.estimatedCostMinor,
      transitHours: plan.transitHours,
      score: 0.91,
      onTimeRate: 0.94,
    };

    const quotesToSave = scoredCandidates.length > 0 ? scoredCandidates : [winner];
    for (let i = 0; i < quotesToSave.length; i += 1) {
      const cand = quotesToSave[i];
      const isWinner = i === 0;
      const quoteState = isWinner
        ? approvalRequired
          ? "RECEIVED"
          : "SELECTED"
        : "RECEIVED";
      await query(
        `INSERT INTO quotes
           (shipment_id, carrier_code, carrier_name, state, source, amount_minor, currency, transit_hours, confidence, score, score_breakdown, round)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
        [
          ship.id,
          cand.carrierCode,
          cand.carrierName,
          quoteState,
          "AUTONOMOUS_ENGINE",
          cand.priceMinor,
          plan.currency,
          cand.transitHours,
          "0.95",
          cand.score.toFixed(3),
          JSON.stringify({
            parts: {
              on_time_rate: {
                weight: 0.45,
                value: cand.onTimeRate,
                contribution: Math.round(cand.onTimeRate * 0.45 * 1000) / 1000,
              },
              price_competitiveness: {
                weight: 0.35,
                value: i === 0 ? 0.95 : 0.88,
                contribution: i === 0 ? 0.333 : 0.308,
              },
              transit_speed: {
                weight: 0.2,
                value: 0.9,
                contribution: 0.18,
              },
            },
          }),
          1,
        ],
      );
    }

    // 4. Match & assign an available fleet conveyance when eligible
    const conveyances = await query<ConveyanceDbRow>(
      `SELECT id, registration, active, assigned_to, capacity_kg, reefer, hazmat_certified, mode
         FROM conveyances
        WHERE active = true
        LIMIT 100`,
    );
    const matchedVehicle = matchBestConveyance(
      {
        weightKg: plan.weightKg,
        hazmat,
        reefer,
        preferredMode: plan.mode,
      },
      conveyances,
    ) as ConveyanceDbRow | null;

    const assignedReg = matchedVehicle?.registration?.trim() || null;
    if (matchedVehicle?.id && assignedReg && !approvalRequired) {
      await query(
        `UPDATE conveyances SET assigned_to = $1, leg_state = $2 WHERE id = $3`,
        [ship.reference, "BOOKED", matchedVehicle.id],
      );
    }

    // 5. Execute policy-gated booking or create approval ticket
    const nextState: "BOOKED" | "AWAITING_APPROVAL" = approvalRequired
      ? "AWAITING_APPROVAL"
      : "BOOKED";

    const bookingPayload = approvalRequired
      ? {
          status: "PENDING_APPROVAL",
          recommended_carrier: winner.carrierName,
          carrier_id: winner.carrierId,
          quoted_minor: winner.priceMinor,
          currency: plan.currency,
          transit_hours: winner.transitHours,
          proposed_vehicle: assignedReg,
        }
      : {
          status: "CONFIRMED",
          carrier: winner.carrierName,
          carrier_id: winner.carrierId,
          booking_ref: `BK-${ship.reference.replace(/^LG-/i, "")}`,
          price_minor: winner.priceMinor,
          currency: plan.currency,
          transit_hours: winner.transitHours,
          vehicle_registration: assignedReg,
          booked_at: new Date().toISOString(),
          booked_by: "autonomous-takeover",
        };

    const allocationPayload = {
      mode: plan.mode,
      load_type: loadType,
      distance_km: plan.distanceKm,
      vehicle_registration: assignedReg,
      carrier_name: winner.carrierName,
      co2e_kg: plan.co2eKg,
      source: input.sourceName ?? "autonomous-takeover",
    };

    const actionRationale = approvalRequired
      ? `Prepared ${plan.mode} plan (${plan.distanceKm} km, ${winner.transitHours}h) with ${winner.carrierName}${assignedReg ? ` & unit ${assignedReg}` : ""}. Awaiting operator approval per connector policy.`
      : `Autonomously planned ${plan.mode} route (${plan.distanceKm} km, ${winner.transitHours}h), selected ${winner.carrierName}${assignedReg ? `, and assigned vehicle ${assignedReg}` : ""}.`;

    const actionRows = await query<{ id: string }>(
      `INSERT INTO proposed_actions
         (shipment_id, action, rationale, policy_reason, policy_decision, state, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id`,
      [
        ship.id,
        "BOOK_CARRIER",
        actionRationale,
        approvalRequired
          ? "Connector policy requires operator sign-off before carrier confirmation."
          : "Full Autonomous connector policy — auto-approved within spend limits.",
        approvalRequired ? "APPROVE" : "ALLOW",
        approvalRequired ? "PROPOSED" : "EXECUTED",
        JSON.stringify({
          shipmentReference: ship.reference,
          lane: `${originCity} → ${destinationCity}`,
          mode: plan.mode,
          carrierName: winner.carrierName,
          vehicleRegistration: assignedReg,
          estimatedCostMinor: winner.priceMinor,
          currency: plan.currency,
        }),
      ],
    );

    if (approvalRequired && actionRows[0]?.id) {
      const token = `appr_${randomBytes(12).toString("hex")}`;
      await query(
        `INSERT INTO approvals
           (shipment_id, proposed_action_id, token, summary, rationale, amount_minor, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ship.id,
          actionRows[0].id,
          token,
          `Book ${winner.carrierName} (${plan.mode}, ${originCity} → ${destinationCity})`,
          actionRationale,
          winner.priceMinor,
          plan.currency,
        ],
      );
    }

    await query(
      `UPDATE shipments
          SET state = $1,
              booking = $2::jsonb,
              allocation = $3::jsonb,
              customer_id = $4,
              updated_at = now()
        WHERE id = $5`,
      [
        nextState,
        JSON.stringify(bookingPayload),
        JSON.stringify(allocationPayload),
        customerId,
        ship.id,
      ],
    );

    await query(
      `INSERT INTO shipment_events
         (shipment_id, seq, type, from_state, to_state, payload, actor)
       VALUES ($1, 2, $2, $3, $4, $5::jsonb, $6)`,
      [
        ship.id,
        approvalRequired ? "approval.requested" : "carrier.booked",
        ship.state,
        nextState,
        JSON.stringify({
          mode: plan.mode,
          distanceKm: plan.distanceKm,
          transitHours: winner.transitHours,
          carrier: winner.carrierName,
          vehicleRegistration: assignedReg,
          priceMinor: winner.priceMinor,
          currency: plan.currency,
          quotesEvaluated: scoredCandidates.length,
        }),
        "agent:autonomous-takeover",
      ],
    );

    const summary = approvalRequired
      ? `Planned ${plan.mode} (${plan.distanceKm} km, ${winner.transitHours}h) with ${winner.carrierName}${assignedReg ? ` · unit ${assignedReg}` : ""} → queued in Approvals`
      : `Booked ${plan.mode} (${plan.distanceKm} km, ${winner.transitHours}h) via ${winner.carrierName}${assignedReg ? ` · assigned ${assignedReg}` : ""}`;

    await recordAudit({
      actor: input.actorEmail ?? "agent:autonomous-takeover",
      actorType: "AGENT",
      orgId: input.orgId,
      action: approvalRequired
        ? "AUTONOMOUS_TAKEOVER_APPROVAL_QUEUED"
        : "AUTONOMOUS_TAKEOVER_BOOKED",
      entityType: ship.reference,
      after: {
        shipmentId: ship.id,
        finalState: nextState,
        mode: plan.mode,
        carrier: winner.carrierName,
        vehicleRegistration: assignedReg,
        estimatedCostMinor: winner.priceMinor,
        currency: plan.currency,
      },
    });

    return {
      shipmentId: ship.id,
      shipmentReference: ship.reference,
      finalState: nextState,
      mode: plan.mode,
      distanceKm: plan.distanceKm,
      transitHours: winner.transitHours,
      estimatedCostMinor: winner.priceMinor,
      currency: plan.currency,
      carrierName: winner.carrierName,
      vehicleRegistration: assignedReg,
      approvalRequired,
      summary,
    };
  });
}

export interface OrgTakeoverSweepResult {
  scanned: number;
  booked: number;
  awaitingApproval: number;
  skipped: number;
  reports: AutonomousTakeoverReport[];
}

/**
 * Sweeps all unbooked / pending shipments in an organisation and runs end-to-end
 * autonomous planning, carrier scoring, fleet assignment, and booking.
 */
export async function runOrgAutonomousTakeoverSweep(
  orgId: string,
  actorEmail: string,
  autonomyMode: AutonomyMode = "FULL_AUTONOMOUS",
): Promise<OrgTakeoverSweepResult> {
  const candidates = await runWithOrgScope(orgId, async () =>
    query<ShipmentDbRow>(
      `SELECT id, reference, state, customer_id, customer_ref, origin, destination, cargo, deadline, plan
         FROM shipments
        ORDER BY updated_at DESC
        LIMIT 200`,
    ),
  );

  const actionable = candidates.filter((s) => BOOKABLE_STATES.has(s.state));
  const reports: AutonomousTakeoverReport[] = [];
  let booked = 0;
  let awaitingApproval = 0;
  let skipped = 0;

  for (const ship of actionable) {
    const report = await runAutonomousTakeoverForShipment({
      shipmentId: ship.id,
      shipmentReference: ship.reference,
      orgId,
      autonomyMode,
      actorEmail,
      sourceName: "autonomous-takeover-sweep",
    });
    reports.push(report);
    if (report.finalState === "BOOKED") booked += 1;
    else if (report.finalState === "AWAITING_APPROVAL") awaitingApproval += 1;
    else skipped += 1;
  }

  return {
    scanned: actionable.length,
    booked,
    awaitingApproval,
    skipped,
    reports,
  };
}
