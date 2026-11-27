export type CodeLang = "curl" | "node" | "python" | "csharp" | "java";
export type WebhookLang = "node" | "python" | "csharp";
export type RecipeId = "erp_order" | "tms_edi" | "whole_db" | "telematics";

export const CODE_LANGS: { id: CodeLang; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "node", label: "Node.js" },
  { id: "python", label: "Python" },
  { id: "csharp", label: "C# (.NET)" },
  { id: "java", label: "Java" },
];

export const WEBHOOK_LANGS: { id: WebhookLang; label: string }[] = [
  { id: "node", label: "Node.js (Express / Next.js)" },
  { id: "python", label: "Python (FastAPI / Flask)" },
  { id: "csharp", label: "C# (ASP.NET Core)" },
];

export interface EndpointSpec {
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  title: string;
  auth: "Connector API Key" | "Session Cookie + Same-Origin" | "Intake Token or Session";
  summary: string;
  rateOrLimit: string;
}

export const API_ENDPOINTS: EndpointSpec[] = [
  {
    id: "ingest",
    method: "POST",
    path: "/api/v1/ingest",
    title: "Universal ERP / TMS / Database Ingest",
    auth: "Connector API Key",
    summary:
      "Ingests orders, master data, inventory, GPS telemetry, and carrier events in JSON, multi-table DB JSON, CSV, NDJSON, SQL dump, or EDI X12. Automatically runs autonomous route planning, carrier scoring, fleet dispatch, and signed outbound callbacks.",
    rateOrLimit: "Up to 2 MB payload · up to 250 records per request",
  },
  {
    id: "shipments",
    method: "GET",
    path: "/api/v1/shipments",
    title: "Query Shipments & Live Dispatch Status",
    auth: "Connector API Key",
    summary:
      "Returns organisation-scoped shipments for reconciliation back into your ERP or TMS, filterable by exact shipment reference or lifecycle state.",
    rateOrLimit: "Returns up to 100 latest shipments per call",
  },
  {
    id: "external-intake",
    method: "POST",
    path: "/api/intake/external",
    title: "Lightweight Structured Order & Exception Intake",
    auth: "Intake Token or Session",
    summary:
      "Accepts lightweight order requests, reroute instructions, customs inquiries, or exception reports from portals and middleware without provisioning a full connector.",
    rateOrLimit: "Single structured event per request",
  },
  {
    id: "preview-map",
    method: "POST",
    path: "/api/integrations/preview-map",
    title: "Dry-Run Schema Detection & Mapping Preview",
    auth: "Session Cookie + Same-Origin",
    summary:
      "Tests how any ERP, TMS, CSV, SQL dump, or EDI X12 payload will be classified and normalized before committing live records.",
    rateOrLimit: "Up to 2 MB payload · previews up to 8 sample records + full entity breakdown",
  },
  {
    id: "connector-sync",
    method: "POST",
    path: "/api/integrations/{id}/sync",
    title: "Trigger Live Pull-API or Read-Only PostgreSQL Sync",
    auth: "Session Cookie + Same-Origin",
    summary:
      "Pulls fresh records on demand from a configured read-only PostgreSQL database or HTTPS Pull API endpoint and feeds them straight into autonomous takeover.",
    rateOrLimit: "Up to 250 records ingested per sync run",
  },
  {
    id: "takeover-sweep",
    method: "POST",
    path: "/api/integrations/takeover",
    title: "Run Autonomous Takeover Sweep",
    auth: "Session Cookie + Same-Origin",
    summary:
      "Scans all open or unbooked shipments in your organisation and runs route planning, carrier scoring, fleet vehicle assignment, and policy-gated booking.",
    rateOrLimit: "Organisation-wide sweep · supports FULL_AUTONOMOUS or ASSISTED_APPROVAL",
  },
];

export interface CanonicalEntityRow {
  entity: string;
  tableOrDomain: string;
  erpTmsExamples: string;
  autonomousAction: string;
}

