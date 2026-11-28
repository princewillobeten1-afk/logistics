import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test, { after, beforeEach } from "node:test";

import {
  scheduleBackgroundAgent,
  runBackendAgentWorkflow,
} from "../agents/background";
import {
  dispatchToAutonomousAgent,
  resolveDefaultOrgId,
} from "../agents/autonomous";
import { gatherOperationalContext } from "../agents/context";
import { executeAgentTask } from "../agents/orchestrator";
import { hashPassword, verifyActiveSessionToken } from "../auth";
import {
  identityQuery,
  query,
  queryAs,
  resetLocalStoreForTests,
  runWithOrgScope,
  transaction,
} from "../db";
import { detectAndParseRawPayload } from "../integrations/mapper";
import {
  sealWebhookSecret,
  unsealWebhookSecret,
  verifySameOriginRequest,
} from "../integrations/security";
import {
  readTenantDocumentBlob,
  resolveTenantDocumentPath,
  saveTenantDocumentBlob,
} from "../documents/storage";
import { collectBiSnapshot } from "../intelligence/collector";
import {
  getShipment,
  listConveyances,
  listCustomers,
  listDocuments,
  listDrivers,
  listShipments,
  openApprovals,
} from "../queries";
import {
  collectTacticsSnapshot,
  updateTenantTacticsMutations,
} from "../tactics/store";
import {
  assertVerifiedOrgId,
  checkTenantRateLimit,
  departmentForAgent,
  detectWorkspaceTampering,
  filterByBranchScope,
  hasBranchAccess,
  hasDepartmentAccess,
  verifyWhatsAppHmacSignature,
} from "../tenant-guard";
import {
  acceptTeamInvitation,
  claimWorkspaceWebhookDelivery,
  createTeamInvitation,
  getWorkspaceSecurityProfile,
  listWorkspaceMembers,
  resolveOrgByIntakeApiKey,
  resolveOrgByWebhookToken,
  rotateWorkspaceIntakeKey,
  unsealWorkspaceWhatsAppSecret,
  updateWorkspaceChannelSecrets,
  updateWorkspaceMember,
  verifyWorkspaceTelegramSecret,
} from "../workspace-admin";

const LOCAL_STORE_PATH =
  process.env.LOGISTICS_LOCAL_STORE_PATH?.trim() ||
  "/tmp/logistics-local-store.json";
const originalStoreBackup = existsSync(LOCAL_STORE_PATH)
  ? readFileSync(LOCAL_STORE_PATH, "utf8")
  : null;

after(() => {
  try {
    if (originalStoreBackup !== null) {
      writeFileSync(LOCAL_STORE_PATH, originalStoreBackup, "utf8");
    } else if (existsSync(LOCAL_STORE_PATH)) {
      rmSync(LOCAL_STORE_PATH, { force: true });
    }
  } catch {
    // ignore cleanup failures
  }
});

interface TestTenant {
  orgId: string;
  orgName: string;
  adminId: string;
  adminEmail: string;
  sessionToken: string;
  adminSessionUser: {
    id: string;
    orgId: string;
    orgName: string;
    email: string;
    name: string;
    role: "ADMIN";
    departments: [];
    branchCodes: [];
  };
}

