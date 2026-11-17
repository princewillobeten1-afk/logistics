import { query } from "@/lib/db";
import {
  activePolicy,
  deadWork,
  getEvents,
  getLegs,
  getQuotes,
  getShipment,
  laneStats,
  latestRates,
  legStats,
  listCarriers,
  listCommunications,
  listConveyances,
  listCustomers,
  listCustoms,
  listDocuments,
  listDrivers,
  listInventory,
  listOrders,
  listShipments,
  listWarehouses,
  modelUsage,
  openApprovals,
  openExceptions,
  overviewStats,
  queueStats,
  shipmentCounts,
  throughput,
} from "@/lib/queries";
import type { CoreAgentId } from "./catalog";

function safeIso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function summarizeShipment(s: Awaited<ReturnType<typeof listShipments>>[number]) {
  return {
    reference: s.reference,
    state: s.state,
    customer: s.customer_ref,
    origin: s.origin?.city ?? s.origin?.address ?? null,
    destination: s.destination?.city ?? s.destination?.address ?? null,
    cargo: s.cargo,
    deadline: safeIso(s.deadline),
    plan: s.plan
      ? {
          modes: s.plan.modes,
          distance_km: s.plan.distance_km,
          transit_hours: s.plan.transit_hours,
          estimated_cost_minor: s.plan.estimated_cost_minor,
          currency: s.plan.currency,
          meets_deadline: s.plan.meets_deadline,
          vehicle: s.plan.vehicle ?? s.plan.assigned_vehicle ?? null,
          customs_required: s.plan.customs_required ?? false,
        }
      : null,
    booking: s.booking
      ? {
          carrier_code: s.booking.carrier_code,
          amount_minor: s.booking.amount_minor,
          currency: s.booking.currency,
        }
      : null,
    updated_at: safeIso(s.updated_at) ?? new Date().toISOString(),
  };
}