export const CANONICAL_ENTITIES: CanonicalEntityRow[] = [
  {
    entity: "WAREHOUSE",
    tableOrDomain: "Warehouses & Locations",
    erpTmsExamples: "SAP Plant (WERKS), NetSuite Location, WMS Facility",
    autonomousAction: "Upserts facility & geocoded location node for origin/destination routing",
  },
  {
    entity: "CARRIER",
    tableOrDomain: "Approved Carrier Network",
    erpTmsExamples: "SCAC directory, TMS Carrier Master, 3PL Rate Cards",
    autonomousAction: "Registers carrier modes, on-time SLA, and rate benchmarks for live quote scoring",
  },
  {
    entity: "FLEET_VEHICLE",
    tableOrDomain: "Fleet & Conveyances",
    erpTmsExamples: "Tractors, reefers, box trucks, ocean/air assets",
    autonomousAction: "Makes idle assets eligible for automated load-to-vehicle dispatch matching",
  },
  {
    entity: "DRIVER",
    tableOrDomain: "Driver Roster",
    erpTmsExamples: "TMS Driver Master, CDL credentials, home depot",
    autonomousAction: "Syncs driver availability and compliance metadata across operations",
  },
  {
    entity: "CUSTOMER",
    tableOrDomain: "Customer Directory",
    erpTmsExamples: "SAP KUNNR, NetSuite Customer, CRM Accounts",
    autonomousAction: "Upserts customer contact and links incoming orders to account history",
  },
  {
    entity: "INVENTORY_SYNC",
    tableOrDomain: "Warehouse Stock & SKUs",
    erpTmsExamples: "WMS on-hand qty, reorder points, SKU catalog",
    autonomousAction: "Updates stock balances and flags low-inventory alerts automatically",
  },
  {
    entity: "ORDER",
    tableOrDomain: "Purchase / Sales Orders & Shipments",
    erpTmsExamples: "SAP VBELN, EDI 204 Load Tender, NetSuite SalesOrder, Storefront checkout",
    autonomousAction:
      "Creates order + shipment, computes route legs, scores carriers, assigns fleet unit, and books or queues approval",
  },
  {
    entity: "TELEMETRY",
    tableOrDomain: "Live GPS & Cold-Chain Sensors",
    erpTmsExamples: "Samsara, Geotab, Project44 GPS lat/lng, speed, reefer °C",
    autonomousAction: "Updates live map coordinates, ETA drift, and temperature excursions",
  },
  {
    entity: "SHIPMENT_EVENT",
    tableOrDomain: "Carrier Milestones & Exceptions",
    erpTmsExamples: "EDI 214 Status/Delay, POD signed, customs hold",
    autonomousAction: "Advances shipment state, opens exception workflows, and fires outbound callbacks",
  },
];

export interface FieldAliasRow {
  canonicalField: string;
  acceptedAliases: string;
  notes: string;
}

export const FIELD_ALIASES: FieldAliasRow[] = [
  {
    canonicalField: "externalRef / order_number",
    acceptedAliases: "order_number, VBELN, po_number, reference, bol_number, shipment_id, id",
    notes: "Used for cross-system traceability and idempotent deduplication",
  },
  {
    canonicalField: "originCity / originCountry",
    acceptedAliases: "origin_city, ship_from_city, WERKS_CITY, pickup_city, origin.city",
    notes: "Country defaults safely if omitted; pair with warehouse code when available",
  },
  {
    canonicalField: "destinationCity / destinationCountry",
    acceptedAliases: "destination_city, ship_to_city, consignee_city, delivery_city, destination.city",
    notes: "Drives multi-leg corridor routing and transit-time estimates",
  },
  {
    canonicalField: "weightKg",
    acceptedAliases: "weight_kg, BRGEW, gross_weight_kg, total_weight (Shopify grams auto-converted)",
    notes: "Numeric kilograms; Shopify gram values are automatically normalized to kg",
  },
  {
    canonicalField: "cargoValueUsd",
    acceptedAliases: "cargo_value_usd, declared_value, total_price, NETWR, invoice_total",
    notes: "Evaluated against policyMaxAutoSpendUsd to decide auto-book vs approval queue",
  },
  {
    canonicalField: "transportMode",
    acceptedAliases: "transport_mode, mode, service_level, shipment_mode (ROAD, SEA, AIR, RAIL, INTERMODAL)",
    notes: "Matched against approved carriers and eligible fleet vehicles",
  },
  {
    canonicalField: "customerName / customerEmail",
    acceptedAliases: "customer_name, consignee_name, NAME1, buyer_name, email, customer_email",
    notes: "Automatically creates or links the customer profile during ingestion",
  },
  {
    canonicalField: "scac / carrierName",
    acceptedAliases: "scac, carrier_code, carrier_name, vendor_name, LIFNR",
    notes: "Recognizes carrier directory records and preferred-carrier hints",
  },
];