async function createTestTenant(
  name: string,
  slug: string,
  adminEmail: string,
): Promise<TestTenant> {
  const orgRows = await identityQuery<{ id: string; name: string }>(
    "INSERT INTO organisations (name, slug) VALUES ($1, $2) RETURNING id, name",
    [name, slug],
  );
  const orgId = orgRows[0].id;
  const passwordHash = await hashPassword("Str0ngPass!2026");
  const userRows = await identityQuery<{
    id: string;
    email: string;
    name: string;
    role: "ADMIN";
  }>(
    `INSERT INTO users (org_id, email, password_hash, role, name)
     VALUES ($1, $2, $3, 'ADMIN', $4)
     RETURNING id, email, name, role`,
    [orgId, adminEmail, passwordHash, `${name} Admin`],
  );
  const admin = userRows[0];
  const sessionToken = `sess_${slug}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  const expiresAt = new Date(Date.now() + 86_400_000);
  await identityQuery(
    `INSERT INTO sessions (token, user_id, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, '127.0.0.1', 'security-test')`,
    [sessionToken, admin.id, expiresAt],
  );

  return {
    orgId,
    orgName: orgRows[0].name,
    adminId: admin.id,
    adminEmail: admin.email,
    sessionToken,
    adminSessionUser: {
      id: admin.id,
      orgId,
      orgName: orgRows[0].name,
      email: admin.email,
      name: admin.name,
      role: "ADMIN",
      departments: [],
      branchCodes: [],
    },
  };
}

async function seedTenantOperations(tenant: TestTenant, tag: "A" | "B") {
  const customerRows = await queryAs<{ id: string }>(
    tenant.orgId,
    `INSERT INTO customers (code, name, default_currency, contacts)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [
      `CUST-${tag}`,
      `Customer ${tag}`,
      "NGN",
      JSON.stringify([
        {
          name: `Customer ${tag}`,
          email: `client-${tag.toLowerCase()}@example.com`,
          phone: tag === "A" ? "+2348000000001" : "+2348000000002",
        },
      ]),
    ],
  );
  const customerId = customerRows[0].id;

  const whCode = tag === "A" ? "WH-LAG" : "WH-ABJ";
  const city = tag === "A" ? "Lagos" : "Abuja";
  const warehouseRows = await queryAs<{ id: string }>(
    tenant.orgId,
    `INSERT INTO warehouses (code, name, city, country, capacity_cbm, used_cbm, status)
     VALUES ($1, $2, $3, 'NG', 1000, 350, 'ACTIVE')
     RETURNING id`,
    [whCode, `Hub ${tag}`, city],
  );
  const warehouseId = warehouseRows[0].id;

  const shipmentRef = tag === "A" ? "LG-A0001" : "LG-B0001";
  const shipmentRows = await queryAs<{ id: string; reference: string }>(
    tenant.orgId,
    `INSERT INTO shipments (
       reference, state, customer_ref, origin, destination, cargo, deadline, plan, created_via
     )
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9)
     RETURNING id, reference`,
    [
      shipmentRef,
      "IN_TRANSIT",
      `Customer ${tag}`,
      JSON.stringify({ city, country: "NG", port: whCode }),
      JSON.stringify({
        city: tag === "A" ? "Ibadan" : "Kano",
        country: "NG",
        port: tag === "A" ? "WH-IBD" : "WH-KAN",
      }),
      JSON.stringify({
        description: `Confidential Cargo ${tag}`,
        weight_kg: 420,
        declared_value_minor: tag === "A" ? 1_250_000 : 9_850_000,
      }),
      new Date(Date.now() + 72 * 3_600_000).toISOString(),
      JSON.stringify({ modes: ["ROAD"], distance_km: 145 }),
      "MANUAL",
    ],
  );
  const shipmentId = shipmentRows[0].id;

  const conveyanceRows = await queryAs<{ id: string; registration: string }>(
    tenant.orgId,
    `INSERT INTO conveyances (
       mode, kind, registration, carrier_code, carrier_name,
       capacity_kg, capacity_cbm, reefer, hazmat_certified, last_lat, last_lon
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, registration`,
    ["ROAD", "TRUCK", `TRK-${tag}01`, `CAR-${tag}`, `Carrier ${tag}`, 18000, 50, false, false, 6.5244, 3.3792],
  );
  const conveyanceId = conveyanceRows[0].id;

  const driverRows = await queryAs<{ id: string }>(
    tenant.orgId,
    `INSERT INTO drivers (name, phone, licence_number, current_city)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      `Driver ${tag}`,
      tag === "A" ? "+2348011111111" : "+2348022222222",
      `LIC-${tag}-999`,
      city,
    ],
  );
  const driverId = driverRows[0].id;

  const approvalRows = await queryAs<{ id: string }>(
    tenant.orgId,
    `INSERT INTO approvals (
       shipment_id, proposed_action_id, token, summary, rationale, amount_minor, currency
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      shipmentId,
      `pa-${tag}-1`,
      `tok-${tag}-1`,
      `Financial spend approval for Tenant ${tag}`,
      `Rate booking for Tenant ${tag}`,
      tag === "A" ? "500000" : "7500000",
      "NGN",
    ],
  );
  const approvalId = approvalRows[0].id;

  const blob = saveTenantDocumentBlob({
    orgId: tenant.orgId,
    filename: `bill-of-lading-${tag}.txt`,
    contentType: "text/plain",
    bytes: Buffer.from(`CONFIDENTIAL BOL FOR TENANT ${tag}`),
  });

  const docRows = await queryAs<{ id: string }>(
    tenant.orgId,
    `INSERT INTO documents (
       shipment_id, kind, direction, filename, storage_key, content_type, byte_size, sha256, uploaded_by
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      shipmentId,
      "BOL",
      "INBOUND",
      blob.filename,
      blob.storageKey,
      blob.contentType,
      blob.byteSize,
      blob.sha256,
      tenant.adminEmail,
    ],
  );
  const documentId = docRows[0].id;

  await queryAs(
    tenant.orgId,
    `INSERT INTO shipment_events (shipment_id, type, from_state, to_state, payload, actor)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      shipmentId,
      "shipment.departed",
      "BOOKED",
      "IN_TRANSIT",
      JSON.stringify({ summary: `Live event for Tenant ${tag}` }),
      tenant.adminEmail,
    ],
  );

  return {
    customerId,
    warehouseId,
    whCode,
    shipmentId,
    shipmentRef,
    conveyanceId,
    driverId,
    approvalId,
    documentId,
    storageKey: blob.storageKey,
  };
}

