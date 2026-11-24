import { query } from "@/lib/db";

export type ShipmentRow = {
  id: string;
  reference: string;
  state: string;
  version: number;
  customer_ref: string | null;
  origin: Record<string, unknown>;
  destination: Record<string, unknown>;
  cargo: Record<string, unknown>;
  deadline: Date | null;
  allocation: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  booking: Record<string, unknown> | null;
  created_via?: string;
  created_at: Date;
  updated_at: Date;
};

export type EventRow = {
  seq: number;
  type: string;
  from_state: string | null;
  to_state: string | null;
  payload: Record<string, unknown>;
  actor: string;
  created_at: Date;
};

export type LegRow = {
  sequence: number;
  mode: string;
  state: string;
  distance_km: string | null;
  cost_minor: string | null;
  currency: string | null;
  load_type: string | null;
  co2e_kg: string | null;
  metadata: Record<string, unknown>;
};

export type AgentRunRow = {
  id: string;
  agent: string;
  job: string;
  model: string;
  status: string;
  latency_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: Date;
  reference: string | null;
  response: { reasoning?: string | null; text?: string } | null;
};

// Active = not yet closed out. Everything the operations floor still owns.
const ACTIVE = `state NOT IN ('CLOSED','CANCELLED','FAILED')`;

export async function shipmentCounts() {
  const rows = await query<{ state: string; n: string }>(
    `SELECT state, count(*)::text AS n FROM shipments GROUP BY state`,
  );
  return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
}

