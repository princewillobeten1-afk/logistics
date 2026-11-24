export type SystemCategory =
  | "ERP"
  | "TMS"
  | "WMS"
  | "ECOMMERCE"
  | "TELEMATICS"
  | "EDI"
  | "BATCH"
  | "CUSTOM";

export type AutonomyMode =
  | "FULL_AUTONOMOUS"
  | "ASSISTED_APPROVAL"
  | "SYNC_ONLY";

export type CanonicalEntityType =
  | "ORDER"
  | "SHIPMENT_UPDATE"
  | "TELEMETRY"
  | "EXCEPTION"
  | "INVENTORY_SYNC"
  | "CARRIER_QUOTE"
  | "CUSTOMS_DOC";

export interface SystemConnectorTemplate {
  id: string;
  name: string;
  vendor: string;
  category: SystemCategory;
  summary: string;
  formats: ("JSON" | "CSV" | "EDI_X12")[];
  defaultAutonomy: AutonomyMode;
  supportedEvents: CanonicalEntityType[];
  defaultFieldMapping: Record<string, string>;
  sampleFormat: "JSON" | "CSV" | "EDI_X12";
  samplePayload: string;
}

export const AUTONOMY_MODE_META: Record<
  AutonomyMode,
  { label: string; description: string }
> = {
  FULL_AUTONOMOUS: {
    label: "Full Autonomous",
    description:
      "AI normalizes payloads, creates/updates orders and shipments, plans routes, assigns fleet/carriers, handles exceptions, and pushes status back automatically.",
  },
  ASSISTED_APPROVAL: {
    label: "Assisted Approval",
    description:
      "AI ingests, plans, and runs specialist analysis automatically, holding high-value bookings and escalations for human sign-off.",
  },
  SYNC_ONLY: {
    label: "Sync Only",
    description:
      "Normalizes and mirrors external records into Control Tower without triggering autonomous agent dispatches.",
  },
};

