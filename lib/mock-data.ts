import { buildMockAssistantReply, buildMockSupportReply, extractCity } from "./view-helpers";

export interface MockLocation {
  id: string;
  type: "WAREHOUSE" | "PORT" | "AIRPORT" | "RAIL_TERMINAL";
  name: string;
  code: string;
  city: string;
  country: string;
  latitude: string;
  longitude: string;
}

export interface MockWarehouse {
  id: string;
  code: string;
  name: string;
  dispatch_lead_hours: string;
  handles_hazmat: boolean;
  handles_reefer: boolean;
  active: boolean;
  city: string;
  country: string;
  latitude: string;
  longitude: string;
  skus: string;
  on_hand: string;
  reserved: string;
}

export interface MockInventoryRow {
  warehouse: string;
  sku: string;
  on_hand: number;
  reserved: number;
  available: number;
}

export interface MockCarrier {
  id: string;
  code: string;
  name: string;
  modes: string[];
  integration: string;
  approved: boolean;
  active: boolean;
  on_time_rate: string;
  damage_rate: string;
  availability_rate: string;
  service_score: string;
  shipments_count: number;
}

export interface MockCustomer {
  id: string;
  code: string;
  name: string;
  sla_hours: number | null;
  payment_terms: string | null;
  default_currency: string;
  contacts: { name?: string; email?: string; phone?: string }[];
  active: boolean;
}

export interface MockShipment {
  id: string;
  reference: string;
  state: string;
  version: number;
  customer_id: string;
  customer_ref: string;
  origin: Record<string, unknown>;
  destination: Record<string, unknown>;
  cargo: Record<string, unknown>;
  deadline: Date;
  allocation: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  booking: Record<string, unknown> | null;
  created_via: string;
  created_at: Date;
  updated_at: Date;
}

export interface MockEvent {
  id: string;
  shipment_id: string;
  seq: number;
  type: string;
  from_state: string | null;
  to_state: string | null;
  payload: Record<string, unknown>;
  actor: string;
  created_at: Date;
}

export interface MockLeg {
  shipment_id: string;
  sequence: number;
  mode: string;
  state: string;
  distance_km: string;
  cost_minor: string | null;
  currency: string;
  load_type: string;
  co2e_kg: string;
  conveyance_id?: string | null;
  driver_id?: string | null;
  metadata: Record<string, unknown>;
}

export interface MockQuote {
  id: string;
  shipment_id: string;
  carrier_code: string;
  carrier_name: string;
  state: string;
  source: string;
  amount_minor: string;
  currency: string;
  transit_hours: string;
  confidence: string;
  raw_text: string;
  parsed_by: string;
  score: string;
  score_breakdown: {
    parts: Record<string, { weight: number; value: number; contribution: number }>;
  };
  round: number;
}

export interface MockApproval {
  id: string;
  shipment_id: string;
  proposed_action_id: string;
  token: string;
  state: "PENDING" | "APPROVED" | "REJECTED";
  summary: string;
  rationale: string;
  amount_minor: string;
  currency: string;
  requested_at: Date;
  expires_at: Date;
  decided_by?: string | null;
  decided_at?: Date | null;
}

export interface MockException {
  id: string;
  shipment_id: string;
  kind: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  detected_by: string;
  state: "OPEN" | "RESOLVED";
  detail: Record<string, unknown>;
  created_at: Date;
}

export interface MockConveyance {
  id: string;
  mode: string;
  kind: string;
  registration: string;
  carrier_code: string;
  carrier_name: string;
  capacity_kg: string;
  capacity_cbm: string;
  reefer: boolean;
  hazmat_certified: boolean;
  active: boolean;
  assigned_to: string | null;
  leg_state: string | null;
  last_seen_at: Date | null;
  last_lat: string | null;
  last_lon: string | null;
  last_speed: string | null;
}

export interface MockDriver {
  id: string;
  name: string;
  phone: string;
  licence_number: string;
  licence_expiry: Date;
  hazmat_certified: boolean;
  active: boolean;
  carrier_code: string;
  carrier_name: string;
  assigned_to: string | null;
  days_to_expiry: string;
}

export interface MockOrder {
  id: string;
  reference: string;
  state: string;
  source: string;
  currency: string;
  ordered_at: Date;
  required_by: Date | null;
  customer: string;
  items: string;
}

export interface MockCommunication {
  id: string;
  shipment_id: string | null;
  customer_id: string | null;
  contact_id: string | null;
  channel: string;
  direction: "INBOUND" | "OUTBOUND";
  recipient: string | null;
  subject: string | null;
  body: string;
  state: string;
  safety_checked: boolean;
  created_at: Date;
}

export interface MockContact {
  id: string;
  channel: string;
  external_id: string;
  display_name: string;
  escalated_at: Date | null;
  escalation_reason: string | null;
  draft: Record<string, unknown> | null;
  last_seen_at: Date;
  last_shipment_id: string | null;
}

export interface MockDocument {
  id: string;
  shipment_id: string;
  kind: string;
  direction: string;
  filename: string;
  extraction_model: string | null;
  extraction_confidence: string | null;
  verified_at: Date | null;
  created_at: Date;
}

export interface MockCustoms {
  id: string;
  shipment_id: string;
  direction: string;
  clearance_state: string;
  hs_codes: string[];
  broker: string;
  submitted_at: Date | null;
}

export interface MockWorkItem {
  id: string;
  shipment_id: string | null;
  kind: string;
  state: "PENDING" | "RUNNING" | "DONE" | "DEAD";
  attempts: number;
  last_error: string | null;
  run_after: Date;
  created_at: Date;
  updated_at: Date;
}

export interface MockAgentRun {
  id: string;
  shipment_id: string | null;
  agent: string;
  job: string;
  model: string;
  status: string;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: Date;
  response: { reasoning?: string | null; text?: string };
}

export interface MockToolCall {
  id: string;
  shipment_id: string | null;
  tool: string;
  tier: number;
  state: string;
  error: string | null;
  request: Record<string, unknown>;
  created_at: Date;
}

export interface MockProposedAction {
  id: string;
  shipment_id: string;
  agent_run_id: string | null;
  action: string;
  rationale: string;
  policy_reason: string;
  policy_decision: string;
  state: string;
  params: Record<string, unknown>;
  created_at: Date;
}

export interface MockAuditLog {
  id: string;
  actor: string;
  actor_type: string;
  action: string;
  entity_type: string | null;
  created_at: Date;
}

export interface MockAssistantMessage {
  id: string;
  shipment_id: string;
  user_id: string;
  role: "user" | "assistant";
  body: string | null;
  state: "PENDING" | "DONE" | "FAILED";
  confidence: string | null;
  next_step: string | null;
  created_at: Date;
}

export interface MockChannelConnection {
  channel: string;
  display_name: string;
  state: string;
  enabled: boolean;
  config: Record<string, unknown>;
  has_credentials: boolean;
  verified_at: Date | null;
  last_inbound_at: Date | null;
  last_error: string | null;
}

export interface OperationalSeed {
  locations: MockLocation[];
  warehouses: MockWarehouse[];
  inventory: MockInventoryRow[];
  carriers: MockCarrier[];
  customers: MockCustomer[];
  shipments: MockShipment[];
  events: MockEvent[];
  legs: MockLeg[];
  quotes: MockQuote[];
  approvals: MockApproval[];
  exceptions: MockException[];
  conveyances: MockConveyance[];
  drivers: MockDriver[];
  orders: MockOrder[];
  communications: MockCommunication[];
  contacts: MockContact[];
  documents: MockDocument[];
  customs: MockCustoms[];
  workItems: MockWorkItem[];
  agentRuns: MockAgentRun[];
  toolCalls: MockToolCall[];
  proposedActions: MockProposedAction[];
  auditLogs: MockAuditLog[];
  assistantMessages: MockAssistantMessage[];
  channels: MockChannelConnection[];
}