export interface WebhookEventRow {
  event: string;
  trigger: string;
  typicalErpAction: string;
}

export const WEBHOOK_EVENTS: WebhookEventRow[] = [
  {
    event: "order.created",
    trigger: "External order ingested and registered in Control Tower",
    typicalErpAction: "Store Control Tower orderReference & shipmentReference on the ERP order",
  },
  {
    event: "shipment.booked",
    trigger: "Autonomous takeover selected carrier, assigned fleet unit, and booked within spend policy",
    typicalErpAction: "Update TMS tender status to BOOKED and record carrier + confirmation ID",
  },
  {
    event: "approval.requested",
    trigger: "Order exceeded auto-spend limit or connector runs in ASSISTED_APPROVAL mode",
    typicalErpAction: "Flag sales order as pending spend sign-off in ERP workflow",
  },
  {
    event: "telemetry.updated",
    trigger: "GPS position, speed, or reefer sensor reading processed",
    typicalErpAction: "Refresh customer portal ETA and cold-chain compliance log",
  },
  {
    event: "inventory.synced",
    trigger: "Warehouse SKU balance updated from WMS or ERP batch",
    typicalErpAction: "Reconcile available-to-promise inventory levels",
  },
  {
    event: "warehouse.synced / carrier.synced / fleet.synced / driver.synced / customer.synced",
    trigger: "Master-data record created or updated from whole-database sync",
    typicalErpAction: "Mark master-data replication job complete",
  },
];

export interface HttpStatusRow {
  status: string;
  meaning: string;
  remediation: string;
}

export const HTTP_STATUS_MATRIX: HttpStatusRow[] = [
  {
    status: "201 Created",
    meaning: "One or more records were ingested and autonomously processed.",
    remediation: "Inspect results[] for per-record shipmentReference, orchestrationSummary, and takeoverSummary.",
  },
  {
    status: "200 OK",
    meaning: "Request succeeded with zero new mutations (for example, all records were deduplicated via Idempotency-Key).",
    remediation: "Safe to mark delivery complete; no retry needed.",
  },
  {
    status: "400 Bad Request",
    meaning: "Empty body, malformed JSON, or invalid connection URI (such as private/loopback addresses).",
    remediation: "Validate payload syntax and verify external URLs target public HTTPS or PostgreSQL hosts.",
  },
  {
    status: "401 Unauthorized",
    meaning: "Missing, malformed, or revoked connector API key.",
    remediation: "Send Authorization: Bearer ct_live_... or X-API-Key header using an active key from Integrations.",
  },
  {
    status: "403 Forbidden",
    meaning: "Connector is currently PAUSED or caller lacks required organisation role.",
    remediation: "Resume the connector in System → Integrations or verify operator permissions.",
  },
  {
    status: "413 Payload Too Large",
    meaning: "Request body exceeds the 2 MB limit.",
    remediation: "Chunk exports into batches of up to 250 records (NDJSON or JSON array) per request.",
  },
  {
    status: "422 Unprocessable Entity",
    meaning: "Payload parsed cleanly, but every record failed validation or processing.",
    remediation: "Check results[i].error for the exact missing field or formatting detail.",
  },
];

export interface RecipeDefinition {
  id: RecipeId;
  label: string;
  systems: string;
  contentType: string;
  summary: string;
  responseSample: string;
}

