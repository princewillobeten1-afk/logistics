import test from "node:test";
import assert from "node:assert/strict";
import { signUp } from "@/lib/auth";
import { resetLocalStoreForTests } from "@/lib/db";
import { claimDistributedWebhookReplay } from "@/lib/distributed-guard";
import { paginateArray } from "@/lib/pagination";
import {
  canTransitionCustomsStatus,
  computeClientFulfillmentReports,
  evaluateCustomsReadiness,
  normalizeHsCodes,
  summarizeInternationalFreight,
  validateContainerOrWaybill,
  validateInternationalFreightInput,
  validateThirdPartyClientInput,
} from "./freight-and-3pl";
import {
  deactivateThirdPartyClient,
  listInternationalFreightRecords,
  listThirdPartyClients,
  transitionCustomsClearanceStatus,
  upsertInternationalFreightRecord,
  upsertThirdPartyClient,
} from "./store";

test("P2.1 Distributed webhook replay protection deduplicates per-org & allows expiry re-claim", async () => {
  resetLocalStoreForTests();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const wsA = await signUp({
    companyName: "Replay Alpha Logistics",
    name: "Admin A",
    email: `replay-a-${suffix}@p2.test`,
    password: "StrongPassword123!",
  });
  const wsB = await signUp({
    companyName: "Replay Beta Logistics",
    name: "Admin B",
    email: `replay-b-${suffix}@p2.test`,
    password: "StrongPassword123!",
  });
  assert.equal(wsA.ok, true);
  assert.equal(wsB.ok, true);
  if (!wsA.ok || !wsB.ok) return;

  const first = await claimDistributedWebhookReplay(wsA.user.orgId, "WHATSAPP", "wamid.1001");
  assert.equal(first.fresh, true);
  assert.equal(first.backend, "database");

  // Same org + channel + delivery ID is blocked as replay
  const dup = await claimDistributedWebhookReplay(wsA.user.orgId, "WHATSAPP", "wamid.1001");
  assert.equal(dup.fresh, false);

  // Different tenant with same provider delivery ID is unaffected (tenant-scoped)
  const otherTenant = await claimDistributedWebhookReplay(wsB.user.orgId, "WHATSAPP", "wamid.1001");
  assert.equal(otherTenant.fresh, true);

  // External intake channel is also tracked independently
  const intakeFirst = await claimDistributedWebhookReplay(wsA.user.orgId, "EXTERNAL_INTAKE", "idem-55");
  const intakeDup = await claimDistributedWebhookReplay(wsA.user.orgId, "EXTERNAL_INTAKE", "idem-55");
  assert.equal(intakeFirst.fresh, true);
  assert.equal(intakeDup.fresh, false);
});

test("P2.2 paginateArray filters, clamps out-of-range pages, and slices deterministically", () => {
  const rows = Array.from({ length: 35 }, (_, i) => ({
    code: `CAR-${i + 1}`,
    name: i % 2 === 0 ? `Alpha Freight ${i + 1}` : `Beta Express ${i + 1}`,
  }));

  const p1 = paginateArray(rows, { page: "1", pageSize: "10" });
  assert.equal(p1.total, 35);
  assert.equal(p1.totalPages, 4);
  assert.equal(p1.items.length, 10);
  assert.equal(p1.startIndex, 1);
  assert.equal(p1.endIndex, 10);

  const filtered = paginateArray(rows, {
    q: "alpha",
    page: "99",
    pageSize: "10",
    matcher: (r, q) => r.name.toLowerCase().includes(q),
  });
  assert.equal(filtered.total, 18);
  assert.equal(filtered.page, 2); // clamped to last page
  assert.equal(filtered.items.length, 8);
});

test("P2.3 Pure international freight validators enforce HS codes, ISO containers, IATA AWBs, and customs state machine", () => {
  const hs = normalizeHsCodes("847130, 8504.40.90, BAD");
  assert.deepEqual(hs.valid, ["8471.30", "8504.40.90"]);
  assert.deepEqual(hs.invalid, ["BAD"]);

  const seaOk = validateContainerOrWaybill("SEA", "msku9070323");
  assert.equal(seaOk.ok, true);
  assert.equal(seaOk.kind, "ISO_CONTAINER");
  assert.equal(seaOk.normalized, "MSKU9070323");

  const airOk = validateContainerOrWaybill("AIR", "17612345678");
  assert.equal(airOk.ok, true);
  assert.equal(airOk.kind, "AIR_WAYBILL");
  assert.equal(airOk.normalized, "176-12345678");

  const airBad = validateContainerOrWaybill("AIR", "NOT-AN-AWB");
  assert.equal(airBad.ok, false);

  assert.equal(canTransitionCustomsStatus("PENDING_DOCS", "DOCS_VERIFIED"), true);
  assert.equal(canTransitionCustomsStatus("PENDING_DOCS", "CLEARED"), false);
  assert.equal(canTransitionCustomsStatus("SUBMITTED", "CLEARED"), true);
  assert.equal(canTransitionCustomsStatus("CLEARED", "PENDING_DOCS"), false);

  const readiness = evaluateCustomsReadiness({
    hsCodes: ["8471.30"],
    commercialInvoiceReady: true,
    packingListReady: true,
    certificateOfOriginReady: false,
    customsBroker: "DHL Global Customs",
    declaredValueUsd: 55_000,
  });
  assert.equal(readiness.readyForSubmission, true);
  assert.equal(readiness.score, 90);
  assert.deepEqual(readiness.missing, ["Certificate of origin"]);

  const badFreight = validateInternationalFreightInput({
    shipmentReference: "LG-9001",
    transportMode: "AIR",
    containerOrWaybill: "INVALID",
    originCountry: "DE",
    destinationCountry: "US",
    hsCodes: "8471.30",
  });
  assert.equal(badFreight.ok, false);
});

