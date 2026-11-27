export interface LocationRecord {
  id: string;
  type: "WAREHOUSE" | "PORT" | "AIRPORT" | "RAIL_TERMINAL";
  name: string;
  code: string;
  city: string;
  country: string;
  latitude: string;
  longitude: string;
}

export interface WarehouseRecord {
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

export interface InventoryRecord {
  warehouse: string;
  sku: string;
  on_hand: number;
  reserved: number;
  available: number;
}

export interface CarrierRecord {
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

export interface CustomerRecord {
  id: string;
  code: string;
  name: string;
  sla_hours: number | null;
  payment_terms: string | null;
  default_currency: string;
  contacts: { name?: string; email?: string; phone?: string }[];
  active: boolean;
}

export interface ShipmentRecord {
  id: string;
  reference: string;
  state: string;
  version: number;
  customer_id: string | null;
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

export interface EventRecord {
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

export interface LegRecord {
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

export interface QuoteRecord {
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

export interface ApprovalRecord {
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

export interface ExceptionRecord {
  id: string;
  shipment_id: string;
  kind: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  detected_by: string;
  state: "OPEN" | "RESOLVED";
  detail: Record<string, unknown>;
  created_at: Date;
}

export interface ConveyanceRecord {
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

export interface DriverRecord {
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
  duty_status?: "AVAILABLE" | "ON_ROUTE" | "RESTING" | "OFF_DUTY";
  current_lat?: string | null;
  current_lon?: string | null;
  current_city?: string | null;
  last_ping_at?: Date | null;
  hos_drive_remaining_hours?: number;
  hos_duty_remaining_hours?: number;
  vehicle_registration?: string | null;
  equipment_type?: string | null;
  reefer_capable?: boolean;
  max_payload_kg?: number | null;
}

export interface OrderRecord {
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

export interface CommunicationRecord {
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

export interface ContactRecord {
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

export interface DocumentRecord {
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

export interface CustomsRecord {
  id: string;
  shipment_id: string;
  direction: string;
  clearance_state: string;
  hs_codes: string[];
  broker: string;
  submitted_at: Date | null;
}

export interface WorkItemRecord {
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

export interface AgentRunRecord {
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

export interface ToolCallRecord {
  id: string;
  shipment_id: string | null;
  tool: string;
  tier: number;
  state: string;
  error: string | null;
  request: Record<string, unknown>;
  created_at: Date;
}

export interface ProposedActionRecord {
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

export interface AuditLogRecord {
  id: string;
  actor: string;
  actor_type: string;
  action: string;
  entity_type: string | null;
  created_at: Date;
}

export interface AssistantMessageRecord {
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

export interface ChannelConnectionRecord {
  channel: string;
  display_name: string;
  state: string;
  enabled: boolean;
  config: Record<string, unknown>;
  credentials?: string | null;
  cursor?: string | null;
  has_credentials: boolean;
  verified_at: Date | null;
  last_inbound_at: Date | null;
  last_error: string | null;
}

export interface PolicyRecord {
  version: number;
  name: string;
  created_at: Date;
  rules: Record<string, unknown>;
}

export interface CurrencyRecord {
  code: string;
  name: string;
  minor_unit_exponent: number;
}

export interface FxRateRecord {
  base: string;
  quote: string;
  rate: string;
  as_of: Date;
  source: string;
}

export interface MigrationRecord {
  version: string;
  applied_at: Date;
}

export type IntegrationConnectionMode =
  | "PUSH_WEBHOOK"
  | "PULL_API"
  | "POSTGRES_DB"
  | "WEBSITE_EMBED"
  | "FILE_IMPORT";

export interface IntegrationConnectorRecord {
  id: string;
  org_id: string;
  name: string;
  system_type: string;
  category: string;
  connection_mode?: IntegrationConnectionMode;
  status: "ACTIVE" | "PAUSED";
  autonomy_mode: "FULL_AUTONOMOUS" | "ASSISTED_APPROVAL" | "SYNC_ONLY";
  auto_takeover?: boolean;
  api_key_prefix: string;
  api_key_hash: string;
  webhook_secret_hash: string;
  outbound_webhook_url: string | null;
  outbound_events: string[];
  source_url?: string | null;
  source_auth_sealed?: string | null;
  db_config_sealed?: string | null;
  db_tables?: string[];
  field_mapping: Record<string, string>;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  last_sync_at: Date | null;
  events_processed: number;
  errors_count: number;
}

export interface IntegrationEventRecord {
  id: string;
  org_id: string;
  connector_id: string;
  connector_name: string;
  direction: "INBOUND" | "OUTBOUND";
  format: string;
  entity_type: string;
  status: "PROCESSED" | "DUPLICATE" | "FAILED" | "DELIVERED";
  idempotency_key: string | null;
  external_ref: string | null;
  shipment_ref: string | null;
  order_ref: string | null;
  mapped_by: string;
  summary: string;
  delegated_agents: string[];
  raw_preview: string;
  normalized_payload: Record<string, unknown>;
  outbound_status: string | null;
  latency_ms: number;
  error: string | null;
  created_at: Date;
}

export interface OperationalState {
  locations: LocationRecord[];
  warehouses: WarehouseRecord[];
  inventory: InventoryRecord[];
  carriers: CarrierRecord[];
  customers: CustomerRecord[];
  shipments: ShipmentRecord[];
  events: EventRecord[];
  legs: LegRecord[];
  quotes: QuoteRecord[];
  approvals: ApprovalRecord[];
  exceptions: ExceptionRecord[];
  conveyances: ConveyanceRecord[];
  drivers: DriverRecord[];
  orders: OrderRecord[];
  communications: CommunicationRecord[];
  contacts: ContactRecord[];
  documents: DocumentRecord[];
  customs: CustomsRecord[];
  workItems: WorkItemRecord[];
  agentRuns: AgentRunRecord[];
  toolCalls: ToolCallRecord[];
  proposedActions: ProposedActionRecord[];
  auditLogs: AuditLogRecord[];
  assistantMessages: AssistantMessageRecord[];
  channels: ChannelConnectionRecord[];
  policies: PolicyRecord[];
  currencies: CurrencyRecord[];
  fxRates: FxRateRecord[];
  migrations: MigrationRecord[];
  integrationConnectors: IntegrationConnectorRecord[];
  integrationEvents: IntegrationEventRecord[];
}

function defaultChannelSlots(): ChannelConnectionRecord[] {
  return [
    {
      channel: "TELEGRAM",
      display_name: "Telegram Bot",
      state: "UNCONFIGURED",
      enabled: false,
      config: {},
      has_credentials: false,
      verified_at: null,
      last_inbound_at: null,
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
      state: "UNCONFIGURED",
      enabled: false,
      config: {},
      has_credentials: false,
      verified_at: null,
      last_inbound_at: null,
      last_error: null,
    },
  ];
}

export function createEmptyOperationalState(): OperationalState {
  return {
    locations: [],
    warehouses: [],
    inventory: [],
    carriers: [],
    customers: [],
    shipments: [],
    events: [],
    legs: [],
    quotes: [],
    approvals: [],
    exceptions: [],
    conveyances: [],
    drivers: [],
    orders: [],
    communications: [],
    contacts: [],
    documents: [],
    customs: [],
    workItems: [],
    agentRuns: [],
    toolCalls: [],
    proposedActions: [],
    auditLogs: [],
    assistantMessages: [],
    channels: defaultChannelSlots(),
    policies: [],
    currencies: [],
    fxRates: [],
    migrations: [],
    integrationConnectors: [],
    integrationEvents: [],
  };
}

export function reviveOperationalStateDates(
  raw: Partial<OperationalState> | undefined,
): OperationalState {
  const empty = createEmptyOperationalState();
  if (!raw) return empty;
  return {
    locations: Array.isArray(raw.locations) ? raw.locations : [],
    warehouses: Array.isArray(raw.warehouses) ? raw.warehouses : [],
    inventory: Array.isArray(raw.inventory) ? raw.inventory : [],
    carriers: Array.isArray(raw.carriers) ? raw.carriers : [],
    customers: Array.isArray(raw.customers) ? raw.customers : [],
    shipments: Array.isArray(raw.shipments)
      ? raw.shipments.map((s) => ({
          ...s,
          deadline: new Date(s.deadline),
          created_at: new Date(s.created_at),
          updated_at: new Date(s.updated_at),
        }))
      : [],
    events: Array.isArray(raw.events)
      ? raw.events.map((e) => ({ ...e, created_at: new Date(e.created_at) }))
      : [],
    legs: Array.isArray(raw.legs) ? raw.legs : [],
    quotes: Array.isArray(raw.quotes) ? raw.quotes : [],
    approvals: Array.isArray(raw.approvals)
      ? raw.approvals.map((a) => ({
          ...a,
          requested_at: new Date(a.requested_at),
          expires_at: new Date(a.expires_at),
          decided_at: a.decided_at ? new Date(a.decided_at) : null,
        }))
      : [],
    exceptions: Array.isArray(raw.exceptions)
      ? raw.exceptions.map((e) => ({ ...e, created_at: new Date(e.created_at) }))
      : [],
    conveyances: Array.isArray(raw.conveyances)
      ? raw.conveyances.map((v) => ({
          ...v,
          last_seen_at: v.last_seen_at ? new Date(v.last_seen_at) : null,
        }))
      : [],
    drivers: Array.isArray(raw.drivers)
      ? raw.drivers.map((d) => ({
          ...d,
          licence_expiry: new Date(d.licence_expiry),
          last_ping_at: d.last_ping_at ? new Date(d.last_ping_at) : null,
        }))
      : [],
    orders: Array.isArray(raw.orders)
      ? raw.orders.map((o) => ({
          ...o,
          ordered_at: new Date(o.ordered_at),
          required_by: o.required_by ? new Date(o.required_by) : null,
        }))
      : [],
    communications: Array.isArray(raw.communications)
      ? raw.communications.map((c) => ({ ...c, created_at: new Date(c.created_at) }))
      : [],
    contacts: Array.isArray(raw.contacts)
      ? raw.contacts.map((c) => ({
          ...c,
          last_seen_at: new Date(c.last_seen_at),
          escalated_at: c.escalated_at ? new Date(c.escalated_at) : null,
        }))
      : [],
    documents: Array.isArray(raw.documents)
      ? raw.documents.map((d) => ({
          ...d,
          created_at: new Date(d.created_at),
          verified_at: d.verified_at ? new Date(d.verified_at) : null,
        }))
      : [],
    customs: Array.isArray(raw.customs)
      ? raw.customs.map((c) => ({
          ...c,
          submitted_at: c.submitted_at ? new Date(c.submitted_at) : null,
        }))
      : [],
    workItems: Array.isArray(raw.workItems)
      ? raw.workItems.map((w) => ({
          ...w,
          run_after: new Date(w.run_after),
          created_at: new Date(w.created_at),
          updated_at: new Date(w.updated_at),
        }))
      : [],
    agentRuns: Array.isArray(raw.agentRuns)
      ? raw.agentRuns.map((a) => ({ ...a, created_at: new Date(a.created_at) }))
      : [],
    toolCalls: Array.isArray(raw.toolCalls)
      ? raw.toolCalls.map((t) => ({ ...t, created_at: new Date(t.created_at) }))
      : [],
    proposedActions: Array.isArray(raw.proposedActions)
      ? raw.proposedActions.map((p) => ({ ...p, created_at: new Date(p.created_at) }))
      : [],
    auditLogs: Array.isArray(raw.auditLogs)
      ? raw.auditLogs.map((a) => ({ ...a, created_at: new Date(a.created_at) }))
      : [],
    assistantMessages: Array.isArray(raw.assistantMessages)
      ? raw.assistantMessages.map((m) => ({ ...m, created_at: new Date(m.created_at) }))
      : [],
    channels: Array.isArray(raw.channels)
      ? raw.channels.map((ch) => ({
          ...ch,
          credentials: ch.credentials ?? null,
          cursor: ch.cursor ?? null,
          verified_at: ch.verified_at ? new Date(ch.verified_at) : null,
          last_inbound_at: ch.last_inbound_at ? new Date(ch.last_inbound_at) : null,
        }))
      : empty.channels,
    policies: Array.isArray(raw.policies)
      ? raw.policies.map((p) => ({ ...p, created_at: new Date(p.created_at) }))
      : [],
    currencies: Array.isArray(raw.currencies) ? raw.currencies : [],
    fxRates: Array.isArray(raw.fxRates)
      ? raw.fxRates.map((r) => ({ ...r, as_of: new Date(r.as_of) }))
      : [],
    migrations: Array.isArray(raw.migrations)
      ? raw.migrations.map((m) => ({ ...m, applied_at: new Date(m.applied_at) }))
      : [],
    integrationConnectors: Array.isArray(raw.integrationConnectors)
      ? raw.integrationConnectors.map((c) => ({
          ...c,
          connection_mode: c.connection_mode ?? "PUSH_WEBHOOK",
          auto_takeover: c.auto_takeover ?? true,
          source_url: c.source_url ?? null,
          source_auth_sealed: c.source_auth_sealed ?? null,
          db_config_sealed: c.db_config_sealed ?? null,
          db_tables: Array.isArray(c.db_tables) ? c.db_tables : [],
          created_at: new Date(c.created_at),
          updated_at: new Date(c.updated_at),
          last_sync_at: c.last_sync_at ? new Date(c.last_sync_at) : null,
        }))
      : [],
    integrationEvents: Array.isArray(raw.integrationEvents)
      ? raw.integrationEvents.map((e) => ({
          ...e,
          created_at: new Date(e.created_at),
        }))
      : [],
  };
}