beforeEach(() => {
  resetLocalStoreForTests();
});

test("1 & 2. Company A cannot view Company B's shipments or customers (and each sees its own)", async () => {
  const tenantA = await createTestTenant("Alpha Freight", "alpha-freight", "admin@alpha.test");
  const tenantB = await createTestTenant("Beta Cargo", "beta-cargo", "admin@beta.test");
  const dataA = await seedTenantOperations(tenantA, "A");
  const dataB = await seedTenantOperations(tenantB, "B");

  // Authorized reads for Tenant A
  const shipmentsA = await runWithOrgScope(tenantA.orgId, () => listShipments());
  assert.equal(shipmentsA.length, 1);
  assert.equal(shipmentsA[0].reference, dataA.shipmentRef);

  // Cross-tenant shipment lookup by reference fails closed (returns null)
  const crossShipment = await runWithOrgScope(tenantA.orgId, () =>
    getShipment(dataB.shipmentRef),
  );
  assert.equal(crossShipment, null);

  // Tenant B sees its own shipment and never Tenant A's
  const shipmentsB = await runWithOrgScope(tenantB.orgId, () => listShipments());
  assert.equal(shipmentsB.length, 1);
  assert.equal(shipmentsB[0].reference, dataB.shipmentRef);

  // Customers isolation
  const customersA = await runWithOrgScope(tenantA.orgId, () => listCustomers());
  assert.equal(customersA.length, 1);
  assert.equal(customersA[0].name, "Customer A");
  assert.ok(!customersA.some((c) => c.name === "Customer B"));

  // Unauthenticated / null scope fails closed with zero rows
  const unscopedShipments = await runWithOrgScope(null, () => listShipments());
  assert.equal(unscopedShipments.length, 0);
});

test("3. Company A cannot modify Company B's vehicles/conveyances or drivers", async () => {
  const tenantA = await createTestTenant("Alpha Freight", "alpha-freight", "admin@alpha.test");
  const tenantB = await createTestTenant("Beta Cargo", "beta-cargo", "admin@beta.test");
  await seedTenantOperations(tenantA, "A");
  const dataB = await seedTenantOperations(tenantB, "B");

  // Attempt cross-tenant UPDATE of Tenant B's conveyance while scoped to Tenant A
  const updatedConv = await queryAs<{ id: string }>(
    tenantA.orgId,
    `UPDATE conveyances SET assigned_to = $1, leg_state = $2 WHERE id = $3 RETURNING id`,
    ["HIJACKED", "IN_TRANSIT", dataB.conveyanceId],
  );
  assert.equal(updatedConv.length, 0);

  // Attempt cross-tenant UPDATE of Tenant B's driver while scoped to Tenant A
  const updatedDriver = await queryAs<{ id: string }>(
    tenantA.orgId,
    `UPDATE drivers SET current_city = $1 WHERE id = $2 RETURNING id`,
    ["Hijacked City", dataB.driverId],
  );
  assert.equal(updatedDriver.length, 0);

  // Verify Tenant B's fleet records remain completely untouched and invisible to Tenant A
  const aConveyances = await runWithOrgScope(tenantA.orgId, () => listConveyances());
  assert.equal(aConveyances.length, 1);
  assert.equal(aConveyances[0].registration, "TRK-A01");

  const bConveyances = await runWithOrgScope(tenantB.orgId, () => listConveyances());
  assert.equal(bConveyances.length, 1);
  assert.equal(bConveyances[0].registration, "TRK-B01");
  assert.equal(bConveyances[0].assigned_to, null);

  const bDrivers = await runWithOrgScope(tenantB.orgId, () => listDrivers());
  assert.equal(bDrivers.length, 1);
  assert.equal(bDrivers[0].name, "Driver B");
  assert.equal(bDrivers[0].current_city, "Abuja");
});