export async function overviewStats() {
  const [row] = await query<{
    active: string;
    waiting_on_customer: string;
    awaiting_approval: string;
    in_exception: string;
    deadline_at_risk: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE ${ACTIVE})::text                        AS active,
       count(*) FILTER (WHERE state = 'NEEDS_INFO')::text             AS waiting_on_customer,
       count(*) FILTER (WHERE state = 'AWAITING_APPROVAL')::text      AS awaiting_approval,
       count(*) FILTER (WHERE state = 'EXCEPTION')::text              AS in_exception,
       count(*) FILTER (WHERE ${ACTIVE}
                          AND deadline IS NOT NULL
                          AND deadline < now() + interval '24 hours')::text AS deadline_at_risk
     FROM shipments`,
  );
  return {
    active: Number(row?.active ?? 0),
    waitingOnCustomer: Number(row?.waiting_on_customer ?? 0),
    awaitingApproval: Number(row?.awaiting_approval ?? 0),
    inException: Number(row?.in_exception ?? 0),
    deadlineAtRisk: Number(row?.deadline_at_risk ?? 0),
  };
}

export async function queueStats() {
  const rows = await query<{ state: string; n: string }>(
    `SELECT state, count(*)::text AS n FROM work_items GROUP BY state`,
  );
  return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
}

/** Items that have exhausted their retries. Each one is a stalled shipment. */
export async function deadWork() {
  return query<{
    id: string;
    kind: string;
    attempts: number;
    last_error: string | null;
    reference: string | null;
  }>(
    `SELECT w.id, w.kind, w.attempts, w.last_error, s.reference
       FROM work_items w
       LEFT JOIN shipments s ON s.id = w.shipment_id
      WHERE w.state = 'DEAD'
      ORDER BY w.updated_at DESC
      LIMIT 25`,
  );
}

export async function listShipments(state?: string) {
  const where = state ? `WHERE state = $1` : "";
  return query<ShipmentRow>(
    `SELECT id, reference, state, version, customer_ref, origin, destination,
            cargo, deadline, allocation, plan, booking, created_at, updated_at,
            created_via
       FROM shipments ${where}
      ORDER BY updated_at DESC
      LIMIT 100`,
    state ? [state] : [],
  );
}

export async function getShipment(reference: string) {
  const [row] = await query<ShipmentRow>(
    `SELECT id, reference, state, version, customer_ref, origin, destination,
            cargo, deadline, allocation, plan, booking, created_at, updated_at
       FROM shipments WHERE reference = $1`,
    [reference],
  );
  return row ?? null;
}

export async function getEvents(shipmentId: string) {
  return query<EventRow>(
    `SELECT seq, type, from_state, to_state, payload, actor, created_at
       FROM shipment_events WHERE shipment_id = $1 ORDER BY seq`,
    [shipmentId],
  );
}

export async function getLegs(shipmentId: string) {
  return query<LegRow>(
    `SELECT sequence, mode, state, distance_km, cost_minor, currency,
            load_type, co2e_kg, metadata
       FROM shipment_legs WHERE shipment_id = $1 ORDER BY sequence`,
    [shipmentId],
  );
}

export async function recentAgentRuns(limit = 50) {
  return query<AgentRunRow>(
    `SELECT a.id, a.agent, a.job, a.model, a.status, a.latency_ms,
            a.prompt_tokens, a.completion_tokens, a.created_at,
            a.response, s.reference
       FROM agent_runs a
       LEFT JOIN shipments s ON s.id = a.shipment_id
      ORDER BY a.created_at DESC
      LIMIT $1`,
    [limit],
  );
}

export type ActivityRow = {
  kind: "MODEL" | "EVENT" | "TOOL" | "GATE";
  at: Date;
  actor: string;
  action: string;
  reason: string | null;
  result: string | null;
  reference: string | null;
  detail: Record<string, unknown> | null;
};

/**
 * One timeline across the four tables that record what the system did (§25).
 *
 * They are separate tables for good reasons and none replaces the others —
 * `agent_runs` is what a model did, `shipment_events` what happened to a
 * shipment, `tool_calls` what left the building, `proposed_actions` what the
 * gate decided. But reading them separately means reconstructing the order of
 * events by eye across four screens, and the question people actually ask is
 * "what happened, in order". Hence the union.
 *
 * Each branch normalises to the same five columns so the feed can render one
 * row shape: when, who, what, why, and what came of it.
 */
export async function activityFeed(limit = 120, kinds?: string[]) {
  return query<ActivityRow>(
    `WITH feed AS (
       SELECT 'MODEL'  AS kind, a.created_at AS at,
              a.agent  AS actor, a.job AS action,
              a.model  AS reason,
              a.status || CASE WHEN a.latency_ms IS NULL THEN ''
                               ELSE ' · ' || a.latency_ms || 'ms' END AS result,
              s.reference,
              jsonb_build_object('tokens_out', a.completion_tokens,
                                 'reasoning', a.response -> 'reasoning') AS detail
         FROM agent_runs a
         LEFT JOIN shipments s ON s.id = a.shipment_id

       UNION ALL

       SELECT 'EVENT', e.created_at,
              COALESCE(e.actor, 'system'), e.type,
              NULL,
              -- The transition is the single most useful thing in a timeline;
              -- leaving it inside payload means nobody reads it.
              CASE WHEN e.to_state IS NULL THEN NULL
                   ELSE COALESCE(e.from_state, '-') || ' -> ' || e.to_state END,
              s.reference, e.payload
         FROM shipment_events e
         JOIN shipments s ON s.id = e.shipment_id

       UNION ALL

       SELECT 'TOOL', t.created_at,
              'tool', t.tool,
              'tier ' || t.tier,
              t.state || COALESCE(' · ' || t.error, ''),
              s.reference, t.request
         FROM tool_calls t
         LEFT JOIN shipments s ON s.id = t.shipment_id

       UNION ALL

       -- The gate's own record. Without it, "the agent did not book" and "the
       -- agent was stopped from booking" look identical in the timeline.
       --
       -- The actor comes from the linked run, not from the rationale. The
       -- rationale is free text — parsing its first word for an agent name
       -- produced rows attributed to "Loss", the first word of a sentence
       -- describing a damaged consignment.
       SELECT 'GATE', p.created_at,
              COALESCE(r.agent, 'agent'), p.action,
              p.policy_reason, p.policy_decision || ' · ' || p.state,
              s.reference, p.params
         FROM proposed_actions p
         JOIN shipments s ON s.id = p.shipment_id
         LEFT JOIN agent_runs r ON r.id = p.agent_run_id
     )
     SELECT * FROM feed
      WHERE ($2::text[] IS NULL OR kind = ANY($2))
      ORDER BY at DESC
      LIMIT $1`,
    [limit, kinds && kinds.length > 0 ? kinds : null],
  );
}

/** Model spend and latency for the last 24h — the cost thesis, measured. */
export async function modelUsage() {
  return query<{
    job: string;
    model: string;
    calls: string;
    avg_latency: string | null;
    total_out: string | null;
    failures: string;
  }>(
    `SELECT job, model,
            count(*)::text                                   AS calls,
            round(avg(latency_ms))::text                      AS avg_latency,
            sum(completion_tokens)::text                      AS total_out,
            count(*) FILTER (WHERE status <> 'OK')::text      AS failures
       FROM agent_runs
      WHERE created_at > now() - interval '24 hours'
      GROUP BY job, model
      ORDER BY count(*) DESC`,
  );
}

export type QuoteRow = {
  id: string;
  carrier_code: string;
  carrier_name: string;
  state: string;
  source: string;
  amount_minor: string | null;
  currency: string | null;
  transit_hours: string | null;
  confidence: string | null;
  raw_text: string | null;
  parsed_by: string | null;
  score: string | null;
  score_breakdown: {
    parts?: Record<string, { weight: number; value: number; contribution: number }>;
  } | null;
  round: number;
};

/** Quotes for a shipment's latest sourcing round.
 *  `score` is read, never recomputed — carriers/scoring.py is canonical, so
 *  the score that spends money is the score shown here. */
export async function getQuotes(shipmentId: string) {
  return query<QuoteRow>(
    `SELECT q.id, c.code AS carrier_code, c.name AS carrier_name, q.state,
            q.source, q.amount_minor, q.currency, q.transit_hours, q.confidence,
            q.raw_text, q.parsed_by, q.score, q.score_breakdown, q.round
       FROM quotes q JOIN carriers c ON c.id = q.carrier_id
      WHERE q.shipment_id = $1
        AND q.round = (SELECT max(round) FROM quotes WHERE shipment_id = $1)
      ORDER BY q.score DESC NULLS LAST, q.amount_minor NULLS LAST`,
    [shipmentId],
  );
}

export async function openApprovals() {
  return query<{
    id: string;
    token: string;
    summary: string;
    amount_minor: string | null;
    currency: string;
    requested_at: Date;
    expires_at: Date;
    reference: string | null;
    rationale: string | null;
    proposed_action_id: string;
  }>(
    `SELECT ap.id, ap.token, ap.summary, ap.amount_minor, ap.currency,
            ap.requested_at, ap.expires_at, s.reference,
            pa.rationale, ap.proposed_action_id
       FROM approvals ap
       LEFT JOIN shipments s ON s.id = ap.shipment_id
       LEFT JOIN proposed_actions pa ON pa.id = ap.proposed_action_id
      WHERE ap.state = 'PENDING'
      ORDER BY ap.requested_at`,
  );
}

// --------------------------------------------------------------- network

export async function listCarriers() {
  return query<{
    id: string;
    code: string;
    name: string;
    modes: string[];
    integration: string;
    approved: boolean;
    active: boolean;
    on_time_rate: string | null;
    damage_rate: string | null;
    availability_rate: string | null;
    service_score: string | null;
    shipments_count: number | null;
  }>(
    `SELECT c.id, c.code, c.name, c.modes, c.integration, c.approved, c.active,
            p.on_time_rate, p.damage_rate, p.availability_rate, p.service_score,
            p.shipments_count
       FROM carriers c
       LEFT JOIN carrier_performance p
              ON p.carrier_id = c.id
             AND p.origin_region IS NULL
             AND p.destination_region IS NULL
             AND p.mode IS NULL
      ORDER BY c.approved DESC, c.code`,
  );
}

export async function listWarehouses() {
  return query<{
    id: string;
    code: string;
    name: string;
    dispatch_lead_hours: string;
    handles_hazmat: boolean;
    handles_reefer: boolean;
    active: boolean;
    city: string | null;
    country: string | null;
    latitude: string | null;
    longitude: string | null;
    skus: string | null;
    on_hand: string | null;
    reserved: string | null;
  }>(
    `SELECT w.id, w.code, w.name, w.dispatch_lead_hours, w.handles_hazmat,
            w.handles_reefer, w.active,
            l.city, l.country, l.latitude, l.longitude,
            count(i.id)::text        AS skus,
            sum(i.on_hand)::text     AS on_hand,
            sum(i.reserved)::text    AS reserved
       FROM warehouses w
       LEFT JOIN locations l ON l.id = w.location_id
       LEFT JOIN inventory i ON i.warehouse_id = w.id
      GROUP BY w.id, l.city, l.country, l.latitude, l.longitude
      ORDER BY w.code`,
  );
}

export async function listInventory() {
  return query<{
    warehouse: string;
    sku: string;
    on_hand: number;
    reserved: number;
    available: number;
  }>(
    `SELECT w.code AS warehouse, i.sku, i.on_hand, i.reserved,
            (i.on_hand - i.reserved) AS available
       FROM inventory i JOIN warehouses w ON w.id = i.warehouse_id
      ORDER BY w.code, i.sku`,
  );
}

export async function listLocations() {
  return query<{
    id: string;
    type: string;
    name: string;
    code: string | null;
    city: string | null;
    country: string | null;
    latitude: string | null;
    longitude: string | null;
  }>(
    `SELECT id, type, name, code, city, country, latitude, longitude
       FROM locations
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY type, name`,
  );
}

// --------------------------------------------------------------- records

export async function listOrders() {
  return query<{
    id: string;
    reference: string;
    state: string;
    source: string;
    currency: string;
    ordered_at: Date;
    required_by: Date | null;
    customer: string | null;
    items: string;
  }>(
    `SELECT o.id, o.reference, o.state, o.source, o.currency, o.ordered_at,
            o.required_by, c.name AS customer, count(i.id)::text AS items
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN order_items i ON i.order_id = o.id
      GROUP BY o.id, c.name
      ORDER BY o.ordered_at DESC
      LIMIT 100`,
  );
}

export async function listCommunications() {
  return query<{
    id: string;
    channel: string;
    direction: string;
    recipient: string | null;
    subject: string | null;
    body: string | null;
    state: string;
    safety_checked: boolean;
    created_at: Date;
    reference: string | null;
  }>(
    `SELECT m.id, m.channel, m.direction, m.recipient, m.subject, m.body,
            m.state, m.safety_checked, m.created_at, s.reference
       FROM communications m
       LEFT JOIN shipments s ON s.id = m.shipment_id
      ORDER BY m.created_at DESC
      LIMIT 100`,
  );
}

export async function listDocuments() {
  return query<{
    id: string;
    kind: string;
    direction: string;
    filename: string | null;
    extraction_model: string | null;
    extraction_confidence: string | null;
    verified_at: Date | null;
    created_at: Date;
    reference: string | null;
  }>(
    `SELECT d.id, d.kind, d.direction, d.filename, d.extraction_model,
            d.extraction_confidence, d.verified_at, d.created_at, s.reference
       FROM documents d
       LEFT JOIN shipments s ON s.id = d.shipment_id
      ORDER BY d.created_at DESC
      LIMIT 100`,
  );
}

export async function listCustoms() {
  return query<{
    id: string;
    direction: string;
    clearance_state: string;
    hs_codes: string[];
    broker: string | null;
    submitted_at: Date | null;
    reference: string | null;
  }>(
    `SELECT cd.id, cd.direction, cd.clearance_state, cd.hs_codes, cd.broker,
            cd.submitted_at, s.reference
       FROM customs_declarations cd
       LEFT JOIN shipments s ON s.id = cd.shipment_id
      ORDER BY cd.created_at DESC
      LIMIT 50`,
  );
}

export async function auditLogs(limit = 50) {
  return query<{
    id: string;
    actor: string;
    actor_type: string;
    action: string;
    entity_type: string | null;
    created_at: Date;
  }>(
    `SELECT id, actor, actor_type, action, entity_type, created_at
       FROM audit_logs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}