export const INTEGRATION_RECIPES: RecipeDefinition[] = [
  {
    id: "erp_order",
    label: "ERP Sales / Purchase Order",
    systems: "SAP S/4HANA · Oracle NetSuite · Dynamics 365",
    contentType: "application/json",
    summary:
      "Push outbound sales orders or purchase orders from your ERP whenever a delivery is released. Include an Idempotency-Key header so ERP retries never create duplicate shipments.",
    responseSample: JSON.stringify(
      {
        ok: true,
        connectorId: "conn_sap_prod_01",
        connectorName: "SAP S/4HANA Orders",
        autonomyMode: "FULL_AUTONOMOUS",
        format: "JSON",
        totalReceived: 1,
        processed: 1,
        duplicates: 0,
        failed: 0,
        entityCounts: { ORDER: 1 },
        takeoverSummary: { booked: 1, awaitingApproval: 0 },
        results: [
          {
            index: 0,
            status: "PROCESSED",
            entityType: "ORDER",
            mappedBy: "HEURISTIC",
            externalRef: "SAP-SO-4500091822",
            orderReference: "PO-2026-4108",
            shipmentReference: "LG-90412",
            delegatedAgents: [
              "order-management",
              "warehouse-coordination",
              "shipment-management",
              "route-optimization",
            ],
            summary: "External order SAP-SO-4500091822 (Rotterdam -> Munich)",
            orchestrationSummary:
              "Booked ROAD (835 km, 11h) via EuroLine Freight · assigned TRK-DE-408",
            outboundWebhookStatus: "DELIVERED (200)",
            error: null,
          },
        ],
      },
      null,
      2,
    ),
  },
  {
    id: "tms_edi",
    label: "TMS EDI X12 (204 / 214)",
    systems: "Oracle OTM · Manhattan TMS · Blue Yonder · MercuryGate",
    contentType: "text/plain",
    summary:
      "Post raw ANSI EDI X12 204 Motor Carrier Load Tenders or 214 Shipment Status/Exception messages directly to /api/v1/ingest with Content-Type: text/plain—no external EDI translator required.",
    responseSample: JSON.stringify(
      {
        ok: true,
        connectorId: "conn_otm_edi_02",
        connectorName: "Oracle OTM EDI Gateway",
        autonomyMode: "FULL_AUTONOMOUS",
        format: "EDI_X12",
        totalReceived: 1,
        processed: 1,
        duplicates: 0,
        failed: 0,
        entityCounts: { ORDER: 1 },
        takeoverSummary: { booked: 1, awaitingApproval: 0 },
        results: [
          {
            index: 0,
            status: "PROCESSED",
            entityType: "ORDER",
            mappedBy: "HEURISTIC",
            externalRef: "BOL-992841",
            orderReference: "PO-2026-4109",
            shipmentReference: "LG-90413",
            delegatedAgents: [
              "order-management",
              "shipment-management",
              "route-optimization",
            ],
            summary: "EDI 204 Load Tender BOL-992841 (Dallas -> Atlanta)",
            orchestrationSummary:
              "Booked ROAD (1260 km, 16h) via Heartland Freight · assigned US-TRK-712",
            outboundWebhookStatus: "DELIVERED (200)",
            error: null,
          },
        ],
      },
      null,
      2,
    ),
  },
  {
    id: "whole_db",
    label: "Whole-Database Atomic Sync",
    systems: "ERP + WMS + TMS Master Snapshot",
    contentType: "application/json",
    summary:
      "Send a multi-table JSON object containing warehouses, carriers, fleet, drivers, customers, inventory, and orders in one call. Control Tower automatically unwraps and processes tables in dependency order before running autonomous takeover on every order.",
    responseSample: JSON.stringify(
      {
        ok: true,
        connectorId: "conn_master_sync_03",
        connectorName: "Enterprise Master Sync",
        autonomyMode: "FULL_AUTONOMOUS",
        format: "JSON",
        totalReceived: 7,
        processed: 7,
        duplicates: 0,
        failed: 0,
        entityCounts: {
          WAREHOUSE: 1,
          CARRIER: 1,
          FLEET_VEHICLE: 1,
          DRIVER: 1,
          CUSTOMER: 1,
          INVENTORY_SYNC: 1,
          ORDER: 1,
        },
        takeoverSummary: { booked: 1, awaitingApproval: 0 },
        results: [
          {
            index: 6,
            status: "PROCESSED",
            entityType: "ORDER",
            mappedBy: "HEURISTIC",
            externalRef: "ORD-2026-8841",
            orderReference: "PO-2026-4110",
            shipmentReference: "LG-90414",
            delegatedAgents: [
              "order-management",
              "warehouse-coordination",
              "shipment-management",
              "route-optimization",
            ],
            summary: "External order ORD-2026-8841 (Los Angeles -> Chicago)",
            orchestrationSummary:
              "Booked ROAD (2800 km, 32h) via Apex Freight Lines · assigned TRK-LA-901",
            outboundWebhookStatus: "DELIVERED (200)",
            error: null,
          },
        ],
      },
      null,
      2,
    ),
  },
  {
    id: "telematics",
    label: "Fleet GPS & Cold-Chain Telemetry",
    systems: "Samsara · Geotab · Project44 · Motive",
    contentType: "application/json",
    summary:
      "Stream real-time GPS coordinates, speed, and refrigerated cargo temperature readings so Control Tower updates live map tracking and triggers automatic exception alerts on delays or temperature breaches.",
    responseSample: JSON.stringify(
      {
        ok: true,
        connectorId: "conn_samsara_gps_04",
        connectorName: "Samsara Fleet Telematics",
        autonomyMode: "FULL_AUTONOMOUS",
        format: "JSON",
        totalReceived: 1,
        processed: 1,
        duplicates: 0,
        failed: 0,
        entityCounts: { TELEMETRY: 1 },
        takeoverSummary: { booked: 0, awaitingApproval: 0 },
        results: [
          {
            index: 0,
            status: "PROCESSED",
            entityType: "TELEMETRY",
            mappedBy: "HEURISTIC",
            externalRef: "LG-90412",
            orderReference: null,
            shipmentReference: "LG-90412",
            delegatedAgents: ["shipment-management"],
            summary: "Telemetry ping for LG-90412 (50.1109, 8.6821 · 3.4°C)",
            orchestrationSummary: "Updated live position & verified cold-chain threshold",
            outboundWebhookStatus: "DELIVERED (200)",
            error: null,
          },
        ],
      },
      null,
      2,
    ),
  },
];