test("4. Company A cannot access Company B's financial approvals, BI metrics, or tactics records", async () => {
  const tenantA = await createTestTenant("Alpha Freight", "alpha-freight", "admin@alpha.test");
  const tenantB = await createTestTenant("Beta Cargo", "beta-cargo", "admin@beta.test");
  await seedTenantOperations(tenantA, "A");
  await seedTenantOperations(tenantB, "B");

  const approvalsA = await runWithOrgScope(tenantA.orgId, () => openApprovals());
  assert.equal(approvalsA.length, 1);
  assert.equal(Number(approvalsA[0].amount_minor), 500_000);
  assert.ok(!approvalsA.some((a) => Number(a.amount_minor) === 7_500_000));

  // Tactics state is strictly partitioned per tenant in DB/store (zero shared /tmp JSON)
  await updateTenantTacticsMutations(tenantA.orgId, (current) => ({
    ...current,
    supplierSyncs: [
      {
        id: "sync-alpha-1",
        supplierName: "Alpha Supplier Only",
        supplierCode: "SUP-ALPHA",
        contactName: "Ada Alpha",
        channel: "EMAIL",
        cadence: "WEEKLY",
        topic: "Capacity review",
        demandPlanSummary: "Alpha private contract pricing",
        lastSyncedAt: new Date().toISOString(),
        nextSyncDueAt: new Date(Date.now() + 86_400_000).toISOString(),
        status: "ON_TRACK",
        loggedBy: tenantA.adminEmail,
      },
      ...current.supplierSyncs,
    ],
  }));

  const tacticsA = await collectTacticsSnapshot({
    orgId: tenantA.orgId,
    orgName: tenantA.orgName,
  });
  const tacticsB = await collectTacticsSnapshot({
    orgId: tenantB.orgId,
    orgName: tenantB.orgName,
  });
  assert.ok(
    tacticsA.supplierSyncs.some((s) => s.supplierName === "Alpha Supplier Only"),
  );
  assert.ok(
    !tacticsB.supplierSyncs.some((s) => s.supplierName === "Alpha Supplier Only"),
  );
});

test("5. Company A cannot retrieve Company B's documents or traverse tenant blob storage", async () => {
  const tenantA = await createTestTenant("Alpha Freight", "alpha-freight", "admin@alpha.test");
  const tenantB = await createTestTenant("Beta Cargo", "beta-cargo", "admin@beta.test");
  const dataA = await seedTenantOperations(tenantA, "A");
  const dataB = await seedTenantOperations(tenantB, "B");

  // DB metadata isolation
  const docsA = await runWithOrgScope(tenantA.orgId, () => listDocuments());
  assert.equal(docsA.length, 1);
  assert.equal(docsA[0].filename, "bill-of-lading-A.txt");

  const crossDocLookup = await queryAs<{ id: string }>(
    tenantA.orgId,
    `SELECT id, filename, storage_key FROM documents WHERE id = $1 LIMIT 1`,
    [dataB.documentId],
  );
  assert.equal(crossDocLookup.length, 0);

  // Authorized blob read succeeds
  const ownBlob = readTenantDocumentBlob(tenantA.orgId, dataA.storageKey);
  assert.ok(ownBlob);
  assert.equal(ownBlob.toString("utf8"), "CONFIDENTIAL BOL FOR TENANT A");

  // Cross-tenant storage key & path traversal attempts throw
  assert.throws(
    () => readTenantDocumentBlob(tenantA.orgId, dataB.storageKey),
    /Cross-tenant document storage key rejected/i,
  );
  assert.throws(
    () => resolveTenantDocumentPath(tenantA.orgId, `${tenantA.orgId}/../${dataB.storageKey}`),
    /Invalid document storage key/i,
  );
});

test("6. AI agents and BI collectors operate strictly within verified tenant context and fail closed without orgId", async () => {
  const tenantA = await createTestTenant("Alpha Freight", "alpha-freight", "admin@alpha.test");
  const tenantB = await createTestTenant("Beta Cargo", "beta-cargo", "admin@beta.test");
  const dataA = await seedTenantOperations(tenantA, "A");
  const dataB = await seedTenantOperations(tenantB, "B");

  // Authorized AI operational context for Tenant A sees only Tenant A
  const ctxA = await runWithOrgScope(tenantA.orgId, () =>
    gatherOperationalContext("shipment-management"),
  );
  assert.equal(ctxA.snapshot.tenantWorkspaceId, tenantA.orgId);
  const shipmentsSnapA = (ctxA.snapshot.shipments ?? []) as Array<{
    reference: string;
  }>;
  assert.equal(shipmentsSnapA.length, 1);
  assert.equal(shipmentsSnapA[0].reference, dataA.shipmentRef);
  assert.ok(!shipmentsSnapA.some((s) => s.reference === dataB.shipmentRef));

  // Unscoped AI context & orchestrator fail closed
  await assert.rejects(
    () => runWithOrgScope(null, () => gatherOperationalContext("shipment-management")),
    /Missing verified workspace context/i,
  );
  await assert.rejects(
    () =>
      runWithOrgScope(null, () =>
        executeAgentTask({
          agentId: "fleet-management",
          task: "Summarize fleet status",
        }),
      ),
    /Missing verified workspace context/i,
  );

  // BI snapshot strictly isolated and fails closed when unscoped
  const biA = await collectBiSnapshot({
    orgId: tenantA.orgId,
    orgName: tenantA.orgName,
    role: "ADMIN",
  });
  assert.equal(biA.orgName, tenantA.orgName);
  assert.equal(biA.recordCounts.shipments, 1);
  await assert.rejects(
    () =>
      runWithOrgScope(null, () =>
        collectBiSnapshot({ orgId: "", orgName: "Invalid", role: "ADMIN" }),
      ),
    /Missing verified workspace context/i,
  );
});