export const SYSTEM_CONNECTOR_TEMPLATES: SystemConnectorTemplate[] = [
  {
    id: "sap_s4hana_tm",
    name: "SAP S/4HANA TM",
    vendor: "SAP",
    category: "ERP",
    summary:
      "Ingests SAP Transportation Management freight orders, OData delivery documents, and plant stock movements.",
    formats: ["JSON", "EDI_X12"],
    defaultAutonomy: "FULL_AUTONOMOUS",
    supportedEvents: ["ORDER", "SHIPMENT_UPDATE", "INVENTORY_SYNC"],
    defaultFieldMapping: {
      externalRef: "FreightOrderID",
      originCity: "SourceLocation.CityName",
      destinationCity: "DestinationLocation.CityName",
      cargoDescription: "CargoSummary.MaterialDescription",
      weightKg: "GrossWeightKg",
      quantity: "PackageCount",
      deadlineIso: "RequestedDeliveryDateTime",
      customerName: "ShipToParty.BusinessPartnerName",
      preferredMode: "TransportationModeCode",
      currency: "DocumentCurrency",
    },
    sampleFormat: "JSON",
    samplePayload: JSON.stringify(
      {
        EventType: "FreightOrder.Created",
        FreightOrderID: "SAP-FO-88412",
        DocumentCurrency: "USD",
        TransportationModeCode: "ROAD",
        GrossWeightKg: 4250,
        PackageCount: 18,
        RequestedDeliveryDateTime: "2026-11-28T16:00:00Z",
        SourceLocation: { PlantCode: "DE-HAM1", CityName: "Hamburg" },
        DestinationLocation: { CustomerSite: "NL-RTM4", CityName: "Rotterdam" },
        ShipToParty: {
          BusinessPartnerName: "Nordic Industrial GmbH",
          ContactEmail: "receiving@nordic-industrial.example",
        },
        CargoSummary: {
          MaterialDescription: "CNC Hydraulic Actuator Assemblies",
          TemperatureControlled: false,
          DangerousGoodsIndicator: false,
        },
      },
      null,
      2,
    ),
  },
  {
    id: "oracle_netsuite",
    name: "Oracle NetSuite ERP",
    vendor: "Oracle",
    category: "ERP",
    summary:
      "Connects NetSuite Sales Orders, Item Fulfillments, and Return Authorizations via RESTlet or SuiteScript webhook.",
    formats: ["JSON"],
    defaultAutonomy: "FULL_AUTONOMOUS",
    supportedEvents: ["ORDER", "SHIPMENT_UPDATE", "INVENTORY_SYNC"],
    defaultFieldMapping: {
      externalRef: "tranId",
      originCity: "location.city",
      destinationCity: "shippingAddress.city",
      cargoDescription: "memo",
      weightKg: "totalWeightKg",
      quantity: "itemCount",
      deadlineIso: "shipDate",
      customerName: "entity.companyName",
      customerEmail: "entity.email",
      currency: "currency.refName",
    },
    sampleFormat: "JSON",
    samplePayload: JSON.stringify(
      {
        recordType: "salesOrder",
        tranId: "NS-SO-44019",
        currency: { refName: "USD" },
        shipDate: "2026-11-29T12:00:00Z",
        totalWeightKg: 1180,
        itemCount: 12,
        memo: "Medical diagnostic reagents — cold chain required",
        temperatureControlled: true,
        location: { name: "Lagos Ikeja DC", city: "Lagos" },
        shippingAddress: { city: "Abuja", country: "NG" },
        entity: {
          companyName: "Helios Health Systems",
          email: "supplychain@helios.example",
        },
      },
      null,
      2,
    ),
  },
  {
    id: "cargowise_one",
    name: "CargoWise One",
    vendor: "WiseTech Global",
    category: "TMS",
    summary:
      "Synchronizes Universal Shipment XML/JSON exports, ocean/air consolidations, customs declarations, and milestone events.",
    formats: ["JSON", "EDI_X12"],
    defaultAutonomy: "FULL_AUTONOMOUS",
    supportedEvents: ["ORDER", "SHIPMENT_UPDATE", "CUSTOMS_DOC", "EXCEPTION"],
    defaultFieldMapping: {
      externalRef: "Shipment.WaybillNumber",
      originCity: "Shipment.PortOfOrigin.Name",
      destinationCity: "Shipment.PortOfDestination.Name",
      cargoDescription: "Shipment.GoodsDescription",
      weightKg: "Shipment.TotalWeight",
      quantity: "Shipment.OuterPacks",
      preferredMode: "Shipment.TransportMode",
      customerName: "Shipment.Consignee.CompanyName",
    },
    sampleFormat: "JSON",
    samplePayload: JSON.stringify(
      {
        MessageType: "UniversalShipment",
        Shipment: {
          WaybillNumber: "CW-MAWB-771920",
          TransportMode: "AIR",
          PortOfOrigin: { Code: "NLLOS", Name: "Lagos" },
          PortOfDestination: { Code: "GBLHR", Name: "London" },
          GoodsDescription: "High-precision avionics spare modules",
          TotalWeight: 640,
          OuterPacks: 6,
          EstimatedDelivery: "2026-11-27T09:00:00Z",
          Consignee: {
            CompanyName: "Meridian Aerospace UK",
            Email: "imports@meridian-aero.example",
          },
        },
      },
      null,
      2,
    ),
  },
  {
    id: "shopify_oms",
    name: "Shopify / E-Commerce OMS",
    vendor: "Shopify & Direct OMS",
    category: "ECOMMERCE",
    summary:
      "Turns storefront orders and fulfillment webhooks into planned, carrier-assigned shipments with automated customer tracking updates.",
    formats: ["JSON"],
    defaultAutonomy: "FULL_AUTONOMOUS",
    supportedEvents: ["ORDER", "SHIPMENT_UPDATE"],
    defaultFieldMapping: {
      externalRef: "name",
      originCity: "fulfillment_origin.city",
      destinationCity: "shipping_address.city",
      cargoDescription: "line_items.0.title",
      weightGrams: "total_weight",
      quantity: "line_items.0.quantity",
      customerName: "customer.first_name",
      customerEmail: "email",
      currency: "currency",
    },
    sampleFormat: "JSON",
    samplePayload: JSON.stringify(
      {
        topic: "orders/create",
        name: "#SHOP-9182",
        currency: "USD",
        email: "ops@atelier-retail.example",
        total_weight: 48000,
        fulfillment_origin: { city: "Chicago" },
        shipping_address: { city: "New York", country: "US" },
        customer: { first_name: "Atelier Retail Group" },
        line_items: [
          { title: "Commercial Espresso Machines (4-unit pallet)", quantity: 4 },
        ],
      },
      null,
      2,
    ),
  },
  {
    id: "manhattan_wms",
    name: "Manhattan / 3PL WMS",
    vendor: "Manhattan Associates & 3PL",
    category: "WMS",
    summary:
      "Syncs warehouse pick-pack releases, SKU stock counts, dock appointments, and outbound ASN manifests.",
    formats: ["JSON", "CSV"],
    defaultAutonomy: "FULL_AUTONOMOUS",
    supportedEvents: ["INVENTORY_SYNC", "ORDER", "SHIPMENT_UPDATE"],
    defaultFieldMapping: {
      externalRef: "waveId",
      warehouseCode: "facilityCode",
      sku: "skuCode",
      onHand: "qtyOnHand",
      reserved: "qtyAllocated",
      originCity: "facilityCity",
      destinationCity: "shipToCity",
    },
    sampleFormat: "JSON",
    samplePayload: JSON.stringify(
      {
        eventType: "INVENTORY_ADJUSTMENT",
        facilityCode: "LOS-HUB-01",
        skuCode: "SKU-SOLAR-450W",
        qtyOnHand: 340,
        qtyAllocated: 95,
        notes: "Cycle count completed after Container #MSKU901244 devanning",
      },
      null,
      2,
    ),
  },
  {
    id: "samsara_telematics",
    name: "Samsara / Geotab Fleet GPS",
    vendor: "Samsara & Telematics",
    category: "TELEMATICS",
    summary:
      "Streams real-time vehicle GPS coordinates, speed, reefer temperature alerts, and breakdown exceptions into the Control Tower map and agents.",
    formats: ["JSON"],
    defaultAutonomy: "FULL_AUTONOMOUS",
    supportedEvents: ["TELEMETRY", "EXCEPTION"],
    defaultFieldMapping: {
      vehicleRegistration: "vehicle.licensePlate",
      shipmentRef: "shipmentReference",
      latitude: "gps.latitude",
      longitude: "gps.longitude",
      speedKph: "gps.speedKph",
      temperatureC: "reefer.ambientTempC",
      alertType: "alert.code",
      notes: "alert.message",
    },
    sampleFormat: "JSON",
    samplePayload: JSON.stringify(
      {
        eventType: "vehicle.gps.update",
        vehicle: { id: "veh_902", licensePlate: "LAG-409-XY" },
        gps: { latitude: 7.3775, longitude: 3.947, speedKph: 68 },
        reefer: { ambientTempC: 3.4 },
        notes: "Ibadan expressway corridor — nominal transit speed",
      },
      null,
      2,
    ),
  },
  {
    id: "edi_x12_gateway",
    name: "EDI X12 Gateway (204 / 214 / 856)",
    vendor: "ANSI X12 / EDIFACT",
    category: "EDI",
    summary:
      "Parses raw ANSI X12 204 Motor Carrier Load Tenders, 214 Shipment Status updates, and 856 Advance Ship Notices directly into autonomous workflows.",
    formats: ["EDI_X12"],
    defaultAutonomy: "FULL_AUTONOMOUS",
    supportedEvents: ["ORDER", "SHIPMENT_UPDATE", "EXCEPTION"],
    defaultFieldMapping: {},
    sampleFormat: "EDI_X12",
    samplePayload: [
      "ISA*00*          *00*          *ZZ*ACMEERP        *ZZ*CTRLTOWER      *261124*1310*U*00401*000000104*0*P*>~",
      "GS*SM*ACMEERP*CTRLTOWER*20261124*1310*104*X*004010~",
      "ST*204*0001~",
      "B2**SCAC**EDI-LOAD-9921**PP~",
      "G62*64*20261128*1*1400~",
      "N1*SH*Apex Distribution Center~",
      "N4*Dallas*TX*75201*US~",
      "N1*CN*Pacific Medical Logistics~",
      "N4*Los Angeles*CA*90001*US~",
      "L5*1*Sterile Surgical Kits Palletized~",
      "AT8*G*L*6200*14~",
      "SE*10*0001~",
      "GE*1*104~",
      "IEA*1*000000104~",
    ].join("\n"),
  },
  {
    id: "csv_batch_feed",
    name: "CSV / Spreadsheet Batch Feed",
    vendor: "Excel / ERP Exports",
    category: "BATCH",
    summary:
      "Bulk-imports daily shipment manifests, purchase orders, or dispatch sheets from any spreadsheet or legacy SFTP export.",
    formats: ["CSV"],
    defaultAutonomy: "FULL_AUTONOMOUS",
    supportedEvents: ["ORDER", "SHIPMENT_UPDATE", "INVENTORY_SYNC"],
    defaultFieldMapping: {},
    sampleFormat: "CSV",
    samplePayload: [
      "external_ref,customer_name,origin_city,destination_city,cargo_description,weight_kg,quantity,mode,deadline,currency",
      "ERP-801,Kano Agro Mills,Lagos,Kano,Industrial grain sorting spares,1850,9,ROAD,2026-11-29T18:00:00Z,NGN",
      "ERP-802,Delta Pharma Ltd,Lagos,Port Harcourt,Cold-chain vaccine thermal boxes,420,16,AIR,2026-11-26T15:00:00Z,NGN",
    ].join("\n"),
  },
  {
    id: "custom_rest_webhook",
    name: "Custom ERP / TMS REST Webhook",
    vendor: "Any In-House System",
    category: "CUSTOM",
    summary:
      "Zero-schema-lock-in JSON webhook for proprietary internal systems. AI automatically detects your custom field names and executes the full logistics lifecycle.",
    formats: ["JSON", "CSV", "EDI_X12"],
    defaultAutonomy: "FULL_AUTONOMOUS",
    supportedEvents: [
      "ORDER",
      "SHIPMENT_UPDATE",
      "TELEMETRY",
      "EXCEPTION",
      "INVENTORY_SYNC",
      "CARRIER_QUOTE",
      "CUSTOMS_DOC",
    ],
    defaultFieldMapping: {},
    sampleFormat: "JSON",
    samplePayload: JSON.stringify(
      {
        job_ticket: "INT-2026-553",
        client_org: "Vanguard Energy Services",
        pickup_hub: "Port Harcourt",
        dropoff_hub: "Abuja",
        freight_item: "High-pressure subsea valve manifold",
        mass_kg: 3100,
        crates: 3,
        urgency_note: "Needs flatbed truck and escort clearance by Nov 29",
        target_eta: "2026-11-29T17:00:00Z",
        hazmat_flag: false,
      },
      null,
      2,
    ),
  },
];

export function getConnectorTemplate(id: string): SystemConnectorTemplate | undefined {
  return SYSTEM_CONNECTOR_TEMPLATES.find((t) => t.id === id);
}