// -------------------------------------------------------------- analytics

/** Lane volumes taken from the planned itinerary, not guessed from geography. */
// ------------------------------------------------------------- customers

export type CustomerRow = {
  id: string;
  code: string;
  name: string;
  sla_hours: number | null;
  payment_terms: string | null;
  default_currency: string;
  contacts: { name?: string; email?: string; phone?: string }[];
  active: boolean;
  total: string;
  open: string;
  late: string;
  last_shipment_at: Date | null;
};

export async function listCustomers() {
  return query<CustomerRow>(
    `SELECT c.id, c.code, c.name, c.sla_hours, c.payment_terms,
            c.default_currency, c.contacts, c.active,
            count(s.id)::text                                        AS total,
            count(s.id) FILTER (WHERE s.state NOT IN
              ('CLOSED','CANCELLED','FAILED'))::text                 AS open,
            -- Late means past the promised time and not yet delivered. A
            -- shipment delivered late is a service failure worth counting
            -- separately; this column is the one operations can still act on.
            count(s.id) FILTER (WHERE s.deadline < now() AND s.state NOT IN
              ('DELIVERED','POD_VERIFIED','CLOSED','CANCELLED','FAILED'))::text AS late,
            max(s.created_at)                                        AS last_shipment_at
       FROM customers c
       LEFT JOIN shipments s ON s.customer_id = c.id
      GROUP BY c.id
      ORDER BY c.active DESC, count(s.id) DESC, c.name`,
  );
}