test("7. Workspace parameter tampering in headers/query/body is rejected while matching orgId is allowed", async () => {
  const tenantA = await createTestTenant("Alpha Freight", "alpha-freight", "admin@alpha.test");
  const tenantB = await createTestTenant("Beta Cargo", "beta-cargo", "admin@beta.test");

  // Direct candidate list check
  const tampered = detectWorkspaceTampering(tenantA.orgId, [
    null,
    undefined,
    tenantB.orgId,
  ]);
  assert.ok(tampered);
  assert.match(tampered, /Cross-workspace access denied/i);

  // Request-object overload check (headers, query string, body)
  const fakeReqHeaderTamper = {
    headers: new Headers({ "x-workspace-id": tenantB.orgId }),
    url: "https://controltower.local/api/map",
  };
  assert.ok(detectWorkspaceTampering(fakeReqHeaderTamper, tenantA.orgId));

  const fakeReqQueryTamper = {
    headers: new Headers(),
    url: `https://controltower.local/api/map?orgId=${tenantB.orgId}`,
  };
  assert.ok(detectWorkspaceTampering(fakeReqQueryTamper, tenantA.orgId));

  const fakeReqBodyTamper = {
    headers: new Headers(),
    url: "https://controltower.local/api/agents/run",
  };
  assert.ok(
    detectWorkspaceTampering(fakeReqBodyTamper, tenantA.orgId, {
      workspaceId: tenantB.orgId,
    }),
  );

  // Matching or omitted values pass cleanly
  assert.equal(detectWorkspaceTampering(tenantA.orgId, [null, undefined, ""]), null);
  assert.equal(detectWorkspaceTampering(tenantA.orgId, [tenantA.orgId]), null);
  assert.equal(
    detectWorkspaceTampering(
      { headers: new Headers({ "x-workspace-id": tenantA.orgId }), url: "https://controltower.local/api/map" },
      tenantA.orgId,
      { orgId: tenantA.orgId },
    ),
    null,
  );
});

test("8. Realtime event queries are isolated per tenant and revoked/deactivated sessions fail verification immediately", async () => {
  const tenantA = await createTestTenant("Alpha Freight", "alpha-freight", "admin@alpha.test");
  const tenantB = await createTestTenant("Beta Cargo", "beta-cargo", "admin@beta.test");
  const dataA = await seedTenantOperations(tenantA, "A");
  await seedTenantOperations(tenantB, "B");

  // Exact SSE stream query for Tenant A returns only Tenant A's events
  const eventsA = await queryAs<{ reference: string; actor: string }>(
    tenantA.orgId,
    `SELECT e.id::text AS id, e.type, e.actor, e.to_state, e.created_at, s.reference
       FROM shipment_events e
       JOIN shipments s ON s.id = e.shipment_id
      WHERE e.id > $1
      ORDER BY e.id ASC
      LIMIT $2`,
    [0, 50],
  );
  assert.equal(eventsA.length, 1);
  assert.equal(eventsA[0].reference, dataA.shipmentRef);
  assert.equal(eventsA[0].actor, tenantA.adminEmail);

  // Active session verifies before revocation
  const activeUser = await verifyActiveSessionToken(tenantA.sessionToken);
  assert.ok(activeUser);
  assert.equal(activeUser.orgId, tenantA.orgId);

  // Invite a member, create a session, then deactivate them -> session immediately invalidated
  const inviteRes = await createTeamInvitation(tenantA.orgId, tenantA.adminSessionUser, {
    email: "ops@alpha.test",
    role: "DISPATCHER",
    departments: ["SHIPMENTS"],
    branchCodes: ["WH-LAG"],
  });
  assert.equal(inviteRes.ok, true);
  if (!inviteRes.ok) return;

  const acceptRes = await acceptTeamInvitation(
    inviteRes.inviteToken,
    { name: "Ops User", password: "ValidPassword!2026" },
    {},
    { startSession: false },
  );
  assert.equal(acceptRes.ok, true);
  if (!acceptRes.ok) return;

  const memberToken = `sess_member_${Date.now()}`;
  await identityQuery(
    `INSERT INTO sessions (token, user_id, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, '127.0.0.1', 'sse-client')`,
    [memberToken, acceptRes.user.id, new Date(Date.now() + 86_400_000)],
  );
  assert.ok(await verifyActiveSessionToken(memberToken));

  const deact = await updateWorkspaceMember(
    tenantA.orgId,
    tenantA.adminSessionUser,
    acceptRes.user.id,
    { active: false },
  );
  assert.equal(deact.ok, true);

  // Deactivated user's SSE/WebSocket token must fail verification immediately
  const revokedCheck = await verifyActiveSessionToken(memberToken);
  assert.equal(revokedCheck, null);
});