function getRecipePayload(recipe: RecipeId): { isRawText: boolean; body: string } {
  switch (recipe) {
    case "erp_order":
      return {
        isRawText: false,
        body: JSON.stringify(
          {
            order_number: "SAP-SO-4500091822",
            customer_name: "Keller Industrial GmbH",
            customer_email: "logistics@keller-industrial.example",
            origin_city: "Rotterdam",
            origin_country: "NL",
            destination_city: "Munich",
            destination_country: "DE",
            cargo_description: "Precision CNC Hydraulic Assemblies",
            weight_kg: 6200,
            cargo_value_usd: 18500,
            transport_mode: "ROAD",
            priority: "HIGH",
            required_by: "2026-11-30T16:00:00Z",
          },
          null,
          2,
        ),
      };
    case "tms_edi":
      return {
        isRawText: true,
        body: [
          "ISA*00*          *00*          *ZZ*ORACLEOTM      *ZZ*CONTROLTOWER   *261125*0930*U*00401*000000401*0*P*>~",
          "GS*SM*ORACLEOTM*CONTROLTOWER*20261125*0930*401*X*004010~",
          "ST*204*0001~",
          "B2**HRLF**BOL-992841**PP~",
          "B2A*00*LT~",
          "L11*PO-883412*PO~",
          "S5*1*LD*12400*L~",
          "N1*SH*Midwest Distribution Hub~",
          "N4*Dallas*TX*75201*US~",
          "S5*2*UL*12400*L~",
          "N1*CN*Southeast Retail DC~",
          "N4*Atlanta*GA*30301*US~",
          "SE*11*0001~",
          "GE*1*401~",
          "IEA*1*000000401~",
        ].join("\n"),
      };
    case "whole_db":
      return {
        isRawText: false,
        body: JSON.stringify(
          {
            warehouses: [
              {
                code: "WH-LAX-01",
                name: "Los Angeles Gateway Hub",
                city: "Los Angeles",
                country: "US",
                capacity_units: 60000,
              },
            ],
            carriers: [
              {
                name: "Apex Freight Lines",
                scac: "APXF",
                modes: ["ROAD", "INTERMODAL"],
                on_time_rate: 98.6,
                base_rate_per_km: 1.85,
              },
            ],
            fleet: [
              {
                registration: "TRK-LA-901",
                vehicle_type: "SEMI_TRUCK",
                mode: "ROAD",
                capacity_kg: 18000,
                city: "Los Angeles",
                status: "IDLE",
              },
            ],
            drivers: [
              {
                name: "Jordan Vega",
                license_number: "CDL-882410",
                status: "AVAILABLE",
                home_city: "Los Angeles",
              },
            ],
            customers: [
              {
                name: "Midwest Solar Supply",
                email: "receiving@midwestsolar.example",
                country: "US",
              },
            ],
            inventory: [
              {
                warehouse_code: "WH-LAX-01",
                sku: "INV-SOLAR-400",
                name: "Commercial Grid Inverters",
                quantity_on_hand: 340,
                reorder_point: 50,
              },
            ],
            orders: [
              {
                order_number: "ORD-2026-8841",
                customer_name: "Midwest Solar Supply",
                origin_city: "Los Angeles",
                origin_country: "US",
                destination_city: "Chicago",
                destination_country: "US",
                weight_kg: 4800,
                cargo_value_usd: 19400,
                transport_mode: "ROAD",
                priority: "HIGH",
              },
            ],
          },
          null,
          2,
        ),
      };
    case "telematics":
      return {
        isRawText: false,
        body: JSON.stringify(
          {
            event_type: "TELEMETRY",
            shipment_reference: "LG-90412",
            vehicle_registration: "TRK-DE-408",
            latitude: 50.1109,
            longitude: 8.6821,
            speed_kmh: 78,
            temperature_c: 3.4,
            recorded_at: "2026-11-25T13:45:00Z",
          },
          null,
          2,
        ),
      };
  }
}