export async function getCustomer(code: string) {
  const [row] = await query<CustomerRow>(
    `SELECT c.id, c.code, c.name, c.sla_hours, c.payment_terms,
            c.default_currency, c.contacts, c.active,
            count(s.id)::text AS total,
            count(s.id) FILTER (WHERE s.state NOT IN
              ('CLOSED','CANCELLED','FAILED'))::text AS open,
            count(s.id) FILTER (WHERE s.deadline < now() AND s.state NOT IN
              ('DELIVERED','POD_VERIFIED','CLOSED','CANCELLED','FAILED'))::text AS late,
            max(s.created_at) AS last_shipment_at
       FROM customers c
       LEFT JOIN shipments s ON s.customer_id = c.id
      WHERE upper(c.code) = upper($1)
      GROUP BY c.id`,
    [code],
  );
  return row ?? null;
}

export async function customerShipments(customerId: string, limit = 40) {
  return query<{
    reference: string;
    state: string;
    origin: Record<string, unknown> | null;
    destination: Record<string, unknown> | null;
    deadline: Date | null;
    created_at: Date;
    overdue: boolean;
  }>(
    `SELECT reference, state, origin, destination, deadline, created_at,
            (deadline < now() AND state NOT IN
              ('DELIVERED','POD_VERIFIED','CLOSED','CANCELLED','FAILED')) AS overdue
       FROM shipments
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [customerId, limit],
  );
}

export async function customerMessages(customerId: string, limit = 25) {
  return query<{
    channel: string;
    direction: string;
    body: string | null;
    created_at: Date;
    reference: string | null;
  }>(
    `SELECT m.channel, m.direction, m.body, m.created_at, s.reference
       FROM communications m
       LEFT JOIN shipments s ON s.id = m.shipment_id
      WHERE m.customer_id = $1 OR s.customer_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [customerId, limit],
  );
}