function minsAgo(m: number): Date {
  return new Date(Date.now() - m * 60_000);
}
function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 3_600_000);
}
function daysAgo(d: number): Date {
  return new Date(Date.now() - d * 86_400_000);
}
function daysFromNow(d: number): Date {
  return new Date(Date.now() + d * 86_400_000);
}

export function createOperationalSeed(): OperationalSeed {
  const locations: MockLocation[] = [
    {
      id: "loc-los",
      type: "WAREHOUSE",
      name: "Lagos Central DC",
      code: "LOS-DC1",
      city: "Lagos",
      country: "NG",
      latitude: "6.6018",
      longitude: "3.3515",
    },
    {
      id: "loc-abv",
      type: "WAREHOUSE",
      name: "Abuja Garki Hub",
      code: "ABV-HUB",
      city: "Abuja",
      country: "NG",
      latitude: "9.0579",
      longitude: "7.4951",
    },
    {
      id: "loc-phc",
      type: "PORT",
      name: "Onne Maritime Terminal",
      code: "PHC-PRT",
      city: "Port Harcourt",
      country: "NG",
      latitude: "4.7239",
      longitude: "7.1516",
    },
    {
      id: "loc-kan",
      type: "AIRPORT",
      name: "Kano Air Cargo Gate",
      code: "KAN-AIR",
      city: "Kano",
      country: "NG",
      latitude: "12.0476",
      longitude: "8.5246",
    },
    {
      id: "loc-tem",
      type: "PORT",
      name: "Tema Harbour Terminal",
      code: "TEM-PRT",
      city: "Tema",
      country: "GH",
      latitude: "5.6167",
      longitude: "-0.0167",
    },
    {
      id: "loc-acc",
      type: "AIRPORT",
      name: "Kotoka Air Cargo",
      code: "ACC-AIR",
      city: "Accra",
      country: "GH",
      latitude: "5.6052",
      longitude: "-0.1668",
    },
    {
      id: "loc-coo",
      type: "RAIL_TERMINAL",
      name: "Cotonou Corridor Gate",
      code: "COO-GTW",
      city: "Cotonou",
      country: "BJ",
      latitude: "6.3703",
      longitude: "2.3912",
    },
  ];

  const warehouses: MockWarehouse[] = [
    {
      id: "wh-los",
      code: "LOS-DC1",
      name: "Lagos Central DC (Ikeja)",
      dispatch_lead_hours: "4",
      handles_hazmat: true,
      handles_reefer: true,
      active: true,
      city: "Lagos",
      country: "NG",
      latitude: "6.6018",
      longitude: "3.3515",
      skus: "4",
      on_hand: "2450",
      reserved: "640",
    },
    {
      id: "wh-abv",
      code: "ABV-HUB",
      name: "Abuja Garki Distribution",
      dispatch_lead_hours: "6",
      handles_hazmat: false,
      handles_reefer: true,
      active: true,
      city: "Abuja",
      country: "NG",
      latitude: "9.0579",
      longitude: "7.4951",
      skus: "3",
      on_hand: "1180",
      reserved: "420",
    },
    {
      id: "wh-phc",
      code: "PHC-DEP",
      name: "Port Harcourt Coastal Depot",
      dispatch_lead_hours: "18",
      handles_hazmat: true,
      handles_reefer: false,
      active: true,
      city: "Port Harcourt",
      country: "NG",
      latitude: "4.8156",
      longitude: "7.0498",
      skus: "2",
      on_hand: "790",
      reserved: "590",
    },
  ];

  const inventory: MockInventoryRow[] = [
    { warehouse: "LOS-DC1", sku: "ELEC-4K-BOX", on_hand: 850, reserved: 220, available: 630 },
    { warehouse: "LOS-DC1", sku: "PHARMA-COLD", on_hand: 420, reserved: 190, available: 230 },
    { warehouse: "LOS-DC1", sku: "IND-VALVE-09", on_hand: 680, reserved: 150, available: 530 },
    { warehouse: "LOS-DC1", sku: "FMCG-STD", on_hand: 500, reserved: 80, available: 420 },
    { warehouse: "ABV-HUB", sku: "ELEC-4K-BOX", on_hand: 480, reserved: 160, available: 320 },
    { warehouse: "ABV-HUB", sku: "PHARMA-COLD", on_hand: 340, reserved: 210, available: 130 },
    { warehouse: "ABV-HUB", sku: "FMCG-STD", on_hand: 360, reserved: 50, available: 310 },
    { warehouse: "PHC-DEP", sku: "IND-VALVE-09", on_hand: 450, reserved: 420, available: 30 },
    { warehouse: "PHC-DEP", sku: "CHEM-SEAL-22", on_hand: 340, reserved: 170, available: 170 },
  ];

  const carriers: MockCarrier[] = [
    {
      id: "car-kobo",
      code: "KOBO360",
      name: "Kobo360 Freight Network",
      modes: ["ROAD"],
      integration: "API",
      approved: true,
      active: true,
      on_time_rate: "0.94",
      damage_rate: "0.012",
      availability_rate: "0.88",
      service_score: "0.93",
      shipments_count: 248,
    },
    {
      id: "car-gig",
      code: "GIG-LOG",
      name: "GIG Logistics Express",
      modes: ["ROAD", "AIR"],
      integration: "API",
      approved: true,
      active: true,
      on_time_rate: "0.91",
      damage_rate: "0.018",
      availability_rate: "0.92",
      service_score: "0.89",
      shipments_count: 192,
    },
    {
      id: "car-maersk",
      code: "MAERSK-WA",
      name: "Maersk West Africa Feeder",
      modes: ["SEA"],
      integration: "EDI",
      approved: true,
      active: true,
      on_time_rate: "0.89",
      damage_rate: "0.008",
      availability_rate: "0.85",
      service_score: "0.91",
      shipments_count: 140,
    },
    {
      id: "car-dhl",
      code: "DHL-AFR",
      name: "DHL Aviation West Africa",
      modes: ["AIR"],
      integration: "API",
      approved: true,
      active: true,
      on_time_rate: "0.96",
      damage_rate: "0.005",
      availability_rate: "0.81",
      service_score: "0.95",
      shipments_count: 118,
    },
    {
      id: "car-quick",
      code: "QUICKMOVE",
      name: "Quickmove Ventures",
      modes: ["ROAD"],
      integration: "TELEGRAM",
      approved: false,
      active: true,
      on_time_rate: "0.68",
      damage_rate: "0.095",
      availability_rate: "0.98",
      service_score: "0.64",
      shipments_count: 54,
    },
  ];

  const customers: MockCustomer[] = [
    {
      id: "cust-abc",
      code: "ABC-RTL",
      name: "ABC Retail Ltd",
      sla_hours: 36,
      payment_terms: "Net 30",
      default_currency: "NGN",
      contacts: [
        { name: "Chinedu Okafor", email: "logistics@abcretail.ng", phone: "+234 803 411 9021" },
      ],
      active: true,
    },
    {
      id: "cust-tema",
      code: "TEMA-TRD",
      name: "Tema Trading Co",
      sla_hours: 72,
      payment_terms: "Net 15",
      default_currency: "USD",
      contacts: [
        { name: "Kwame Mensah", email: "ops@tematrading.gh", phone: "+233 24 881 4410" },
      ],
      active: true,
    },
    {
      id: "cust-zenith",
      code: "ZEN-HLTH",
      name: "Zenith Pharma Group",
      sla_hours: 24,
      payment_terms: "Prepaid",
      default_currency: "NGN",
      contacts: [
        { name: "Amina Bello", email: "coldchain@zenithpharma.ng", phone: "+234 809 220 3319" },
      ],
      active: true,
    },
    {
      id: "cust-delta",
      code: "DLT-OIL",
      name: "Delta Offshore Supply",
      sla_hours: 48,
      payment_terms: "Net 45",
      default_currency: "NGN",
      contacts: [
        { name: "Tomiwa Adeyemi", email: "supply@deltaoffshore.ng", phone: "+234 802 910 7782" },
      ],
      active: true,
    },
  ];

  const shipments: MockShipment[] = [
    {
      id: "shp-82931",
      reference: "LG-82931",
      state: "EXCEPTION",
      version: 5,
      customer_id: "cust-abc",
      customer_ref: "ABC Retail Ltd",
      origin: {
        warehouse: "LOS-DC1",
        city: "Lagos",
        country: "NG",
        address: "Plot 14 Acme Way, Ikeja, Lagos",
      },
      destination: {
        city: "Abuja",
        country: "NG",
        address: "12 Ahmadu Bello Way, Garki, Abuja",
      },
      cargo: {
        sku: "ELEC-4K-BOX",
        quantity: 100,
        weight_kg: 1800,
        description: "100 cartons consumer electronics",
      },
      deadline: hoursFromNow(9),
      allocation: {
        sku: "ELEC-4K-BOX",
        quantity: 100,
        lines: [{ warehouse: "LOS-DC1", quantity: 100 }],
        meets_deadline: true,
        rationale: "LOS-DC1 holds 630 available units with 4h dispatch lead.",
      },
      plan: {
        legs: 1,
        modes: ["ROAD"],
        distance_km: 742,
        transit_hours: 14,
        vehicle: "Volvo FH16 15t",
        assigned_vehicle: "LAG-482-KT",
        routing_solver: "NVIDIA cuOpt CVRPTW",
        waypoints: ["Lagos", "Ibadan", "Lokoja", "Abuja"],
        estimated_cost_minor: 48500000,
        currency: "NGN",
        priced_legs: 1,
        co2e_kg: 194.5,
        meets_deadline: false,
        confidence: "0.91",
        projected_delivery: hoursFromNow(13).toISOString(),
      },
      booking: { carrier_code: "KOBO360", reference: "KB-992104" },
      created_via: "API",
      created_at: daysAgo(1),
      updated_at: minsAgo(14),
    },
    {
      id: "shp-90014",
      reference: "LG-90014",
      state: "AWAITING_APPROVAL",
      version: 4,
      customer_id: "cust-tema",
      customer_ref: "Tema Trading Co",
      origin: {
        warehouse: "LOS-DC1",
        city: "Lagos",
        country: "NG",
        address: "Lagos Central DC, Ikeja, Lagos",
      },
      destination: {
        city: "Tema",
        country: "GH",
        address: "Plot 22 Harbour Road, Tema, Ghana",
      },
      cargo: {
        sku: "IND-VALVE-09",
        quantity: 100,
        weight_kg: 12000,
        description: "100 cartons, palletised industrial valves",
      },
      deadline: hoursFromNow(56),
      allocation: {
        sku: "IND-VALVE-09",
        quantity: 100,
        lines: [{ warehouse: "LOS-DC1", quantity: 100 }],
        meets_deadline: true,
        rationale: "Single-site fulfilment from Ikeja export bay.",
      },
      plan: {
        legs: 2,
        modes: ["ROAD", "SEA"],
        distance_km: 518,
        transit_hours: 29,
        vehicle: "20ft Container Chassis + Coastal Feeder",
        assigned_vehicle: "LAG-903-XC",
        routing_solver: "NVIDIA cuOpt + Corridor Advisory",
        waypoints: ["Lagos", "Cotonou", "Tema"],
        estimated_cost_minor: 142500000,
        currency: "NGN",
        priced_legs: 2,
        co2e_kg: 112.4,
        meets_deadline: true,
        confidence: "0.88",
        customs_required: true,
        projected_delivery: hoursFromNow(36).toISOString(),
      },
      booking: null,
      created_via: "EMAIL",
      created_at: daysAgo(2),
      updated_at: minsAgo(22),
    },
    {
      id: "shp-82932",
      reference: "LG-82932",
      state: "NEEDS_INFO",
      version: 2,
      customer_id: "cust-abc",
      customer_ref: "ABC Retail Ltd",
      origin: {
        warehouse: "LOS-DC1",
        city: "Lagos",
        country: "NG",
        address: "Plot 14 Acme Way, Ikeja, Lagos",
      },
      destination: {
        city: "Abuja",
        country: "NG",
      },
      cargo: {
        sku: "FMCG-STD",
        quantity: 80,
        weight_kg: 960,
        description: "80 cartons packaged consumer goods",
      },
      deadline: hoursFromNow(18),
      allocation: null,
      plan: null,
      booking: null,
      created_via: "WHATSAPP",
      created_at: daysAgo(1),
      updated_at: minsAgo(38),
    },
    {
      id: "shp-84102",
      reference: "LG-84102",
      state: "IN_TRANSIT",
      version: 6,
      customer_id: "cust-zenith",
      customer_ref: "Zenith Pharma Group",
      origin: {
        warehouse: "LOS-DC1",
        city: "Lagos",
        country: "NG",
        address: "Lagos Cold Chain Bay, Ikeja",
      },
      destination: {
        city: "Kano",
        country: "NG",
        address: "42 Zaria Road, Kano",
      },
      cargo: {
        sku: "PHARMA-COLD",
        quantity: 60,
        weight_kg: 720,
        description: "60 insulated medical crates (2–8°C)",
      },
      deadline: hoursFromNow(11),
      allocation: {
        sku: "PHARMA-COLD",
        quantity: 60,
        lines: [{ warehouse: "LOS-DC1", quantity: 60 }],
        meets_deadline: true,
        rationale: "Cold-chain reserve confirmed at LOS-DC1.",
      },
      plan: {
        legs: 2,
        modes: ["AIR", "ROAD"],
        distance_km: 860,
        transit_hours: 6,
        vehicle: "Cargo Express + Reefer Van",
        assigned_vehicle: "ABJ-210-RF",
        routing_solver: "NVIDIA cuOpt Express",
        waypoints: ["Lagos", "Kano"],
        estimated_cost_minor: 91000000,
        currency: "NGN",
        priced_legs: 2,
        co2e_kg: 624.0,
        meets_deadline: true,
        confidence: "0.96",
        projected_delivery: hoursFromNow(5).toISOString(),
      },
      booking: { carrier_code: "DHL-AFR", reference: "DHL-77412" },
      created_via: "API",
      created_at: daysAgo(2),
      updated_at: minsAgo(9),
    },
    {
      id: "shp-84210",
      reference: "LG-84210",
      state: "AWAITING_APPROVAL",
      version: 3,
      customer_id: "cust-delta",
      customer_ref: "Delta Offshore Supply",
      origin: {
        warehouse: "PHC-DEP",
        city: "Port Harcourt",
        country: "NG",
        address: "Onne Oil & Gas Free Zone, Rivers",
      },
      destination: {
        city: "Lagos",
        country: "NG",
        address: "Apapa Marine Terminal, Lagos",
      },
      cargo: {
        sku: "CHEM-SEAL-22",
        quantity: 45,
        weight_kg: 3400,
        description: "45 drums marine sealant (Hazmat Class 3)",
      },
      deadline: hoursFromNow(40),
      allocation: {
        sku: "CHEM-SEAL-22",
        quantity: 45,
        lines: [{ warehouse: "PHC-DEP", quantity: 45 }],
        meets_deadline: true,
        rationale: "Allocated at PHC-DEP hazmat bay.",
      },
      plan: {
        legs: 1,
        modes: ["SEA"],
        distance_km: 610,
        transit_hours: 22,
        vehicle: "Coastal Hazmat Barge",
        assigned_vehicle: "MV-NIGER-4",
        routing_solver: "Corridor Matrix",
        waypoints: ["Port Harcourt", "Lagos"],
        estimated_cost_minor: 118000000,
        currency: "NGN",
        priced_legs: 1,
        co2e_kg: 76.2,
        meets_deadline: true,
        confidence: "0.87",
        projected_delivery: hoursFromNow(28).toISOString(),
      },
      booking: null,
      created_via: "MANUAL",
      created_at: daysAgo(3),
      updated_at: minsAgo(45),
    },
    {
      id: "shp-84305",
      reference: "LG-84305",
      state: "PLANNED",
      version: 3,
      customer_id: "cust-abc",
      customer_ref: "ABC Retail Ltd",
      origin: {
        warehouse: "ABV-HUB",
        city: "Abuja",
        country: "NG",
        address: "Abuja Garki Distribution",
      },
      destination: {
        city: "Kano",
        country: "NG",
        address: "88 Murtala Mohammed Way, Kano",
      },
      cargo: {
        sku: "ELEC-4K-BOX",
        quantity: 50,
        weight_kg: 820,
        description: "50 cartons display units",
      },
      deadline: hoursFromNow(28),
      allocation: {
        sku: "ELEC-4K-BOX",
        quantity: 50,
        lines: [{ warehouse: "ABV-HUB", quantity: 50 }],
        meets_deadline: true,
        rationale: "ABV-HUB is closest to Kano corridor.",
      },
      plan: {
        legs: 1,
        modes: ["ROAD"],
        distance_km: 412,
        transit_hours: 7,
        vehicle: "10t Box Truck",
        assigned_vehicle: "ABJ-771-MN",
        routing_solver: "NVIDIA cuOpt CVRPTW",
        waypoints: ["Abuja", "Kaduna", "Kano"],
        estimated_cost_minor: 29500000,
        currency: "NGN",
        priced_legs: 1,
        co2e_kg: 96.4,
        meets_deadline: true,
        confidence: "0.94",
        projected_delivery: hoursFromNow(14).toISOString(),
      },
      booking: null,
      created_via: "CSV",
      created_at: daysAgo(1),
      updated_at: minsAgo(62),
    },
    {
      id: "shp-84318",
      reference: "LG-84318",
      state: "BOOKED",
      version: 4,
      customer_id: "cust-tema",
      customer_ref: "Tema Trading Co",
      origin: {
        warehouse: "LOS-DC1",
        city: "Lagos",
        country: "NG",
        address: "Lagos Central DC, Ikeja",
      },
      destination: {
        city: "Accra",
        country: "GH",
        address: "14 Independence Ave, Accra",
      },
      cargo: {
        sku: "ELEC-4K-BOX",
        quantity: 40,
        weight_kg: 520,
        description: "40 cartons retail POS hardware",
      },
      deadline: hoursFromNow(30),
      allocation: {
        sku: "ELEC-4K-BOX",
        quantity: 40,
        lines: [{ warehouse: "LOS-DC1", quantity: 40 }],
        meets_deadline: true,
      },
      plan: {
        legs: 1,
        modes: ["AIR"],
        distance_km: 405,
        transit_hours: 3,
        vehicle: "Air Freight Priority",
        routing_solver: "NVIDIA cuOpt Air",
        waypoints: ["Lagos", "Accra"],
        estimated_cost_minor: 64000000,
        currency: "NGN",
        priced_legs: 1,
        co2e_kg: 318.0,
        meets_deadline: true,
        confidence: "0.95",
        projected_delivery: hoursFromNow(12).toISOString(),
      },
      booking: { carrier_code: "GIG-LOG", reference: "GIG-44102" },
      created_via: "API",
      created_at: daysAgo(2),
      updated_at: minsAgo(88),
    },
    {
      id: "shp-84001",
      reference: "LG-84001",
      state: "DELIVERED",
      version: 7,
      customer_id: "cust-zenith",
      customer_ref: "Zenith Pharma Group",
      origin: {
        warehouse: "ABV-HUB",
        city: "Abuja",
        country: "NG",
        address: "Abuja Garki Distribution",
      },
      destination: {
        city: "Port Harcourt",
        country: "NG",
        address: "19 Aba Road, Port Harcourt",
      },
      cargo: {
        sku: "PHARMA-COLD",
        quantity: 35,
        weight_kg: 440,
        description: "35 cold-chain medical kits",
      },
      deadline: daysAgo(1),
      allocation: {
        sku: "PHARMA-COLD",
        quantity: 35,
        lines: [{ warehouse: "ABV-HUB", quantity: 35 }],
        meets_deadline: true,
      },
      plan: {
        legs: 1,
        modes: ["ROAD"],
        distance_km: 618,
        transit_hours: 11,
        vehicle: "Reefer Sprinter",
        routing_solver: "NVIDIA cuOpt CVRPTW",
        waypoints: ["Abuja", "Enugu", "Port Harcourt"],
        estimated_cost_minor: 36500000,
        currency: "NGN",
        priced_legs: 1,
        co2e_kg: 121.0,
        meets_deadline: true,
        confidence: "0.95",
      },
      booking: { carrier_code: "GIG-LOG", reference: "GIG-43910" },
      created_via: "API",
      created_at: daysAgo(4),
      updated_at: minsAgo(190),
    },
    {
      id: "shp-83950",
      reference: "LG-83950",
      state: "CLOSED",
      version: 8,
      customer_id: "cust-abc",
      customer_ref: "ABC Retail Ltd",
      origin: {
        warehouse: "LOS-DC1",
        city: "Lagos",
        country: "NG",
        address: "Plot 14 Acme Way, Ikeja",
      },
      destination: {
        city: "Cotonou",
        country: "BJ",
        address: "Zone Portuaire, Cotonou",
      },
      cargo: {
        sku: "FMCG-STD",
        quantity: 120,
        weight_kg: 2100,
        description: "120 cartons retail replenishment",
      },
      deadline: daysAgo(3),
      allocation: {
        sku: "FMCG-STD",
        quantity: 120,
        lines: [{ warehouse: "LOS-DC1", quantity: 120 }],
        meets_deadline: true,
      },
      plan: {
        legs: 1,
        modes: ["ROAD"],
        distance_km: 124,
        transit_hours: 4,
        vehicle: "12t Box Truck",
        routing_solver: "NVIDIA cuOpt CVRPTW",
        waypoints: ["Lagos", "Cotonou"],
        estimated_cost_minor: 21000000,
        currency: "NGN",
        priced_legs: 1,
        co2e_kg: 44.2,
        meets_deadline: true,
        confidence: "0.97",
      },
      booking: { carrier_code: "KOBO360", reference: "KB-990112" },
      created_via: "API",
      created_at: daysAgo(5),
      updated_at: daysAgo(3),
    },
  ];

  const events: MockEvent[] = [
    {
      id: "101",
      shipment_id: "shp-82931",
      seq: 1,
      type: "shipment.created",
      from_state: null,
      to_state: "DRAFT",
      payload: {},
      actor: "api",
      created_at: daysAgo(1),
    },
    {
      id: "102",
      shipment_id: "shp-82931",
      seq: 2,
      type: "order.validated",
      from_state: "DRAFT",
      to_state: "VALIDATED",
      payload: {},
      actor: "validator",
      created_at: minsAgo(520),
    },
    {
      id: "103",
      shipment_id: "shp-82931",
      seq: 3,
      type: "warehouse.allocated",
      from_state: "VALIDATED",
      to_state: "ALLOCATED",
      payload: { rationale: "Reserved 100 units of ELEC-4K-BOX at LOS-DC1." },
      actor: "allocator",
      created_at: minsAgo(490),
    },
    {
      id: "104",
      shipment_id: "shp-82931",
      seq: 4,
      type: "carrier.booked",
      from_state: "BOOKED",
      to_state: "IN_TRANSIT",
      payload: { rationale: "Dispatched on KOBO360 unit LAG-482-KT." },
      actor: "orchestrator",
      created_at: minsAgo(240),
    },
    {
      id: "105",
      shipment_id: "shp-82931",
      seq: 5,
      type: "exception.raised",
      from_state: "IN_TRANSIT",
      to_state: "EXCEPTION",
      payload: {
        rationale: "ETA drift +4.2h detected near Lokoja corridor checkpoint; approaching 24h SLA threshold.",
      },
      actor: "detector",
      created_at: minsAgo(14),
    },
    {
      id: "106",
      shipment_id: "shp-90014",
      seq: 1,
      type: "shipment.created",
      from_state: null,
      to_state: "DRAFT",
      payload: {},
      actor: "email",
      created_at: daysAgo(2),
    },
    {
      id: "107",
      shipment_id: "shp-90014",
      seq: 2,
      type: "quote.selected",
      from_state: "SOURCING",
      to_state: "AWAITING_APPROVAL",
      payload: {
        rationale: "Total spend ₦1,425,000 exceeds automatic approval threshold (₦500,000); routed to human approval.",
      },
      actor: "policy_gate",
      created_at: minsAgo(22),
    },
    {
      id: "108",
      shipment_id: "shp-82932",
      seq: 1,
      type: "order.needs_info",
      from_state: "DRAFT",
      to_state: "NEEDS_INFO",
      payload: {
        customer_message: "Please confirm the street delivery address in Abuja so we can dispatch your 80 cartons.",
      },
      actor: "validator",
      created_at: minsAgo(38),
    },
  ];

  const legs: MockLeg[] = [
    {
      shipment_id: "shp-82931",
      sequence: 1,
      mode: "ROAD",
      state: "IN_TRANSIT",
      distance_km: "742",
      cost_minor: "48500000",
      currency: "NGN",
      load_type: "FTL 15t",
      co2e_kg: "194.5",
      conveyance_id: "veh-1",
      driver_id: "drv-1",
      metadata: { origin_name: "Lagos Central DC", destination_name: "Garki, Abuja" },
    },
    {
      shipment_id: "shp-90014",
      sequence: 1,
      mode: "ROAD",
      state: "AT_ORIGIN",
      distance_km: "124",
      cost_minor: "24500000",
      currency: "NGN",
      load_type: "20ft Chassis",
      co2e_kg: "42.4",
      conveyance_id: "veh-2",
      driver_id: "drv-2",
      metadata: { origin_name: "Lagos Central DC", destination_name: "Cotonou Border Gate" },
    },
    {
      shipment_id: "shp-90014",
      sequence: 2,
      mode: "SEA",
      state: "PENDING",
      distance_km: "394",
      cost_minor: "118000000",
      currency: "NGN",
      load_type: "FCL 20ft",
      co2e_kg: "70.0",
      metadata: { origin_name: "Cotonou Port", destination_name: "Tema Harbour Terminal" },
    },
    {
      shipment_id: "shp-84102",
      sequence: 1,
      mode: "AIR",
      state: "COMPLETED",
      distance_km: "830",
      cost_minor: "76000000",
      currency: "NGN",
      load_type: "Temp-Controlled ULD",
      co2e_kg: "608.0",
      metadata: { origin_name: "Murtala Muhammed Cargo", destination_name: "Kano Air Cargo Gate" },
    },
    {
      shipment_id: "shp-84102",
      sequence: 2,
      mode: "ROAD",
      state: "IN_TRANSIT",
      distance_km: "30",
      cost_minor: "15000000",
      currency: "NGN",
      load_type: "Reefer Van",
      co2e_kg: "16.0",
      conveyance_id: "veh-3",
      driver_id: "drv-3",
      metadata: { origin_name: "Kano Air Cargo Gate", destination_name: "42 Zaria Road, Kano" },
    },
    {
      shipment_id: "shp-84210",
      sequence: 1,
      mode: "SEA",
      state: "PENDING",
      distance_km: "610",
      cost_minor: "118000000",
      currency: "NGN",
      load_type: "Hazmat Barge",
      co2e_kg: "76.2",
      metadata: { origin_name: "Onne Maritime Terminal", destination_name: "Apapa Marine Terminal" },
    },
    {
      shipment_id: "shp-84305",
      sequence: 1,
      mode: "ROAD",
      state: "PENDING",
      distance_km: "412",
      cost_minor: "29500000",
      currency: "NGN",
      load_type: "FTL 10t",
      co2e_kg: "96.4",
      metadata: { origin_name: "Abuja Garki Hub", destination_name: "Kano Depot" },
    },
  ];

  const quotes: MockQuote[] = [
    {
      id: "qt-1",
      shipment_id: "shp-90014",
      carrier_code: "MAERSK-WA",
      carrier_name: "Maersk West Africa Feeder",
      state: "SELECTED",
      source: "EDI",
      amount_minor: "142500000",
      currency: "NGN",
      transit_hours: "29",
      confidence: "0.96",
      raw_text: "FCL 20ft Ikeja->Cotonou->Tema total NGN 1,425,000 all-in customs transit 29h",
      parsed_by: "nemotron-3.5-super-vl",
      score: "0.91",
      score_breakdown: {
        parts: {
          cost: { weight: 0.3, value: 0.85, contribution: 0.255 },
          on_time: { weight: 0.25, value: 0.89, contribution: 0.2225 },
        },
      },
      round: 1,
    },
    {
      id: "qt-2",
      shipment_id: "shp-90014",
      carrier_code: "GIG-LOG",
      carrier_name: "GIG Logistics Express",
      state: "QUOTED",
      source: "API",
      amount_minor: "164000000",
      currency: "NGN",
      transit_hours: "26",
      confidence: "0.98",
      raw_text: "Cross-border express corridor Lagos-Tema NGN 1,640,000",
      parsed_by: "api",
      score: "0.84",
      score_breakdown: {
        parts: {
          cost: { weight: 0.3, value: 0.62, contribution: 0.186 },
          on_time: { weight: 0.25, value: 0.91, contribution: 0.2275 },
        },
      },
      round: 1,
    },
    {
      id: "qt-3",
      shipment_id: "shp-82931",
      carrier_code: "KOBO360",
      carrier_name: "Kobo360 Freight Network",
      state: "SELECTED",
      source: "API",
      amount_minor: "48500000",
      currency: "NGN",
      transit_hours: "14",
      confidence: "0.99",
      raw_text: "15t closed truck Ikeja->Garki NGN 485,000",
      parsed_by: "api",
      score: "0.93",
      score_breakdown: {
        parts: {
          cost: { weight: 0.3, value: 0.92, contribution: 0.276 },
          on_time: { weight: 0.25, value: 0.94, contribution: 0.235 },
        },
      },
      round: 1,
    },
  ];

  const approvals: MockApproval[] = [
    {
      id: "app-1",
      shipment_id: "shp-90014",
      proposed_action_id: "pa-1",
      token: "tok-90014-maersk",
      state: "PENDING",
      summary: "Book Maersk West Africa Feeder (Lagos → Tema multimodal corridor)",
      rationale:
        "Highest weighted carrier score (91/100) with lowest cargo damage rate (0.8%) for 12,000 kg industrial valves. Exceeds auto-approve ceiling of ₦500,000.",
      amount_minor: "142500000",
      currency: "NGN",
      requested_at: minsAgo(22),
      expires_at: hoursFromNow(6),
    },
    {
      id: "app-2",
      shipment_id: "shp-84210",
      proposed_action_id: "pa-2",
      token: "tok-84210-hazmat",
      state: "PENDING",
      summary: "Book Onne → Apapa Coastal Hazmat Barge (Class 3 Marine Sealant)",
      rationale:
        "Hazmat Class 3 consignments always require human sign-off under policy v3 regardless of carrier rate.",
      amount_minor: "118000000",
      currency: "NGN",
      requested_at: minsAgo(45),
      expires_at: hoursFromNow(10),
    },
  ];

  const exceptions: MockException[] = [
    {
      id: "exc-1",
      shipment_id: "shp-82931",
      kind: "ETA_DRIFT_SLA_RISK",
      severity: "HIGH",
      detected_by: "eta.drift_detector",
      state: "OPEN",
      detail: { drift_hours: 4.2, corridor: "Lokoja-Abuja" },
      created_at: minsAgo(14),
    },
    {
      id: "exc-2",
      shipment_id: "shp-82932",
      kind: "INCOMPLETE_DESTINATION",
      severity: "MEDIUM",
      detected_by: "order.validator",
      state: "OPEN",
      detail: { missing_field: "destination.address" },
      created_at: minsAgo(38),
    },
  ];

  const conveyances: MockConveyance[] = [
    {
      id: "veh-1",
      mode: "ROAD",
      kind: "15t Box Truck",
      registration: "LAG-482-KT",
      carrier_code: "KOBO360",
      carrier_name: "Kobo360 Freight Network",
      capacity_kg: "15000",
      capacity_cbm: "48",
      reefer: false,
      hazmat_certified: false,
      active: true,
      assigned_to: "LG-82931",
      leg_state: "IN_TRANSIT",
      last_seen_at: minsAgo(6),
      last_lat: "7.8023",
      last_lon: "6.7333",
      last_speed: "62",
    },
    {
      id: "veh-2",
      mode: "ROAD",
      kind: "20ft Container Chassis",
      registration: "LAG-903-XC",
      carrier_code: "KOBO360",
      carrier_name: "Kobo360 Freight Network",
      capacity_kg: "24000",
      capacity_cbm: "33",
      reefer: false,
      hazmat_certified: true,
      active: true,
      assigned_to: "LG-90014",
      leg_state: "AT_ORIGIN",
      last_seen_at: minsAgo(18),
      last_lat: "6.6018",
      last_lon: "3.3515",
      last_speed: "0",
    },
    {
      id: "veh-3",
      mode: "ROAD",
      kind: "Reefer Sprinter",
      registration: "ABJ-210-RF",
      carrier_code: "GIG-LOG",
      carrier_name: "GIG Logistics Express",
      capacity_kg: "4500",
      capacity_cbm: "18",
      reefer: true,
      hazmat_certified: false,
      active: true,
      assigned_to: "LG-84102",
      leg_state: "IN_TRANSIT",
      last_seen_at: minsAgo(4),
      last_lat: "11.9810",
      last_lon: "8.5140",
      last_speed: "54",
    },
    {
      id: "veh-4",
      mode: "ROAD",
      kind: "10t Box Truck",
      registration: "ABJ-771-MN",
      carrier_code: "GIG-LOG",
      carrier_name: "GIG Logistics Express",
      capacity_kg: "10000",
      capacity_cbm: "36",
      reefer: false,
      hazmat_certified: false,
      active: true,
      assigned_to: null,
      leg_state: null,
      last_seen_at: minsAgo(55),
      last_lat: "9.0579",
      last_lon: "7.4951",
      last_speed: "0",
    },
  ];

  const drivers: MockDriver[] = [
    {
      id: "drv-1",
      name: "Ibrahim Musa",
      phone: "+234 803 551 0188",
      licence_number: "LAG-882910-A",
      licence_expiry: daysFromNow(240),
      hazmat_certified: false,
      active: true,
      carrier_code: "KOBO360",
      carrier_name: "Kobo360 Freight Network",
      assigned_to: "LG-82931",
      days_to_expiry: "240",
    },
    {
      id: "drv-2",
      name: "Emeka Nwosu",
      phone: "+234 805 319 7721",
      licence_number: "LAG-441082-H",
      licence_expiry: daysFromNow(18),
      hazmat_certified: true,
      active: true,
      carrier_code: "KOBO360",
      carrier_name: "Kobo360 Freight Network",
      assigned_to: "LG-90014",
      days_to_expiry: "18",
    },
    {
      id: "drv-3",
      name: "Sadiq Abubakar",
      phone: "+234 809 814 2209",
      licence_number: "ABJ-910244-C",
      licence_expiry: daysFromNow(145),
      hazmat_certified: false,
      active: true,
      carrier_code: "GIG-LOG",
      carrier_name: "GIG Logistics Express",
      assigned_to: "LG-84102",
      days_to_expiry: "145",
    },
  ];

  const orders: MockOrder[] = [
    {
      id: "ord-1",
      reference: "PO-2026-8841",
      state: "CONFIRMED",
      source: "API",
      currency: "NGN",
      ordered_at: daysAgo(1),
      required_by: hoursFromNow(9),
      customer: "ABC Retail Ltd",
      items: "1",
    },
    {
      id: "ord-2",
      reference: "PO-2026-8839",
      state: "CONFIRMED",
      source: "EMAIL",
      currency: "USD",
      ordered_at: daysAgo(2),
      required_by: hoursFromNow(56),
      customer: "Tema Trading Co",
      items: "2",
    },
    {
      id: "ord-3",
      reference: "PO-2026-8835",
      state: "NEEDS_INFO",
      source: "WHATSAPP",
      currency: "NGN",
      ordered_at: daysAgo(1),
      required_by: hoursFromNow(18),
      customer: "ABC Retail Ltd",
      items: "1",
    },
    {
      id: "ord-4",
      reference: "PO-2026-8830",
      state: "CONFIRMED",
      source: "CSV",
      currency: "NGN",
      ordered_at: daysAgo(2),
      required_by: hoursFromNow(11),
      customer: "Zenith Pharma Group",
      items: "1",
    },
  ];

  const contacts: MockContact[] = [
    {
      id: "ct-1",
      channel: "WHATSAPP",
      external_id: "+2348034119021",
      display_name: "Chinedu Okafor (ABC Retail)",
      escalated_at: null,
      escalation_reason: null,
      draft: { destination_city: "Abuja", cargo: "80 cartons" },
      last_seen_at: minsAgo(38),
      last_shipment_id: "shp-82932",
    },
    {
      id: "ct-2",
      channel: "GMAIL",
      external_id: "ops@tematrading.gh",
      display_name: "Kwame Mensah (Tema Trading)",
      escalated_at: minsAgo(25),
      escalation_reason: "Customer requested expedited customs clearance before port cutoff.",
      draft: null,
      last_seen_at: minsAgo(25),
      last_shipment_id: "shp-90014",
    },
    {
      id: "ct-3",
      channel: "TELEGRAM",
      external_id: "@zenith_dispatch",
      display_name: "Amina Bello (Zenith Pharma)",
      escalated_at: null,
      escalation_reason: null,
      draft: null,
      last_seen_at: minsAgo(12),
      last_shipment_id: "shp-84102",
    },
  ];

  const communications: MockCommunication[] = [
    {
      id: "comm-1",
      shipment_id: "shp-82931",
      customer_id: "cust-abc",
      contact_id: "ct-1",
      channel: "WHATSAPP",
      direction: "OUTBOUND",
      recipient: "+2348034119021",
      subject: "Delay alert · LG-82931",
      body: "LG-82931 (Lagos → Abuja) encountered corridor congestion near Lokoja. Revised ETA is ~4 hours later; operations is monitoring.",
      state: "SENT",
      safety_checked: true,
      created_at: minsAgo(12),
    },
    {
      id: "comm-2",
      shipment_id: "shp-90014",
      customer_id: "cust-tema",
      contact_id: "ct-2",
      channel: "GMAIL",
      direction: "INBOUND",
      recipient: "ops@tematrading.gh",
      subject: "Re: LG-90014 Tema Vessel Schedule",
      body: "Can we confirm Tema port clearance paperwork is filed before Friday afternoon?",
      state: "RECEIVED",
      safety_checked: true,
      created_at: minsAgo(25),
    },
    {
      id: "comm-3",
      shipment_id: "shp-84102",
      customer_id: "cust-zenith",
      contact_id: "ct-3",
      channel: "TELEGRAM",
      direction: "INBOUND",
      recipient: "@zenith_dispatch",
      subject: null,
      body: "Checking cold chain probe reading for LG-84102 into Kano.",
      state: "RECEIVED",
      safety_checked: true,
      created_at: minsAgo(16),
    },
    {
      id: "comm-4",
      shipment_id: "shp-84102",
      customer_id: "cust-zenith",
      contact_id: "ct-3",
      channel: "TELEGRAM",
      direction: "OUTBOUND",
      recipient: "@zenith_dispatch",
      subject: null,
      body: "LG-84102 departed Kano cargo gate on reefer van ABJ-210-RF at 4.1°C; ETA within SLA.",
      state: "SENT",
      safety_checked: true,
      created_at: minsAgo(12),
    },
  ];

  const documents: MockDocument[] = [
    {
      id: "doc-1",
      shipment_id: "shp-82931",
      kind: "BOL",
      direction: "OUTBOUND",
      filename: "BOL-LG-82931.pdf",
      extraction_model: "nvidia/nemotron-3.5-super-vl",
      extraction_confidence: "0.97",
      verified_at: minsAgo(230),
      created_at: minsAgo(240),
    },
    {
      id: "doc-2",
      shipment_id: "shp-90014",
      kind: "COMMERCIAL_INVOICE",
      direction: "INBOUND",
      filename: "CI-TEMA-90014.pdf",
      extraction_model: "nvidia/nemotron-3.5-super-vl",
      extraction_confidence: "0.93",
      verified_at: minsAgo(60),
      created_at: minsAgo(90),
    },
    {
      id: "doc-3",
      shipment_id: "shp-84001",
      kind: "POD",
      direction: "INBOUND",
      filename: "POD-LG-84001-signed.jpg",
      extraction_model: "nvidia/nemotron-3.5-super-vl",
      extraction_confidence: "0.78",
      verified_at: null,
      created_at: minsAgo(195),
    },
  ];

  const customs: MockCustoms[] = [
    {
      id: "custm-1",
      shipment_id: "shp-90014",
      direction: "EXPORT",
      clearance_state: "SUBMITTED",
      hs_codes: ["8481.80.90", "7307.99.10"],
      broker: "ECOWAS Customs Brokers Ltd",
      submitted_at: minsAgo(55),
    },
    {
      id: "custm-2",
      shipment_id: "shp-84318",
      direction: "EXPORT",
      clearance_state: "CLEARED",
      hs_codes: ["8471.70.10"],
      broker: "Kotoka Air Clearance",
      submitted_at: daysAgo(1),
    },
  ];

  const workItems: MockWorkItem[] = [
    {
      id: "wi-1",
      shipment_id: "shp-82931",
      kind: "exception.reason",
      state: "RUNNING",
      attempts: 1,
      last_error: null,
      run_after: minsAgo(2),
      created_at: minsAgo(14),
      updated_at: minsAgo(2),
    },
    {
      id: "wi-2",
      shipment_id: "shp-84305",
      kind: "carrier.source_quotes",
      state: "PENDING",
      attempts: 0,
      last_error: null,
      run_after: hoursFromNow(0.1),
      created_at: minsAgo(8),
      updated_at: minsAgo(8),
    },
    {
      id: "wi-3",
      shipment_id: "shp-84102",
      kind: "tracking.poll",
      state: "DONE",
      attempts: 1,
      last_error: null,
      run_after: minsAgo(10),
      created_at: minsAgo(15),
      updated_at: minsAgo(9),
    },
  ];

  const agentRuns: MockAgentRun[] = [
    {
      id: "ar-1",
      shipment_id: "shp-82931",
      agent: "exception-agent",
      job: "Investigate delay",
      model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
      status: "OK",
      latency_ms: 1420,
      prompt_tokens: 940,
      completion_tokens: 310,
      created_at: minsAgo(13),
      response: { reasoning: "Lokoja bridge bottleneck detected via telemetry." },
    },
    {
      id: "ar-2",
      shipment_id: "shp-90014",
      agent: "quote-parser",
      job: "Parse carrier quote",
      model: "nvidia/nemotron-nano-9b-v2",
      status: "OK",
      latency_ms: 480,
      prompt_tokens: 410,
      completion_tokens: 145,
      created_at: minsAgo(24),
      response: { reasoning: "Extracted NGN 1,425,000 all-in feeder rate." },
    },
    {
      id: "ar-3",
      shipment_id: "shp-84102",
      agent: "support-agent",
      job: "Answer customer",
      model: "nvidia/nemotron-nano-9b-v2",
      status: "OK",
      latency_ms: 390,
      prompt_tokens: 380,
      completion_tokens: 112,
      created_at: minsAgo(12),
      response: {},
    },
  ];

  const toolCalls: MockToolCall[] = [
    {
      id: "tc-1",
      shipment_id: "shp-82931",
      tool: "notify.customer_whatsapp",
      tier: 1,
      state: "DONE",
      error: null,
      request: { template: "eta_drift_notice" },
      created_at: minsAgo(12),
    },
    {
      id: "tc-2",
      shipment_id: "shp-84318",
      tool: "carrier.book_gig",
      tier: 2,
      state: "DONE",
      error: null,
      request: { reference: "LG-84318" },
      created_at: minsAgo(88),
    },
  ];

  const proposedActions: MockProposedAction[] = [
    {
      id: "pa-1",
      shipment_id: "shp-90014",
      agent_run_id: "ar-2",
      action: "carrier.book",
      rationale: "Book Maersk West Africa Feeder for Lagos → Tema multimodal shipment.",
      policy_reason: "Exceeds ₦500,000 auto-approval cap",
      policy_decision: "REQUIRE_APPROVAL",
      state: "PROPOSED",
      params: { round: 1, carrier_code: "MAERSK-WA", amount_minor: 142500000 },
      created_at: minsAgo(22),
    },
    {
      id: "pa-2",
      shipment_id: "shp-84210",
      agent_run_id: null,
      action: "carrier.book",
      rationale: "Book coastal hazmat barge Onne → Apapa for Class 3 marine sealant.",
      policy_reason: "Hazmat Class 3 requires human sign-off",
      policy_decision: "REQUIRE_APPROVAL",
      state: "PROPOSED",
      params: { round: 1, carrier_code: "MAERSK-WA", amount_minor: 118000000 },
      created_at: minsAgo(45),
    },
  ];

  const auditLogs: MockAuditLog[] = [
    {
      id: "aud-1",
      actor: "system@controltower",
      actor_type: "SYSTEM",
      action: "POLICY_ACTIVATED",
      entity_type: "policy",
      created_at: daysAgo(2),
    },
    {
      id: "aud-2",
      actor: "ops.lead@controltower",
      actor_type: "HUMAN",
      action: "APPROVAL_GRANTED",
      entity_type: "approval",
      created_at: daysAgo(1),
    },
  ];

  const channels: MockChannelConnection[] = [
    {
      channel: "TELEGRAM",
      display_name: "Telegram Bot",
      state: "VERIFIED",
      enabled: true,
      config: { username: "ControlTowerOpsBot" },
      has_credentials: true,
      verified_at: daysAgo(2),
      last_inbound_at: minsAgo(16),
      last_error: null,
    },
    {
      channel: "WHATSAPP",
      display_name: "WhatsApp Cloud",
      state: "UNCONFIGURED",
      enabled: false,
      config: {},
      has_credentials: false,
      verified_at: null,
      last_inbound_at: null,
      last_error: null,
    },
    {
      channel: "GMAIL",
      display_name: "Gmail Support",
      state: "UNCONFIGURED",
      enabled: false,
      config: {},
      has_credentials: false,
      verified_at: null,
      last_inbound_at: null,
      last_error: null,
    },
    {
      channel: "WIDGET",
      display_name: "Website Widget",
      state: "VERIFIED",
      enabled: true,
      config: { allowed_origins: "https://track.controltower.app", site_key: "ct_live_84a91f" },
      has_credentials: true,
      verified_at: daysAgo(3),
      last_inbound_at: minsAgo(38),
      last_error: null,
    },
  ];

  return {
    locations,
    warehouses,
    inventory,
    carriers,
    customers,
    shipments,
    events,
    legs,
    quotes,
    approvals,
    exceptions,
    conveyances,
    drivers,
    orders,
    communications,
    contacts,
    documents,
    customs,
    workItems,
    agentRuns,
    toolCalls,
    proposedActions,
    auditLogs,
    assistantMessages: [],
    channels,
  };
}