test("9. Background jobs fail closed without orgId; webhooks require per-workspace credentials, HMAC, and replay protection", async () => {
  const tenantA = await createTestTenant("Alpha Freight", "alpha-freight", "admin@alpha.test");
  const tenantB = await createTestTenant("Beta Cargo", "beta-cargo", "admin@beta.test");

  // No global default org fallback
  assert.equal(await resolveDefaultOrgId(), null);

  // Background workflows & autonomous dispatch reject missing orgId
  assert.throws(
    () => assertVerifiedOrgId(null, "backgroundJob"),
    /Missing verified workspace context/i,
  );
  await assert.rejects(
    () =>
      runBackendAgentWorkflow({
        workflow: "planning.fleet_dispatch",
        task: "Check fleet",
        orgId: null,
      }),
    /Missing verified workspace context/i,
  );
  assert.throws(
    () =>
      scheduleBackgroundAgent({
        workflow: "planning.fleet_dispatch",
        task: "Check fleet",
        orgId: "",
      }),
    /Missing verified workspace context/i,
  );
  await assert.rejects(
    () =>
      dispatchToAutonomousAgent({
        sourceChannel: "EXTERNAL_API",
        message: "Create shipment Lagos to Abuja",
        orgId: null,
      }),
    /Missing verified workspace context/i,
  );

  // Per-workspace webhook token, intake API key, WhatsApp HMAC, and Telegram secret
  const secA = await getWorkspaceSecurityProfile(tenantA.orgId);
  assert.ok(secA?.webhookToken);
  const resolvedA = await resolveOrgByWebhookToken(secA.webhookToken);
  assert.equal(resolvedA?.id, tenantA.orgId);
  assert.equal(await resolveOrgByWebhookToken("forged-token-0000000000"), null);

  const keyA = await rotateWorkspaceIntakeKey(tenantA.orgId, tenantA.adminSessionUser);
  const resolvedByKey = await resolveOrgByIntakeApiKey(keyA.apiKey);
  assert.equal(resolvedByKey?.id, tenantA.orgId);
  assert.equal(await resolveOrgByIntakeApiKey("ct_ws_invalid_key_1234567890"), null);

  await updateWorkspaceChannelSecrets(tenantA.orgId, tenantA.adminSessionUser, {
    whatsappPhoneNumberId: "100200300",
    whatsappVerifyToken: "verify-alpha-secret",
    whatsappAppSecret: "meta-app-secret-alpha",
    telegramWebhookSecret: "tg-secret-alpha-xyz",
  });

  const orgAWithSecrets = await resolveOrgByWebhookToken(secA.webhookToken);
  assert.ok(orgAWithSecrets);
  const unsealedWaSecret = unsealWorkspaceWhatsAppSecret(orgAWithSecrets);
  assert.equal(unsealedWaSecret, "meta-app-secret-alpha");

  const rawPayload = JSON.stringify({ entry: [{ id: "1" }] });
  const validSig = `sha256=${createHmac("sha256", unsealedWaSecret!).update(rawPayload).digest("hex")}`;
  assert.equal(verifyWhatsAppHmacSignature(rawPayload, validSig, unsealedWaSecret), true);
  assert.equal(verifyWhatsAppHmacSignature(rawPayload, "sha256=deadbeef", unsealedWaSecret), false);
  assert.equal(verifyWhatsAppHmacSignature(rawPayload, null, unsealedWaSecret), false);

  assert.equal(verifyWorkspaceTelegramSecret(orgAWithSecrets, "tg-secret-alpha-xyz"), true);
  assert.equal(verifyWorkspaceTelegramSecret(orgAWithSecrets, "wrong-secret"), false);

  // Replay deduplication is enforced per tenant (duplicate in A blocked; same ID in B independent)
  assert.equal(await claimWorkspaceWebhookDelivery(tenantA.orgId, "WHATSAPP", "wamid.12345"), true);
  assert.equal(await claimWorkspaceWebhookDelivery(tenantA.orgId, "WHATSAPP", "wamid.12345"), false);
  assert.equal(await claimWorkspaceWebhookDelivery(tenantB.orgId, "WHATSAPP", "wamid.12345"), true);

  // Per-tenant rate limit isolates noisy neighbor Tenant A from Tenant B
  const r1 = checkTenantRateLimit(tenantA.orgId, "test-bucket", 2, 60_000);
  const r2 = checkTenantRateLimit(tenantA.orgId, "test-bucket", 2, 60_000);
  const r3 = checkTenantRateLimit(tenantA.orgId, "test-bucket", 2, 60_000);
  const rB = checkTenantRateLimit(tenantB.orgId, "test-bucket", 2, 60_000);
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, false);
  assert.equal(rB.allowed, true);
});