export function buildIngestSnippet(
  recipe: RecipeId,
  lang: CodeLang,
  baseUrl: string,
  apiKey: string,
): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const endpoint = `${cleanBase}/api/v1/ingest`;
  const key = apiKey.trim() || "ct_live_YOUR_CONNECTOR_API_KEY";
  const { isRawText, body } = getRecipePayload(recipe);
  const contentType = isRawText ? "text/plain" : "application/json";
  const idempotencyKey =
    recipe === "erp_order"
      ? "sap-so-4500091822-v1"
      : recipe === "tms_edi"
        ? "otm-edi-204-000000401"
        : recipe === "whole_db"
          ? "master-sync-2026-11-25"
          : "gps-ping-lg90412-1345";

  if (lang === "curl") {
    const escaped = body.replace(/'/g, "'\\''");
    return `curl -X POST "${endpoint}" \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: ${contentType}" \\
  -H "Idempotency-Key: ${idempotencyKey}" \\
  --data-raw '${escaped}'`;
  }

  if (lang === "node") {
    if (isRawText) {
      return `const ediPayload = \`${body.replace(/`/g, "\\`")}\`;

const response = await fetch("${endpoint}", {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${process.env.CONTROL_TOWER_API_KEY || "${key}"}\`,
    "Content-Type": "text/plain",
    "Idempotency-Key": "${idempotencyKey}",
  },
  body: ediPayload,
});

if (!response.ok) {
  throw new Error(\`Control Tower ingest failed (\${response.status}): \${await response.text()}\`);
}

const result = await response.json();
console.log("Processed:", result.processed, "Autonomous takeover:", result.takeoverSummary);`;
    }

    return `const payload = ${body};

const response = await fetch("${endpoint}", {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${process.env.CONTROL_TOWER_API_KEY || "${key}"}\`,
    "Content-Type": "application/json",
    "Idempotency-Key": "${idempotencyKey}",
  },
  body: JSON.stringify(payload),
});

if (!response.ok) {
  throw new Error(\`Control Tower ingest failed (\${response.status}): \${await response.text()}\`);
}

const result = await response.json();
console.log("Processed:", result.processed, "Autonomous takeover:", result.takeoverSummary);`;
  }

  if (lang === "python") {
    if (isRawText) {
      return `import os
import requests

edi_payload = """${body}"""

res = requests.post(
    "${endpoint}",
    headers={
        "Authorization": f"Bearer {os.environ.get('CONTROL_TOWER_API_KEY', '${key}')}",
        "Content-Type": "text/plain",
        "Idempotency-Key": "${idempotencyKey}",
    },
    data=edi_payload.encode("utf-8"),
    timeout=15,
)
res.raise_for_status()
data = res.json()
print("Processed:", data["processed"], "Takeover:", data["takeoverSummary"])`;
    }

    const pyJson = body
      .replace(/\btrue\b/g, "True")
      .replace(/\bfalse\b/g, "False")
      .replace(/\bnull\b/g, "None");

    return `import os
import requests

payload = ${pyJson}

res = requests.post(
    "${endpoint}",
    headers={
        "Authorization": f"Bearer {os.environ.get('CONTROL_TOWER_API_KEY', '${key}')}",
        "Content-Type": "application/json",
        "Idempotency-Key": "${idempotencyKey}",
    },
    json=payload,
    timeout=15,
)
res.raise_for_status()
data = res.json()
print("Processed:", data["processed"], "Takeover:", data["takeoverSummary"])`;
  }

  if (lang === "csharp") {
    const escapedCsharp = body.replace(/"/g, '""');
    return `using System.Net.Http.Headers;
using System.Text;

using var client = new HttpClient();
var apiKey = Environment.GetEnvironmentVariable("CONTROL_TOWER_API_KEY") ?? "${key}";

var request = new HttpRequestMessage(HttpMethod.Post, "${endpoint}");
request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
request.Headers.Add("Idempotency-Key", "${idempotencyKey}");
request.Content = new StringContent(
@"${escapedCsharp}",
    Encoding.UTF8,
    "${contentType}"
);

var response = await client.SendAsync(request);
response.EnsureSuccessStatusCode();
var responseBody = await response.Content.ReadAsStringAsync();
Console.WriteLine(responseBody);`;
  }

  // Java 17+ HttpClient
  return `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

String apiKey = System.getenv().getOrDefault("CONTROL_TOWER_API_KEY", "${key}");
String payload = """
${body}
""";

HttpClient client = HttpClient.newBuilder()
    .connectTimeout(Duration.ofSeconds(10))
    .build();

HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("${endpoint}"))
    .timeout(Duration.ofSeconds(20))
    .header("Authorization", "Bearer " + apiKey)
    .header("Content-Type", "${contentType}")
    .header("Idempotency-Key", "${idempotencyKey}")
    .POST(HttpRequest.BodyPublishers.ofString(payload))
    .build();

HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
System.out.println("HTTP " + response.statusCode() + ": " + response.body());`;
}