export function reviveSeedDates(raw: Partial<OperationalSeed> | undefined): OperationalSeed {
  const base = createOperationalSeed();
  if (!raw) return base;
  return {
    ...base,
    ...raw,
    shipments: Array.isArray(raw.shipments)
      ? raw.shipments.map((s) => ({
          ...s,
          deadline: new Date(s.deadline),
          created_at: new Date(s.created_at),
          updated_at: new Date(s.updated_at),
        }))
      : base.shipments,
    events: Array.isArray(raw.events)
      ? raw.events.map((e) => ({ ...e, created_at: new Date(e.created_at) }))
      : base.events,
    approvals: Array.isArray(raw.approvals)
      ? raw.approvals.map((a) => ({
          ...a,
          requested_at: new Date(a.requested_at),
          expires_at: new Date(a.expires_at),
          decided_at: a.decided_at ? new Date(a.decided_at) : null,
        }))
      : base.approvals,
    exceptions: Array.isArray(raw.exceptions)
      ? raw.exceptions.map((e) => ({ ...e, created_at: new Date(e.created_at) }))
      : base.exceptions,
    conveyances: Array.isArray(raw.conveyances)
      ? raw.conveyances.map((v) => ({
          ...v,
          last_seen_at: v.last_seen_at ? new Date(v.last_seen_at) : null,
        }))
      : base.conveyances,
    drivers: Array.isArray(raw.drivers)
      ? raw.drivers.map((d) => ({ ...d, licence_expiry: new Date(d.licence_expiry) }))
      : base.drivers,
    orders: Array.isArray(raw.orders)
      ? raw.orders.map((o) => ({
          ...o,
          ordered_at: new Date(o.ordered_at),
          required_by: o.required_by ? new Date(o.required_by) : null,
        }))
      : base.orders,
    communications: Array.isArray(raw.communications)
      ? raw.communications.map((c) => ({ ...c, created_at: new Date(c.created_at) }))
      : base.communications,
    contacts: Array.isArray(raw.contacts)
      ? raw.contacts.map((c) => ({
          ...c,
          last_seen_at: new Date(c.last_seen_at),
          escalated_at: c.escalated_at ? new Date(c.escalated_at) : null,
        }))
      : base.contacts,
    documents: Array.isArray(raw.documents)
      ? raw.documents.map((d) => ({
          ...d,
          created_at: new Date(d.created_at),
          verified_at: d.verified_at ? new Date(d.verified_at) : null,
        }))
      : base.documents,
    customs: Array.isArray(raw.customs)
      ? raw.customs.map((c) => ({
          ...c,
          submitted_at: c.submitted_at ? new Date(c.submitted_at) : null,
        }))
      : base.customs,
    workItems: Array.isArray(raw.workItems)
      ? raw.workItems.map((w) => ({
          ...w,
          run_after: new Date(w.run_after),
          created_at: new Date(w.created_at),
          updated_at: new Date(w.updated_at),
        }))
      : base.workItems,
    agentRuns: Array.isArray(raw.agentRuns)
      ? raw.agentRuns.map((a) => ({ ...a, created_at: new Date(a.created_at) }))
      : base.agentRuns,
    toolCalls: Array.isArray(raw.toolCalls)
      ? raw.toolCalls.map((t) => ({ ...t, created_at: new Date(t.created_at) }))
      : base.toolCalls,
    proposedActions: Array.isArray(raw.proposedActions)
      ? raw.proposedActions.map((p) => ({ ...p, created_at: new Date(p.created_at) }))
      : base.proposedActions,
    auditLogs: Array.isArray(raw.auditLogs)
      ? raw.auditLogs.map((a) => ({ ...a, created_at: new Date(a.created_at) }))
      : base.auditLogs,
    assistantMessages: Array.isArray(raw.assistantMessages)
      ? raw.assistantMessages.map((m) => ({ ...m, created_at: new Date(m.created_at) }))
      : base.assistantMessages,
    channels: Array.isArray(raw.channels)
      ? raw.channels.map((ch) => ({
          ...ch,
          verified_at: ch.verified_at ? new Date(ch.verified_at) : null,
          last_inbound_at: ch.last_inbound_at ? new Date(ch.last_inbound_at) : null,
        }))
      : base.channels,
  };
}