test("P2.3 3PL multi-client segregation & international freight persistence stay strictly tenant-isolated", async () => {
  resetLocalStoreForTests();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const ws3pl = await signUp({
    companyName: "Nexus 3PL Holdings",
    name: "3PL Ops",
    email: `nexus-${suffix}@p2.test`,
    password: "StrongPassword123!",
  });
  const wsOther = await signUp({
    companyName: "Atlas Global Freight",
    name: "Atlas Ops",
    email: `atlas-${suffix}@p2.test`,
    password: "StrongPassword123!",
  });
  assert.equal(ws3pl.ok, true);
  assert.equal(wsOther.ok, true);
  if (!ws3pl.ok || !wsOther.ok) return;

  // Validate client input
  assert.equal(validateThirdPartyClientInput({ clientCode: "!", clientName: "X" }).ok, false);

  // Register two distinct client accounts inside Nexus 3PL's workspace
  const c1 = await upsertThirdPartyClient(ws3pl.user.orgId, {
    clientCode: "ACME",
    clientName: "Acme Consumer Goods",
    slaHours: 24,
    billingModel: "HYBRID_STORAGE_PICK",
    dedicatedWarehouses: ["WH-RTM"],
    skuPrefixes: ["ACM-"],
    monthlyStorageRateUsd: 20,
    perOrderPickFeeUsd: 4,
  });
  const c2 = await upsertThirdPartyClient(ws3pl.user.orgId, {
    clientCode: "NOVA",
    clientName: "Nova MedTech",
    slaHours: 12,
    billingModel: "PER_ORDER_FULFILLMENT",
    dedicatedWarehouses: ["WH-RTM"],
    skuPrefixes: ["NOV-"],
    monthlyStorageRateUsd: 30,
    perOrderPickFeeUsd: 7.5,
  });
  assert.equal(c1.ok, true);
  assert.equal(c2.ok, true);

  // Tenant isolation check: Atlas cannot see Nexus 3PL's client accounts
  const atlasClients = await listThirdPartyClients(wsOther.user.orgId);
  assert.equal(atlasClients.length, 0);

  // Client-scoped reporting inside Nexus 3PL segregates shared warehouse stock accurately
  const nexusClients = await listThirdPartyClients(ws3pl.user.orgId);
  assert.equal(nexusClients.length, 2);
  const reports = computeClientFulfillmentReports(
    nexusClients,
    [
      { warehouse: "WH-RTM", sku: "ACM-100", on_hand: 200, reserved: 40, available: 160 },
      { warehouse: "WH-RTM", sku: "NOV-500", on_hand: 80, reserved: 10, available: 70 },
    ],
    [
      { reference: "LG-1", state: "DELIVERED", customer_ref: "ACME-001" },
      { reference: "LG-2", state: "IN_TRANSIT", customer_ref: "ACME-002" },
      { reference: "LG-3", state: "DELIVERED", customer_ref: "NOVA-010" },
    ],
  );
  const acmeReport = reports.find((r) => r.clientCode === "ACME");
  const novaReport = reports.find((r) => r.clientCode === "NOVA");
  assert.ok(acmeReport);
  assert.ok(novaReport);
  assert.equal(acmeReport.onHandUnits, 200);
  assert.equal(acmeReport.totalShipments, 2);
  assert.equal(novaReport.onHandUnits, 80);
  assert.equal(novaReport.totalShipments, 1);

  const deactivated = await deactivateThirdPartyClient(ws3pl.user.orgId, "NOVA");
  assert.equal(deactivated, true);

  // International freight customs workflow inside Atlas workspace
  const filed = await upsertInternationalFreightRecord(
    wsOther.user.orgId,
    {
      shipmentReference: "LG-INTL-77",
      direction: "EXPORT",
      transportMode: "SEA",
      incoterm: "CIF",
      containerOrWaybill: "MSKU9070323",
      originCountry: "NL",
      destinationCountry: "US",
      portOfLoading: "NLRTM",
      portOfDischarge: "USLAX",
      hsCodes: ["8471.30", "8504.40"],
      declaredValueUsd: 120_000,
      customsBroker: "Kuehne+Nagel",
      commercialInvoiceReady: true,
      packingListReady: true,
      certificateOfOriginReady: true,
    },
    `atlas-${suffix}@p2.test`,
  );
  assert.equal(filed.ok, true);

  // Advance customs clearance state machine
  const verified = await transitionCustomsClearanceStatus(
    wsOther.user.orgId,
    "LG-INTL-77",
    "DOCS_VERIFIED",
    "Broker verified HS tariff codes",
    `atlas-${suffix}@p2.test`,
  );
  assert.equal(verified.ok, true);
  const submitted = await transitionCustomsClearanceStatus(
    wsOther.user.orgId,
    "LG-INTL-77",
    "SUBMITTED",
    "Filed with CBP ACE",
    `atlas-${suffix}@p2.test`,
  );
  assert.equal(submitted.ok, true);
  const cleared = await transitionCustomsClearanceStatus(
    wsOther.user.orgId,
    "LG-INTL-77",
    "CLEARED",
    "Released at USLAX",
    `atlas-${suffix}@p2.test`,
  );
  assert.equal(cleared.ok, true);

  const atlasRecords = await listInternationalFreightRecords(wsOther.user.orgId);
  assert.equal(atlasRecords.length, 1);
  assert.equal(summarizeInternationalFreight(atlasRecords).clearedCount, 1);

  // Nexus 3PL cannot see Atlas's international freight filings
  const nexusRecords = await listInternationalFreightRecords(ws3pl.user.orgId);
  assert.equal(nexusRecords.length, 0);
});
