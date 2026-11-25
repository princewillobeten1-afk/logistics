import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { query } from "@/lib/db";
import { getConnectorTemplate } from "./catalog";
import { processUniversalIngestion } from "./engine";
import { createOrgConnector, deleteOrgConnector } from "./store";
import {
  detectAndParseRawPayload,
  normalizeRecordDeterministically,
  parseCsvRecords,
  parseEdiX12,
} from "./mapper";
import {
  generateConnectorApiKey,
  hashSecret,
  isBlockedIpAddress,
  signWebhookPayload,
  timingSafeHexEquals,
  validateOutboundWebhookUrlSyntax,
  verifyWebhookSignature,
} from "./security";

test("generateConnectorApiKey creates ct_live_ keys whose SHA-256 hash verifies in constant time", () => {
  const key = generateConnectorApiKey();
  assert.ok(key.plaintext.startsWith("ct_live_"));
  assert.equal(key.prefix, key.plaintext.slice(0, 16));
  assert.equal(key.hash, hashSecret(key.plaintext));
  assert.equal(timingSafeHexEquals(key.hash, hashSecret(key.plaintext)), true);
  assert.equal(timingSafeHexEquals(key.hash, hashSecret("ct_live_wrong_key")), false);
});

test("signWebhookPayload and verifyWebhookSignature validate HMAC-SHA256 signatures accurately", () => {
  const body = JSON.stringify({ event: "shipment.created", ref: "LG-12345" });
  const secret = "whsec_test_secret_1234567890";
  const sig = signWebhookPayload(body, secret);
  assert.ok(sig.startsWith("sha256="));
  assert.equal(verifyWebhookSignature(body, sig, secret), true);
  assert.equal(verifyWebhookSignature(body + " ", sig, secret), false);
  assert.equal(verifyWebhookSignature(body, sig, "whsec_wrong_secret"), false);
  assert.equal(verifyWebhookSignature(body, "sha256=nothex", secret), false);
});

test("validateOutboundWebhookUrlSyntax blocks SSRF targets and allows public https URLs", () => {
  assert.equal(validateOutboundWebhookUrlSyntax("https://erp.meridianfreight.com/hooks/ct").ok, true);
  assert.equal(validateOutboundWebhookUrlSyntax("").ok, true);

  const blocked = [
    "http://localhost:3000/hook",
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/internal",
    "https://172.16.10.2/hook",
    "https://192.168.1.40/hook",
    "http://[::1]/hook",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://service.corp.local/webhook",
    "ftp://files.example.com/upload",
    "javascript:alert(1)",
    "https://user:pass@erp.example.com/hook",
  ];
  for (const url of blocked) {
    assert.equal(
      validateOutboundWebhookUrlSyntax(url).ok,
      false,
      `Expected URL to be rejected: ${url}`,
    );
  }
  assert.equal(isBlockedIpAddress("8.8.8.8"), false);
  assert.equal(isBlockedIpAddress("169.254.169.254"), true);
});

test("parseCsvRecords handles quoted commas and escaped quotes cleanly", () => {
  const csv = [
    'external_ref,customer_name,origin_city,destination_city,cargo_description,weight_kg',
    'ERP-10,"Acme, Inc.",Lagos,Abuja,"Valves, ""Class A""",1450',
    'ERP-11,Delta Pharma,Lagos,Kano,Vaccines,320',
  ].join("\n");
  const rows = parseCsvRecords(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].customer_name, "Acme, Inc.");
  assert.equal(rows[0].cargo_description, 'Valves, "Class A"');
  assert.equal(rows[1].destination_city, "Kano");
});