// ----------------------------------------------------------------- fleet

export type ConveyanceRow = {
  id: string;
  mode: string;
  kind: string | null;
  registration: string | null;
  carrier_code: string | null;
  carrier_name: string | null;
  capacity_kg: string | null;
  capacity_cbm: string | null;
  reefer: boolean;
  hazmat_certified: boolean;
  active: boolean;
  assigned_to: string | null;
  leg_state: string | null;
  last_seen_at: Date | null;
  last_lat: string | null;
  last_lon: string | null;
  last_speed: string | null;
};

/**
 * Vehicles, with what each is currently carrying and where it last reported.
 *
 * The assignment comes from `shipment_legs`, which is where a vehicle is
 * actually committed to work — a conveyance row on its own says a truck
 * exists, not that anyone can use it today.
 */
export async function listConveyances() {
  return query<ConveyanceRow>(
    `SELECT v.id, v.mode, v.kind,
            v.identifiers->>'registration' AS registration,
            c.code AS carrier_code, c.name AS carrier_name,
            v.capacity_kg::text, v.capacity_cbm::text,
            v.reefer, v.hazmat_certified, v.active,
            active_leg.reference AS assigned_to,
            active_leg.leg_state,
            ping.occurred_at AS last_seen_at,
            ping.latitude::text  AS last_lat,
            ping.longitude::text AS last_lon,
            ping.speed_kph::text AS last_speed
       FROM conveyances v
       LEFT JOIN carriers c ON c.id = v.carrier_id
       LEFT JOIN LATERAL (
         SELECT s.reference, l.state AS leg_state, l.shipment_id
           FROM shipment_legs l
           JOIN shipments s ON s.id = l.shipment_id
          WHERE l.conveyance_id = v.id
            AND l.state NOT IN ('COMPLETED','CANCELLED')
          ORDER BY l.sequence
          LIMIT 1
       ) active_leg ON true
       LEFT JOIN LATERAL (
         SELECT t.occurred_at, t.latitude, t.longitude, t.speed_kph
           FROM tracking_events t
          WHERE t.shipment_id = active_leg.shipment_id
            AND t.latitude IS NOT NULL
          ORDER BY t.occurred_at DESC
          LIMIT 1
       ) ping ON true
      ORDER BY v.active DESC, c.code NULLS LAST, registration`,
  );
}

export type DriverRow = {
  id: string;
  name: string;
  phone: string | null;
  licence_number: string | null;
  licence_expiry: Date | null;
  hazmat_certified: boolean;
  active: boolean;
  carrier_code: string | null;
  carrier_name: string | null;
  assigned_to: string | null;
  days_to_expiry: string | null;
};