export function buildShipmentsQuerySnippet(
  lang: CodeLang,
  baseUrl: string,
  apiKey: string,
): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const url = `${cleanBase}/api/v1/shipments?state=BOOKED`;
  const key = apiKey.trim() || "ct_live_YOUR_CONNECTOR_API_KEY";

  switch (lang) {
    case "curl":
      return `# List booked shipments (or pass ?reference=LG-90412 for a single lookup)
curl -X GET "${url}" \\
  -H "Authorization: Bearer ${key}" \\
  -H "Accept: application/json"`;
    case "node":
      return `const res = await fetch("${url}", {
  headers: {
    "Authorization": \`Bearer \${process.env.CONTROL_TOWER_API_KEY || "${key}"}\`,
    "Accept": "application/json",
  },
});

if (!res.ok) throw new Error(\`Query failed: \${res.status}\`);
const { count, shipments } = await res.json();
console.log(\`Synced \${count} booked shipments\`, shipments);`;
    case "python":
      return `import os
import requests

res = requests.get(
    "${cleanBase}/api/v1/shipments",
    params={"state": "BOOKED"},
    headers={"Authorization": f"Bearer {os.environ.get('CONTROL_TOWER_API_KEY', '${key}')}"},
    timeout=10,
)
res.raise_for_status()
data = res.json()
for shipment in data["shipments"]:
    print(shipment["reference"], shipment["state"])`;
    case "csharp":
      return `using System.Net.Http.Headers;

using var client = new HttpClient();
client.DefaultRequestHeaders.Authorization =
    new AuthenticationHeaderValue("Bearer", "${key}");

var json = await client.GetStringAsync("${url}");
Console.WriteLine(json);`;
    case "java":
      return `HttpRequest request = HttpRequest.newBuilder()
    .uri(URI.create("${url}"))
    .header("Authorization", "Bearer ${key}")
    .header("Accept", "application/json")
    .GET()
    .build();

HttpResponse<String> response = HttpClient.newHttpClient()
    .send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(response.body());`;
  }
}