test("parseEdiX12 parses 204 Load Tender and 214 Delay Exception messages accurately", () => {
  const ediTemplate = getConnectorTemplate("edi_x12_gateway");
  assert.ok(ediTemplate);
  const tender = parseEdiX12(ediTemplate.samplePayload);
  assert.ok(tender);
  assert.equal(tender.entityType, "ORDER");
  assert.equal(tender.intent, "NEW_ORDER");
  assert.equal(tender.externalRef, "EDI-LOAD-9921");
  assert.equal(tender.originCity, "Dallas");
  assert.equal(tender.destinationCity, "Los Angeles");
  assert.equal(tender.weightKg, Math.round(6200 * 0.453592));
  assert.equal(tender.quantity, 14);
  assert.equal(tender.deadlineIso, "2026-11-28T14:00:00Z");

  const edi214Delay = [
    "ST*214*0002~",
    "B10*LG-90210*EXT-99~",
    "AT7*SD*BD~",
    "SE*4*0002~",
  ].join("\n");
  const status = parseEdiX12(edi214Delay);
  assert.ok(status);
  assert.equal(status.entityType, "EXCEPTION");
  assert.equal(status.intent, "EXCEPTION_REPORT");
  assert.equal(status.shipmentRef, "LG-90210");
  assert.equal(status.severity, "HIGH");
});

test("normalizeRecordDeterministically normalizes SAP, Shopify (grams->kg), Samsara GPS, and WMS inventory", () => {
  // SAP S/4HANA TM
  const sapTpl = getConnectorTemplate("sap_s4hana_tm")!;
  const sapParsed = detectAndParseRawPayload(sapTpl.samplePayload);
  assert.equal(sapParsed.format, "JSON");
  const sapNorm = normalizeRecordDeterministically(
    sapParsed.records[0],
    sapTpl.defaultFieldMapping,
  );
  assert.equal(sapNorm.needsAiInference, false);
  assert.equal(sapNorm.normalized.entityType, "ORDER");
  assert.equal(sapNorm.normalized.mappedBy, "FIELD_MAPPING");
  assert.equal(sapNorm.normalized.originCity, "Hamburg");
  assert.equal(sapNorm.normalized.destinationCity, "Rotterdam");
  assert.equal(sapNorm.normalized.weightKg, 4250);

  // Shopify (grams -> kg)
  const shopTpl = getConnectorTemplate("shopify_oms")!;
  const shopParsed = detectAndParseRawPayload(shopTpl.samplePayload);
  const shopNorm = normalizeRecordDeterministically(
    shopParsed.records[0],
    shopTpl.defaultFieldMapping,
  );
  assert.equal(shopNorm.normalized.weightKg, 48);
  assert.equal(shopNorm.normalized.originCity, "Chicago");
  assert.equal(shopNorm.normalized.destinationCity, "New York");

  // Samsara Telematics nominal GPS
  const gpsTpl = getConnectorTemplate("samsara_telematics")!;
  const gpsParsed = detectAndParseRawPayload(gpsTpl.samplePayload);
  const gpsNorm = normalizeRecordDeterministically(
    gpsParsed.records[0],
    gpsTpl.defaultFieldMapping,
  );
  assert.equal(gpsNorm.normalized.entityType, "TELEMETRY");
  assert.equal(gpsNorm.normalized.vehicleRegistration, "LAG-409-XY");
  assert.equal(gpsNorm.normalized.latitude, 7.3775);

  // Cold-chain temperature excursion auto-escalates to CRITICAL EXCEPTION
  const excursion = normalizeRecordDeterministically(
    {
      eventType: "vehicle.gps.update",
      shipmentReference: "LG-40120",
      gps: { latitude: 6.52, longitude: 3.37, speedKph: 45 },
      reefer: { ambientTempC: 14.5 },
    },
    gpsTpl.defaultFieldMapping,
  );
  assert.equal(excursion.normalized.entityType, "EXCEPTION");
  assert.equal(excursion.normalized.severity, "CRITICAL");

  // Manhattan WMS Inventory Sync
  const wmsTpl = getConnectorTemplate("manhattan_wms")!;
  const wmsParsed = detectAndParseRawPayload(wmsTpl.samplePayload);
  const wmsNorm = normalizeRecordDeterministically(
    wmsParsed.records[0],
    wmsTpl.defaultFieldMapping,
  );
  assert.equal(wmsNorm.normalized.entityType, "INVENTORY_SYNC");
  assert.equal(wmsNorm.normalized.warehouseCode, "LOS-HUB-01");
  assert.equal(wmsNorm.normalized.sku, "SKU-SOLAR-450W");
  assert.equal(wmsNorm.normalized.onHand, 340);
});