export async function listDrivers() {
  return query<DriverRow>(
    `SELECT d.id, d.name, d.phone, d.licence_number, d.licence_expiry,
            d.hazmat_certified, d.active,
            c.code AS carrier_code, c.name AS carrier_name,
            active_leg.reference AS assigned_to,
            -- Licence expiry is a dispatch constraint, not paperwork: an
            -- expired driver cannot legally take the load.
            (d.licence_expiry - current_date)::text AS days_to_expiry
       FROM drivers d
       LEFT JOIN carriers c ON c.id = d.carrier_id
       LEFT JOIN LATERAL (
         SELECT s.reference
           FROM shipment_legs l
           JOIN shipments s ON s.id = l.shipment_id
          WHERE l.driver_id = d.id
            AND l.state NOT IN ('COMPLETED','CANCELLED')
          ORDER BY l.sequence
          LIMIT 1
       ) active_leg ON true
      ORDER BY d.active DESC, c.code NULLS LAST, d.name`,
  );
}

export async function laneStats() {
  return query<{ lane: string; shipments: string; avg_km: string | null }>(
    `SELECT plan->>'lane_label' AS lane, count(*)::text AS shipments, NULL AS avg_km
       FROM shipments WHERE plan ? 'lane_label' GROUP BY 1
     UNION ALL
     SELECT concat(origin->>'city', ' → ', destination->>'city') AS lane,
            count(*)::text AS shipments,
            round(avg((plan->>'distance_km')::numeric))::text AS avg_km
       FROM shipments
      WHERE origin ? 'city' AND destination ? 'city'
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 20`,
  );
}

export async function legStats() {
  return query<{
    mode: string;
    legs: string;
    total_km: string | null;
    total_co2e: string | null;
  }>(
    `SELECT mode, count(*)::text AS legs,
            round(sum(distance_km))::text AS total_km,
            round(sum(co2e_kg), 1)::text  AS total_co2e
       FROM shipment_legs GROUP BY mode ORDER BY count(*) DESC`,
  );
}

export async function throughput() {
  return query<{ day: string; created: string; closed: string }>(
    `SELECT to_char(d.day, 'Mon DD') AS day,
            count(s.id) FILTER (WHERE date_trunc('day', s.created_at) = d.day)::text AS created,
            count(s.id) FILTER (WHERE s.state = 'CLOSED'
                                  AND date_trunc('day', s.updated_at) = d.day)::text AS closed
       FROM generate_series(date_trunc('day', now()) - interval '13 days',
                            date_trunc('day', now()), interval '1 day') AS d(day)
       LEFT JOIN shipments s ON true
      GROUP BY d.day ORDER BY d.day`,
  );
}

// --------------------------------------------------------------- settings