export function generateMockAssistantTurn(
  seed: OperationalSeed,
  shipmentId: string,
  userId: string,
  question: string,
): MockAssistantMessage {
  const s = seed.shipments.find((x) => x.id === shipmentId);
  const exc = seed.exceptions.find((e) => e.shipment_id === shipmentId && e.state !== "RESOLVED");
  const qs = seed.quotes.filter((q) => q.shipment_id === shipmentId);
  const quoteSummary =
    qs.length > 0
      ? qs.map((q) => `${q.carrier_name} (${q.transit_hours}h)`).join("; ")
      : null;

  const reply = buildMockAssistantReply({
    reference: s?.reference ?? "Shipment",
    question,
    state: s?.state ?? "PLANNED",
    originCity: extractCity(s?.origin),
    destinationCity: extractCity(s?.destination),
    customer: s?.customer_ref ?? null,
    exceptionSummary: exc
      ? `${exc.kind.replace(/_/g, " ").toLowerCase()} (${exc.severity})`
      : null,
    quoteSummary,
  });

  return {
    id: `ast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    shipment_id: shipmentId,
    user_id: userId,
    role: "assistant",
    body: reply.body,
    state: "DONE",
    confidence: reply.confidence,
    next_step: reply.next_step,
    created_at: new Date(Date.now() + 10),
  };
}

export function generateMockSupportReplyMessage(
  seed: OperationalSeed,
  shipmentId: string | null,
  contactId: string,
  question: string,
): MockCommunication {
  const s = shipmentId ? seed.shipments.find((x) => x.id === shipmentId) : undefined;
  const openEx = s
    ? seed.exceptions.some((e) => e.shipment_id === s.id && e.state !== "RESOLVED")
    : false;
  const body = buildMockSupportReply({
    reference: s?.reference ?? null,
    question,
    status: s?.state,
    origin: extractCity(s?.origin) || null,
    destination: extractCity(s?.destination) || null,
    promisedBy: s?.deadline ? s.deadline.toISOString() : null,
    carrier: (s?.booking?.carrier_code as string) ?? null,
    delayed: openEx || s?.state === "EXCEPTION",
  });
  return {
    id: `comm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    shipment_id: shipmentId,
    customer_id: s?.customer_id ?? null,
    contact_id: contactId,
    channel: "WIDGET",
    direction: "OUTBOUND",
    recipient: null,
    subject: null,
    body,
    state: "SENT",
    safety_checked: true,
    created_at: new Date(Date.now() + 10),
  };
}