test("processUniversalIngestion persists TELEMETRY and INVENTORY_SYNC with Postgres-valid schema SQL", async () => {
  const engineSrc = readFileSync(
    path.join(process.cwd(), "lib", "integrations", "engine.ts"),
    "utf8",
  );
  assert.equal(
    /UPDATE\s+conveyances[\s\S]*SET\s+last_lat/i.test(engineSrc),
    false,
    "engine.ts must update conveyances.identifiers JSONB and tracking_events, not non-existent last_lat column",
  );
  assert.equal(
    /INSERT\s+INTO\s+inventory\s*\(\s*warehouse\s*,/i.test(engineSrc),
    false,
    "engine.ts must use inventory.warehouse_id referencing warehouses(id)",
  );
  assert.equal(
    /INSERT\s+INTO\s+shipment_events[\s\S]*VALUES\s*\(\$1,\s*1,/i.test(engineSrc),
    false,
    "engine.ts must compute next seq via COALESCE(MAX(seq), 0) + 1",
  );

  const orgId = "00000000-0000-0000-0000-000000000001";
  const created = await createOrgConnector({
    orgId,
    name: "WMS & Telematics Integration Test",
    systemType: "manhattan_wms",
    autonomyMode: "SYNC_ONLY",
    createdBy: "test@example.com",
  });

  try {
    // 1. Inventory sync should create/resolve warehouse and upsert inventory
    const wmsRes = await processUniversalIngestion({
      connector: {
        id: created.connector.id,
        org_id: orgId,
        name: created.connector.name,
        system_type: "manhattan_wms",
        category: "WMS",
        status: "ACTIVE",
        autonomy_mode: "SYNC_ONLY",
        api_key_prefix: created.connector.apiKeyPrefix,
        api_key_hash: "unused",
        webhook_secret_hash: "unused",
        outbound_webhook_url: null,
        outbound_events: [],
        field_mapping: created.connector.fieldMapping,
        created_by: "test@example.com",
        created_at: new Date(),
        updated_at: new Date(),
        last_sync_at: null,
        events_processed: 0,
        errors_count: 0,
      },
      rawPayload: getConnectorTemplate("manhattan_wms")!.samplePayload,
      syncOrchestrate: false,
    });
    assert.equal(wmsRes.processed, 1);
    const invRows = await query<{ warehouse: string; sku: string; on_hand: number }>(
      `SELECT w.code AS warehouse, i.sku, i.on_hand, i.reserved, (i.on_hand - i.reserved) AS available
         FROM inventory i JOIN warehouses w ON w.id = i.warehouse_id
        ORDER BY w.code, i.sku`,
    );
    assert.ok(
      invRows.some((r) => r.warehouse === "LOS-HUB-01" && r.sku === "SKU-SOLAR-450W" && r.on_hand === 340),
    );

    // 2. Telematics GPS update should update conveyance telemetry cleanly
    const gpsTpl = getConnectorTemplate("samsara_telematics")!;
    const gpsRes = await processUniversalIngestion({
      connector: {
        id: created.connector.id,
        org_id: orgId,
        name: "Samsara GPS",
        system_type: "samsara_telematics",
        category: "TELEMATICS",
        status: "ACTIVE",
        autonomy_mode: "SYNC_ONLY",
        api_key_prefix: created.connector.apiKeyPrefix,
        api_key_hash: "unused",
        webhook_secret_hash: "unused",
        outbound_webhook_url: null,
        outbound_events: [],
        field_mapping: gpsTpl.defaultFieldMapping,
        created_by: "test@example.com",
        created_at: new Date(),
        updated_at: new Date(),
        last_sync_at: null,
        events_processed: 0,
        errors_count: 0,
      },
      rawPayload: gpsTpl.samplePayload,
      syncOrchestrate: false,
    });
    assert.equal(gpsRes.processed, 1);
  } finally {
    await deleteOrgConnector(created.connector.id, orgId);
  }
});