export async function activePolicy() {
  const [row] = await query<{
    version: number;
    name: string;
    rules: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT version, name, rules, created_at FROM policies
      WHERE active ORDER BY version DESC LIMIT 1`,
  );
  return row ?? null;
}

export async function currencies() {
  return query<{ code: string; name: string; minor_unit_exponent: number }>(
    `SELECT code, name, minor_unit_exponent FROM currencies ORDER BY code`,
  );
}

export async function latestRates() {
  return query<{
    base: string;
    quote: string;
    rate: string;
    as_of: Date;
    source: string;
  }>(
    `SELECT DISTINCT ON (base, quote) base, quote, rate, as_of, source
       FROM fx_rates ORDER BY base, quote, as_of DESC`,
  );
}

export async function migrations() {
  return query<{ version: string; applied_at: Date }>(
    `SELECT version, applied_at FROM schema_migrations ORDER BY version`,
  );
}

export async function openExceptions() {
  return query<{
    id: string;
    kind: string;
    severity: string;
    detected_by: string;
    detail: Record<string, unknown>;
    created_at: Date;
    reference: string | null;
  }>(
    `SELECT e.id, e.kind, e.severity, e.detected_by, e.detail, e.created_at,
            s.reference
       FROM exceptions e
       LEFT JOIN shipments s ON s.id = e.shipment_id
      WHERE e.state <> 'RESOLVED'
      ORDER BY array_position(ARRAY['CRITICAL','HIGH','MEDIUM','LOW'], e.severity),
               e.created_at DESC`,
  );
}

export type ControlTowerKpis = {
  activeShipments: number;
  totalShipments: number;
  quotesGenerated: number;
  quotesSelected: number;
  aiConversations: number;
  delayedOrAttention: number;
  conversionRatePct: number;
  freightValueMinor: number;
  currency: string;
};

export type QuoteBookingPoint = {
  label: string;
  bookings: number;
  quotes: number;
};

export type ModeVolumePoint = {
  label: string;
  sea: number;
  air: number;
  road: number;
};

export type ControlTowerShipmentItem = ShipmentRow & {
  carrier_name: string | null;
  carrier_code: string | null;
  primary_mode: "SEA" | "AIR" | "ROAD" | "RAIL";
  distance_km: number | null;
  transit_hours: number | null;
  last_lat: number | null;
  last_lon: number | null;
  last_speed: number | null;
  vehicle_label: string | null;
};

export async function controlTowerSummary(): Promise<{
  kpis: ControlTowerKpis;
  quoteBookingTrend: QuoteBookingPoint[];
  modeVolumeTrend: ModeVolumePoint[];
  todayQuoteBookingTrend: QuoteBookingPoint[];
  todayModeVolumeTrend: ModeVolumePoint[];
  shipments: ControlTowerShipmentItem[];
  locations: Awaited<ReturnType<typeof listLocations>>;
}> {
  const [stats, counts, shipments, locations, conveyances, legRows, quoteRows, commsCountRows, agentRows] =
    await Promise.all([
      overviewStats(),
      shipmentCounts(),
      listShipments(),
      listLocations(),
      listConveyances(),
      query<{
        shipment_id: string;
        sequence: number;
        mode: string;
        state: string;
        distance_km: string | null;
        cost_minor: string | null;
        currency: string | null;
      }>(
        `SELECT shipment_id, sequence, mode, state, distance_km, cost_minor, currency
           FROM shipment_legs
          ORDER BY sequence`,
      ),
      query<{
        id: string;
        shipment_id: string;
        state: string;
        amount_minor: string | null;
        currency: string | null;
        carrier_name: string | null;
      }>(
        `SELECT q.id, q.shipment_id, q.state, q.amount_minor, q.currency, c.name AS carrier_name
           FROM quotes q
           LEFT JOIN carriers c ON c.id = q.carrier_id`,
      ),
      query<{ n: string }>(`SELECT count(*)::text AS n FROM communications`),
      query<{ n: string }>(`SELECT count(*)::text AS n FROM agent_runs`),
    ]);

  const totalShipments = Object.values(counts).reduce((a, b) => a + b, 0);
  const quotesGenerated = quoteRows.length;
  const quotesSelected = quoteRows.filter((q) => q.state === "SELECTED").length;
  const aiConversations =
    Number(commsCountRows[0]?.n ?? 0) + Number(agentRows[0]?.n ?? 0);
  const delayedOrAttention =
    stats.inException + stats.deadlineAtRisk + stats.awaitingApproval;

  const convertedStates = new Set([
    "BOOKED",
    "IN_TRANSIT",
    "DELIVERED",
    "POD_VERIFIED",
    "CLOSED",
  ]);
  const convertedCount = shipments.filter((s) =>
    convertedStates.has(s.state),
  ).length;
  const conversionRatePct =
    totalShipments > 0 ? Math.round((convertedCount / totalShipments) * 100) : 0;

  let freightValueMinor = 0;
  for (const s of shipments) {
    const est = Number((s.plan as Record<string, unknown> | null)?.estimated_cost_minor ?? 0);
    if (Number.isFinite(est) && est > 0) {
      freightValueMinor += est;
    }
  }
  if (freightValueMinor === 0) {
    for (const q of quoteRows) {
      freightValueMinor += Number(q.amount_minor ?? 0) || 0;
    }
  }

  const legsByShipment = new Map<string, typeof legRows>();
  for (const leg of legRows) {
    const arr = legsByShipment.get(leg.shipment_id) ?? [];
    arr.push(leg);
    legsByShipment.set(leg.shipment_id, arr);
  }

  const conveyanceByRef = new Map(
    conveyances
      .filter((c) => c.assigned_to)
      .map((c) => [c.assigned_to as string, c]),
  );

  const quoteCountByShipment = new Map<string, number>();
  const selectedQuoteByShipment = new Map<string, (typeof quoteRows)[number]>();
  for (const q of quoteRows) {
    quoteCountByShipment.set(
      q.shipment_id,
      (quoteCountByShipment.get(q.shipment_id) ?? 0) + 1,
    );
    if (!selectedQuoteByShipment.has(q.shipment_id) || q.state === "SELECTED") {
      selectedQuoteByShipment.set(q.shipment_id, q);
    }
  }

  const enrichedShipments: ControlTowerShipmentItem[] = shipments.map((s) => {
    const plan = s.plan as Record<string, unknown> | null;
    const booking = s.booking as Record<string, unknown> | null;
    const sLegs = legsByShipment.get(s.id) ?? [];
    const conv = conveyanceByRef.get(s.reference);
    const quote = selectedQuoteByShipment.get(s.id);

    const planModes = Array.isArray(plan?.modes)
      ? (plan.modes as string[])
      : sLegs.map((l) => l.mode);
    const rawMode = String(
      planModes.find((m) => m === "SEA" || m === "AIR") ??
        planModes[0] ??
        sLegs[0]?.mode ??
        "ROAD",
    ).toUpperCase();
    const primaryMode = (
      ["SEA", "AIR", "ROAD", "RAIL"].includes(rawMode) ? rawMode : "ROAD"
    ) as "SEA" | "AIR" | "ROAD" | "RAIL";

    const carrierCode =
      (booking?.carrier_code as string | undefined) ??
      conv?.carrier_code ??
      null;
    const carrierName =
      conv?.carrier_name ??
      quote?.carrier_name ??
      carrierCode ??
      null;

    const legKm = sLegs.reduce((sum, l) => sum + (Number(l.distance_km) || 0), 0);
    const distanceKm =
      Number(plan?.distance_km ?? 0) || (legKm > 0 ? Math.round(legKm) : null);
    const transitHours = Number(plan?.transit_hours ?? 0) || null;

    return {
      ...s,
      carrier_name: carrierName,
      carrier_code: carrierCode,
      primary_mode: primaryMode,
      distance_km: distanceKm,
      transit_hours: transitHours,
      last_lat: conv?.last_lat ? Number(conv.last_lat) : null,
      last_lon: conv?.last_lon ? Number(conv.last_lon) : null,
      last_speed: conv?.last_speed ? Number(conv.last_speed) : null,
      vehicle_label:
        (plan?.assigned_vehicle as string | undefined) ??
        conv?.registration ??
        (plan?.vehicle as string | undefined) ??
        null,
    };
  });

  // 14-day daily operational trend derived strictly from real shipment & quote records
  const now = new Date();
  const quoteBookingTrend: QuoteBookingPoint[] = [];
  const modeVolumeTrend: ModeVolumePoint[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const label = d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const dayEnd = dayStart + 86_400_000;

    const dayShips = enrichedShipments.filter((s) => {
      const t = new Date(s.created_at).getTime();
      return t >= dayStart && t < dayEnd;
    });
    const bookingsOnDay = dayShips.filter((s) => convertedStates.has(s.state)).length;
    const quotesOnDay = dayShips.reduce(
      (sum, s) => sum + (quoteCountByShipment.get(s.id) ?? 0),
      0,
    );

    quoteBookingTrend.push({
      label,
      bookings: bookingsOnDay,
      quotes: quotesOnDay,
    });

    modeVolumeTrend.push({
      label,
      sea: dayShips.filter((s) => s.primary_mode === "SEA").length,
      air: dayShips.filter((s) => s.primary_mode === "AIR").length,
      road: dayShips.filter(
        (s) => s.primary_mode === "ROAD" || s.primary_mode === "RAIL",
      ).length,
    });
  }

  // Today's 6 four-hour UTC buckets derived strictly from today's records
  const todayStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const todayQuoteBookingTrend: QuoteBookingPoint[] = [];
  const todayModeVolumeTrend: ModeVolumePoint[] = [];
  for (let slot = 0; slot < 6; slot += 1) {
    const startMs = todayStart + slot * 4 * 3_600_000;
    const endMs = startMs + 4 * 3_600_000;
    const hourStr = `${String(slot * 4).padStart(2, "0")}:00`;
    const slotShips = enrichedShipments.filter((s) => {
      const t = new Date(s.created_at).getTime();
      return t >= startMs && t < endMs;
    });
    todayQuoteBookingTrend.push({
      label: hourStr,
      bookings: slotShips.filter((s) => convertedStates.has(s.state)).length,
      quotes: slotShips.reduce(
        (sum, s) => sum + (quoteCountByShipment.get(s.id) ?? 0),
        0,
      ),
    });
    todayModeVolumeTrend.push({
      label: hourStr,
      sea: slotShips.filter((s) => s.primary_mode === "SEA").length,
      air: slotShips.filter((s) => s.primary_mode === "AIR").length,
      road: slotShips.filter(
        (s) => s.primary_mode === "ROAD" || s.primary_mode === "RAIL",
      ).length,
    });
  }

  return {
    kpis: {
      activeShipments: stats.active,
      totalShipments,
      quotesGenerated,
      quotesSelected,
      aiConversations,
      delayedOrAttention,
      conversionRatePct,
      freightValueMinor,
      currency: "NGN",
    },
    quoteBookingTrend,
    modeVolumeTrend,
    todayQuoteBookingTrend,
    todayModeVolumeTrend,
    shipments: enrichedShipments,
    locations,
  };
}