export async function gatherOperationalContext(
  agentId: CoreAgentId,
  shipmentReference?: string,
): Promise<{
  snapshot: Record<string, unknown>;
  shipmentId: string | null;
  resolvedReference: string | null;
}> {
  const [stats, counts, queue] = await Promise.all([
    overviewStats(),
    shipmentCounts(),
    queueStats(),
  ]);

  let targetShipment: Awaited<ReturnType<typeof getShipment>> | null = null;
  let targetDetails: Record<string, unknown> | null = null;

  if (shipmentReference?.trim()) {
    targetShipment = await getShipment(shipmentReference.trim());
    if (targetShipment) {
      const [events, legs, quotes] = await Promise.all([
        getEvents(targetShipment.id),
        getLegs(targetShipment.id),
        getQuotes(targetShipment.id),
      ]);
      targetDetails = {
        shipment: summarizeShipment(targetShipment),
        allocation: targetShipment.allocation,
        events: events.slice(-15).map((e) => ({
          seq: e.seq,
          type: e.type,
          from_state: e.from_state,
          to_state: e.to_state,
          actor: e.actor,
          payload: e.payload,
          at: safeIso(e.created_at) ?? new Date().toISOString(),
        })),
        legs: legs.map((l) => ({
          sequence: l.sequence,
          mode: l.mode,
          state: l.state,
          distance_km: l.distance_km,
          cost_minor: l.cost_minor,
          currency: l.currency,
          co2e_kg: l.co2e_kg,
          metadata: l.metadata,
        })),
        quotes: quotes.map((q) => ({
          carrier_code: q.carrier_code,
          carrier_name: q.carrier_name,
          state: q.state,
          amount_minor: q.amount_minor,
          currency: q.currency,
          transit_hours: q.transit_hours,
          confidence: q.confidence,
          score: q.score,
          raw_text: q.raw_text,
        })),
      };
    }
  }

  const base: Record<string, unknown> = {
    overview: stats,
    shipmentCountsByState: counts,
    workQueueByState: queue,
    ...(targetDetails ? { focusShipment: targetDetails } : {}),
  };

  if (
    agentId === "orchestrator" ||
    agentId === "exception-resolution" ||
    agentId === "human-escalation"
  ) {
    const [shipments, exceptions, approvals, dead, policy] = await Promise.all([
      listShipments(),
      openExceptions(),
      openApprovals(),
      deadWork(),
      activePolicy(),
    ]);
    base.activeShipments = shipments.slice(0, 8).map(summarizeShipment);
    base.openExceptions = exceptions.slice(0, 8);
    base.pendingApprovals = approvals.slice(0, 8);
    base.stalledDeadWork = dead.slice(0, 6);
    base.activePolicy = policy;
  }

  if (agentId === "shipment-management" || agentId === "shipment-tracking") {
    const [shipments, exceptions, documents, customs] = await Promise.all([
      listShipments(),
      openExceptions(),
      listDocuments(),
      listCustoms(),
    ]);
    base.shipments = shipments.slice(0, 10).map(summarizeShipment);
    base.openExceptions = exceptions.slice(0, 8);
    base.unverifiedDocuments = documents.filter((d) => !d.verified_at).slice(0, 8);
    base.customsDeclarations = customs.slice(0, 8);
  }

  if (agentId === "route-optimization" || agentId === "fleet-management") {
    const [shipments, conveyances, drivers, legs, lanes] = await Promise.all([
      listShipments(),
      listConveyances(),
      listDrivers(),
      legStats(),
      laneStats(),
    ]);
    base.planningAndTransitShipments = shipments
      .filter((s) => !["CLOSED", "CANCELLED", "FAILED"].includes(s.state))
      .slice(0, 18)
      .map(summarizeShipment);
    base.conveyances = conveyances;
    base.drivers = drivers;
    base.legStatsByMode = legs;
    base.topLanes = lanes.slice(0, 10);
  }

  if (agentId === "carrier-management") {
    const [carriers, approvals, shipments] = await Promise.all([
      listCarriers(),
      openApprovals(),
      listShipments(),
    ]);
    base.carriers = carriers;
    base.pendingApprovals = approvals;
    base.sourcingShipments = shipments
      .filter((s) => ["SOURCING", "AWAITING_APPROVAL", "PLANNED"].includes(s.state))
      .slice(0, 10)
      .map(summarizeShipment);
  }

  if (agentId === "order-management" || agentId === "warehouse-coordination") {
    const [orders, drafts, warehouses, inventory] = await Promise.all([
      listOrders(),
      listShipments("DRAFT"),
      listWarehouses(),
      listInventory(),
    ]);
    base.orders = orders.slice(0, 20);
    base.draftShipments = drafts.slice(0, 15).map(summarizeShipment);
    base.warehouses = warehouses;
    base.inventory = inventory;
  }

  if (agentId === "ai-customer-support" || agentId === "customer-communication") {
    const [customers, communications, threads, shipments] = await Promise.all([
      listCustomers(),
      listCommunications(),
      query<{
        id: string;
        channel: string;
        display_name: string | null;
        escalated_at: Date | null;
        escalation_reason: string | null;
        draft: Record<string, unknown> | null;
        last_seen_at: Date;
      }>(
        `SELECT id, channel, display_name, escalated_at, escalation_reason, draft, last_seen_at
           FROM channel_contacts ORDER BY last_seen_at DESC LIMIT 20`,
      ),
      listShipments(),
    ]);
    base.customers = customers;
    base.recentCommunications = communications.slice(0, 20);
    base.supportThreads = threads;
    base.customerSafeShipments = shipments.slice(0, 15).map((s) => ({
      reference: s.reference,
      state: s.state,
      customer: s.customer_ref,
      origin: s.origin?.city ?? null,
      destination: s.destination?.city ?? null,
      deadline: safeIso(s.deadline),
      carrier: s.booking?.carrier_code ?? null,
    }));
  }

  if (agentId === "financial-management" || agentId === "logistics-analytics") {
    const [shipments, legs, rates, policy, approvals, usage, daily, carriers] =
      await Promise.all([
        listShipments(),
        legStats(),
        latestRates(),
        activePolicy(),
        openApprovals(),
        modelUsage(),
        throughput(),
        listCarriers(),
      ]);
    base.shipments = shipments.slice(0, 20).map(summarizeShipment);
    base.legStatsByMode = legs;
    base.fxRates = rates;
    base.activePolicy = policy;
    base.pendingApprovals = approvals;
    base.modelUsageLast24h = usage;
    base.throughputLast14d = daily;
    base.carriers = carriers;
  }

  if (agentId === "workflow-automation") {
    const [documents, customs, dead, policy, usage] = await Promise.all([
      listDocuments(),
      listCustoms(),
      deadWork(),
      activePolicy(),
      modelUsage(),
    ]);
    base.documents = documents.slice(0, 20);
    base.customs = customs.slice(0, 20);
    base.stalledDeadWork = dead;
    base.activePolicy = policy;
    base.modelUsageLast24h = usage;
  }

  return {
    snapshot: base,
    shipmentId: targetShipment?.id ?? null,
    resolvedReference: targetShipment?.reference ?? null,
  };
}