test("10. Team invites enforce single-workspace-per-email & single-use; department/branch RBAC scopes non-admin members while ADMIN retains full access", async () => {
  const tenantA = await createTestTenant("Alpha Freight", "alpha-freight", "admin@alpha.test");
  const tenantB = await createTestTenant("Beta Cargo", "beta-cargo", "admin@beta.test");
  const dataA = await seedTenantOperations(tenantA, "A");

  // Add a second warehouse & shipment in Tenant A under a different branch (WH-PHC)
  await queryAs(
    tenantA.orgId,
    `INSERT INTO warehouses (code, name, city, country, capacity_cbm, used_cbm, status)
     VALUES ('WH-PHC', 'Port Harcourt Hub', 'Port Harcourt', 'NG', 800, 100, 'ACTIVE')`,
  );
  await queryAs(
    tenantA.orgId,
    `INSERT INTO shipments (
       reference, state, customer_ref, origin, destination, cargo, deadline, plan, created_via
     )
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9)`,
    [
      "LG-A0002",
      "IN_TRANSIT",
      "Customer A",
      JSON.stringify({ city: "Port Harcourt", country: "NG", port: "WH-PHC" }),
      JSON.stringify({ city: "Enugu", country: "NG", port: "WH-ENU" }),
      JSON.stringify({ description: "Oilfield Valves", weight_kg: 600 }),
      new Date(Date.now() + 72 * 3_600_000).toISOString(),
      JSON.stringify({ modes: ["ROAD"], distance_km: 230 }),
      "MANUAL",
    ],
  );

  // Admin A invites scoped member limited to FLEET + WH-LAG
  const invite = await createTeamInvitation(tenantA.orgId, tenantA.adminSessionUser, {
    email: "fleet.lagos@alpha.test",
    role: "DISPATCHER",
    departments: ["FLEET"],
    branchCodes: ["WH-LAG"],
  });
  assert.equal(invite.ok, true);
  if (!invite.ok) return;

  // Cross-tenant admin cannot invite into Tenant A
  const crossInvite = await createTeamInvitation(tenantA.orgId, tenantB.adminSessionUser, {
    email: "intruder@beta.test",
    role: "ADMIN",
  });
  assert.equal(crossInvite.ok, false);

  // Accept invite creates member bound to Tenant A with scoped permissions
  const accepted = await acceptTeamInvitation(
    invite.inviteToken,
    { name: "Lagos Fleet Dispatcher", password: "ValidPassword!2026" },
    {},
    { startSession: false },
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;

  assert.equal(accepted.user.orgId, tenantA.orgId);
  assert.deepEqual(accepted.user.departments, ["FLEET"]);
  assert.deepEqual(accepted.user.branchCodes, ["WH-LAG"]);

  // Single-use: re-accepting same token fails
  const replayAccept = await acceptTeamInvitation(
    invite.inviteToken,
    { name: "Replay", password: "ValidPassword!2026" },
    {},
    { startSession: false },
  );
  assert.equal(replayAccept.ok, false);

  // Single workspace per email: Tenant B cannot invite an email already belonging to Tenant A
  const dupAcrossOrgs = await createTeamInvitation(tenantB.orgId, tenantB.adminSessionUser, {
    email: "fleet.lagos@alpha.test",
    role: "VIEWER",
  });
  assert.equal(dupAcrossOrgs.ok, false);

  // Department & branch RBAC assertions
  assert.equal(hasDepartmentAccess(accepted.user, "FLEET"), true);
  assert.equal(hasDepartmentAccess(accepted.user, "FINANCE"), false);
  assert.equal(hasDepartmentAccess(accepted.user, departmentForAgent("financial-management")), false);
  assert.equal(hasDepartmentAccess(accepted.user, departmentForAgent("fleet-management")), true);

  assert.equal(hasBranchAccess(accepted.user, "WH-LAG"), true);
  assert.equal(hasBranchAccess(accepted.user, "WH-PHC"), false);

  // Admin has unrestricted access to all departments & branches
  assert.equal(hasDepartmentAccess(tenantA.adminSessionUser, "FINANCE"), true);
  assert.equal(hasBranchAccess(tenantA.adminSessionUser, "WH-PHC"), true);

  // AI operational context applies member's branch scope (sees WH-LAG only, hides WH-PHC)
  const scopedShipCtx = await runWithOrgScope(tenantA.orgId, () =>
    gatherOperationalContext("shipment-management", undefined, {
      role: accepted.user.role,
      departments: accepted.user.departments,
      branchCodes: accepted.user.branchCodes,
    }),
  );
  const scopedShipments = (scopedShipCtx.snapshot.shipments ?? []) as Array<{
    reference: string;
  }>;
  assert.equal(scopedShipments.length, 1);
  assert.equal(scopedShipments[0].reference, dataA.shipmentRef);

  const scopedWhCtx = await runWithOrgScope(tenantA.orgId, () =>
    gatherOperationalContext("warehouse-coordination", undefined, {
      role: accepted.user.role,
      departments: accepted.user.departments,
      branchCodes: accepted.user.branchCodes,
    }),
  );
  const scopedWarehouses = (scopedWhCtx.snapshot.warehouses ?? []) as Array<{
    code: string;
  }>;
  assert.equal(scopedWarehouses.length, 1);
  assert.equal(scopedWarehouses[0].code, "WH-LAG");

  // Admin sees both branches inside Tenant A (and zero from Tenant B)
  const adminCtx = await runWithOrgScope(tenantA.orgId, () =>
    gatherOperationalContext("shipment-management", undefined, {
      role: "ADMIN",
      departments: [],
      branchCodes: [],
    }),
  );
  const adminShipments = (adminCtx.snapshot.shipments ?? []) as Array<{
    reference: string;
  }>;
  assert.equal(adminShipments.length, 2);

  // filterByBranchScope helper check
  const filtered = filterByBranchScope(
    [
      { id: "1", branch: "WH-LAG" },
      { id: "2", branch: "WH-PHC" },
    ],
    accepted.user,
    (item) => [item.branch],
  );
  assert.deepEqual(
    filtered.map((x) => x.id),
    ["1"],
  );

  // Workspace members list only shows Tenant A members
  const membersA = await listWorkspaceMembers(tenantA.orgId);
  assert.equal(membersA.length, 2);
  const membersB = await listWorkspaceMembers(tenantB.orgId);
  assert.equal(membersB.length, 1);

  // Direct query() with null scope returns empty rows
  const directUnscoped = await runWithOrgScope(null, () =>
    query<{ id: string }>("SELECT id FROM shipments"),
  );
  assert.equal(directUnscoped.length, 0);
});

test("11. P0 hardening: strict CSRF origin check, production secret sealing, malformed JSON rejection, and atomic transaction rollback", async () => {
  // 11a. verifySameOriginRequest rejects missing Origin & mismatched Origin, accepts matching host (ignoring :443/:80) & X-Requested-With
  assert.equal(
    verifySameOriginRequest(new Headers({ host: "tower.example.com" })),
    false,
  );
  assert.equal(
    verifySameOriginRequest(
      new Headers({
        host: "tower.example.com",
        origin: "https://evil.example",
      }),
    ),
    false,
  );
  assert.equal(
    verifySameOriginRequest(
      new Headers({
        host: "tower.example.com",
        origin: "https://tower.example.com:443",
      }),
    ),
    true,
  );
  assert.equal(
    verifySameOriginRequest(
      new Headers({
        host: "127.0.0.1:3000",
        "x-requested-with": "XMLHttpRequest",
      }),
    ),
    true,
  );

  // 11b. sealWebhookSecret fails closed in production when CREDENTIALS_KEY is unset, and uses AES-256-GCM when set
  const prevNodeEnv = process.env.NODE_ENV;
  const prevCredKey = process.env.CREDENTIALS_KEY;
  try {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.CREDENTIALS_KEY;
    assert.throws(
      () => sealWebhookSecret("whsec_top_secret"),
      /CREDENTIALS_KEY must be configured/i,
    );

    process.env.CREDENTIALS_KEY = "audit-test-encryption-key-32bytes";
    const sealed = sealWebhookSecret("whsec_top_secret");
    assert.ok(sealed.startsWith("enc:"));
    assert.equal(unsealWebhookSecret(sealed), "whsec_top_secret");
  } finally {
    if (prevNodeEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
    else (process.env as Record<string, string | undefined>).NODE_ENV = prevNodeEnv;
    if (prevCredKey === undefined) delete process.env.CREDENTIALS_KEY;
    else process.env.CREDENTIALS_KEY = prevCredKey;
  }

  // 11c. detectAndParseRawPayload rejects malformed JSON when Content-Type declares application/json
  const malformed = detectAndParseRawPayload("{broken-json", "application/json");
  assert.equal(malformed.records.length, 0);
  assert.ok(malformed.parseError && /Malformed JSON/i.test(malformed.parseError));

  // 11d. transaction() atomically rolls back local-store writes on mid-transaction throw
  const tenantA = await createTestTenant("Rollback Co", "rollback-co", "admin@rollback.test");
  const before = (await runWithOrgScope(tenantA.orgId, () => listCustomers())).length;
  await assert.rejects(
    () =>
      runWithOrgScope(tenantA.orgId, () =>
        transaction(async (client) => {
          await client.query(
            `INSERT INTO customers (code, name, sla_hours, payment_terms, default_currency, contacts)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            ["RB-001", "Should Rollback", 24, "NET15", "USD", "[]"],
          );
          throw new Error("Simulated mid-tx failure");
        }),
      ),
    /Simulated mid-tx failure/,
  );
  const after = (await runWithOrgScope(tenantA.orgId, () => listCustomers())).length;
  assert.equal(after, before);
});