export function buildWebhookVerificationSnippet(lang: WebhookLang): string {
  if (lang === "node") {
    return `import crypto from "node:crypto";

export function verifyControlTowerWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expectedHex = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody, "utf8")
    .digest("hex");

  const actualHex = signatureHeader.slice("sha256=".length);
  if (actualHex.length !== expectedHex.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(actualHex, "hex"),
    Buffer.from(expectedHex, "hex"),
  );
}

// Express / Next.js Route Handler usage:
// const rawBody = await req.text();
// const sig = req.headers.get("x-controltower-signature") ?? undefined;
// if (!verifyControlTowerWebhook(rawBody, sig, process.env.CT_WEBHOOK_SECRET!)) {
//   return new Response("Invalid signature", { status: 401 });
// }
// const event = JSON.parse(rawBody);`;
  }

  if (lang === "python") {
    return `import hashlib
import hmac
import os
from fastapi import FastAPI, Header, HTTPException, Request

app = FastAPI()

@app.post("/erp/control-tower-callback")
async def handle_control_tower_webhook(
    request: Request,
    x_controltower_signature: str | None = Header(default=None),
    x_controltower_event: str | None = Header(default=None),
):
    raw_body = await request.body()
    secret = os.environ["CT_WEBHOOK_SECRET"].encode("utf-8")

    expected = "sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    if not x_controltower_signature or not hmac.compare_digest(expected, x_controltower_signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    payload = await request.json()
    # Reconcile shipment.booked / approval.requested back into your ERP
    return {"received": True, "event": x_controltower_event, "connector": payload["connectorId"]}`;
  }

  return `using System.Security.Cryptography;
using System.Text;

public static bool VerifyControlTowerSignature(
    string rawBody,
    string? signatureHeader,
    string webhookSecret)
{
    if (string.IsNullOrWhiteSpace(signatureHeader) || !signatureHeader.StartsWith("sha256="))
        return false;

    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(webhookSecret));
    var expectedBytes = hmac.ComputeHash(Encoding.UTF8.GetBytes(rawBody));
    var actualHex = signatureHeader["sha256=".Length..];

    byte[] actualBytes;
    try { actualBytes = Convert.FromHexString(actualHex); }
    catch { return false; }

    return CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
}`;
}

export const WEBHOOK_ENVELOPE_SAMPLE = JSON.stringify(
  {
    event: "shipment.booked",
    connectorId: "conn_sap_prod_01",
    connectorName: "SAP S/4HANA Orders",
    timestamp: "2026-11-25T13:45:12.408Z",
    data: {
      externalRef: "SAP-SO-4500091822",
      orderReference: "PO-2026-4108",
      shipmentReference: "LG-90412",
      autonomyMode: "FULL_AUTONOMOUS",
      orchestrationSummary:
        "Booked ROAD (835 km, 11h) via EuroLine Freight · assigned TRK-DE-408",
    },
  },
  null,
  2,
);

export const SHIPMENTS_RESPONSE_SAMPLE = JSON.stringify(
  {
    ok: true,
    connectorId: "conn_sap_prod_01",
    count: 1,
    shipments: [
      {
        id: "shp_90412",
        reference: "LG-90412",
        state: "BOOKED",
        customer_ref: "SAP-SO-4500091822",
        origin: { city: "Rotterdam", country: "NL" },
        destination: { city: "Munich", country: "DE" },
        cargo: {
          description: "Precision CNC Hydraulic Assemblies",
          weight_kg: 6200,
          value_usd: 18500,
        },
        updated_at: "2026-11-25T13:45:12.000Z",
      },
    ],
  },
  null,
  2,
);
