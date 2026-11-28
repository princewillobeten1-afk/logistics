import test from "node:test";
import assert from "node:assert/strict";
import { signUp } from "@/lib/auth";
import { query, runWithOrgScope } from "@/lib/db";
import { checkDistributedTenantRateLimit } from "@/lib/distributed-guard";
import {
  applyEntitlementOverrides,
  applyGrowthReassessment,
  buildDefaultEntitlements,
  buildDefaultWorkspaceConfiguration,
  classifyBusinessProfile,
  evaluateGrowthReassessment,
  isFeatureEntitled,
} from "./classifier";
import {
  getWorkspaceConfiguration,
  getWorkspaceNavAdaptation,
  saveWorkspaceConfiguration,
} from "./store";

test("classifies all five logistics archetypes accurately by scale and operational complexity", () => {
  // Business A: Small Courier
  const smallCourier = classifyBusinessProfile({
    businessModel: "COURIER",
    employeeCount: 8,
    vehicleCount: 3,
    warehouseCount: 1,
    branchCount: 1,
    monthlyShipments: 30,
    customerCount: 15,
    carrierCount: 2,
    transportModes: ["ROAD"],
    operatesInternationally: false,
    requiresCustomsClearance: false,
    managesThirdPartyClients: false,
  });
  assert.equal(smallCourier.tier, "SMALL");
  assert.equal(smallCourier.archetype, "COURIER");
  assert.equal(smallCourier.recommendedConfig.defaultSlaHours, 24);
  assert.equal(smallCourier.recommendedConfig.customsWorkflowEnabled, false);

  // Business B: Medium Logistics
  const mediumLogistics = classifyBusinessProfile({
    businessModel: "REGIONAL_LOGISTICS",
    employeeCount: 75,
    vehicleCount: 35,
    warehouseCount: 4,
    branchCount: 3,
    monthlyShipments: 500,
    customerCount: 150,
    carrierCount: 10,
    transportModes: ["ROAD"],
    operatesInternationally: false,
    requiresCustomsClearance: false,
    managesThirdPartyClients: false,
  });
  assert.equal(mediumLogistics.tier, "MEDIUM");
  assert.equal(mediumLogistics.archetype, "REGIONAL_LOGISTICS");
  assert.ok(mediumLogistics.recommendedConfig.recommendedFeatures.includes("BUSINESS_INTELLIGENCE"));

  // Business C: Large Enterprise Logistics
  const largeEnterprise = classifyBusinessProfile({
    businessModel: "ENTERPRISE_NETWORK",
    employeeCount: 800,
    vehicleCount: 250,
    warehouseCount: 20,
    branchCount: 12,
    monthlyShipments: 10_000,
    customerCount: 2_000,
    carrierCount: 30,
    transportModes: ["ROAD", "AIR", "SEA"],
    operatesInternationally: true,
    requiresCustomsClearance: true,
    managesThirdPartyClients: false,
  });
  assert.equal(largeEnterprise.tier, "ENTERPRISE");
  assert.equal(largeEnterprise.complexityBand, "VERY_HIGH");
  assert.equal(largeEnterprise.recommendedConfig.multiBranchEnabled, true);
  assert.ok(largeEnterprise.recommendedConfig.recommendedFeatures.includes("AI_VOICE_COPILOT"));

  // Business D: International Freight
  const intlFreight = classifyBusinessProfile({
    businessModel: "INTERNATIONAL_FREIGHT",
    employeeCount: 45,
    vehicleCount: 10,
    warehouseCount: 3,
    branchCount: 4,
    monthlyShipments: 400,
    customerCount: 80,
    carrierCount: 18,
    transportModes: ["AIR", "SEA", "ROAD"],
    operatesInternationally: true,
    requiresCustomsClearance: true,
    managesThirdPartyClients: false,
  });
  assert.equal(intlFreight.archetype, "INTERNATIONAL_FREIGHT");
  assert.equal(intlFreight.recommendedConfig.customsWorkflowEnabled, true);
  assert.ok(intlFreight.recommendedConfig.recommendedFeatures.includes("INTERNATIONAL_CUSTOMS"));
  assert.ok(intlFreight.recommendedConfig.recommendedDepartments.includes("CUSTOMS"));

  // Business E: Third-Party Logistics (3PL)
  const provider3pl = classifyBusinessProfile({
    businessModel: "THIRD_PARTY_LOGISTICS",
    employeeCount: 110,
    vehicleCount: 28,
    warehouseCount: 6,
    branchCount: 4,
    monthlyShipments: 1_200,
    customerCount: 45,
    carrierCount: 14,
    transportModes: ["ROAD", "SEA"],
    operatesInternationally: true,
    requiresCustomsClearance: false,
    managesThirdPartyClients: true,
  });
  assert.equal(provider3pl.archetype, "THIRD_PARTY_LOGISTICS");
  assert.equal(provider3pl.recommendedConfig.clientPortalReportingEnabled, true);
  assert.ok(provider3pl.recommendedConfig.recommendedFeatures.includes("THIRD_PARTY_3PL"));
});

test("feature entitlements operate independently of business classification tier and protect core ops", () => {
  const smallProfile = {
    businessModel: "COURIER" as const,
    employeeCount: 8,
    vehicleCount: 3,
    warehouseCount: 1,
    branchCount: 1,
    monthlyShipments: 30,
    customerCount: 15,
    carrierCount: 2,
    transportModes: ["ROAD" as const],
    operatesInternationally: false,
    requiresCustomsClearance: false,
    managesThirdPartyClients: false,
  };
  const classification = classifyBusinessProfile(smallProfile);
  assert.equal(classification.tier, "SMALL");

  const initial = buildDefaultEntitlements(classification);
  assert.equal(isFeatureEntitled(initial, "INTERNATIONAL_CUSTOMS"), false);
  assert.equal(isFeatureEntitled(initial, "AI_VOICE_COPILOT"), false);

  // Admin enables Voice Copilot & Customs independently of SMALL tier, and tries to disable CORE_OPERATIONS
  const overridden = applyEntitlementOverrides(
    initial,
    {
      INTERNATIONAL_CUSTOMS: true,
      AI_VOICE_COPILOT: true,
      CORE_OPERATIONS: false,
    },
    "admin@smallcourier.test",
  );
  assert.equal(isFeatureEntitled(overridden, "INTERNATIONAL_CUSTOMS"), true);
  assert.equal(overridden.INTERNATIONAL_CUSTOMS.source, "ADMIN_OVERRIDE");
  assert.equal(isFeatureEntitled(overridden, "AI_VOICE_COPILOT"), true);
  assert.equal(isFeatureEntitled(overridden, "CORE_OPERATIONS"), true, "Core operations must never be disabled");
});

test("growth reassessment detects scale-up from SMALL to ENTERPRISE and preserves admin overrides", () => {
  const initial = buildDefaultWorkspaceConfiguration("org-growth-unit", {
    businessModel: "COURIER",
    employeeCount: 8,
    vehicleCount: 3,
    warehouseCount: 1,
    branchCount: 1,
    monthlyShipments: 30,
    customerCount: 15,
    carrierCount: 2,
    transportModes: ["ROAD"],
    operatesInternationally: false,
    requiresCustomsClearance: false,
    managesThirdPartyClients: false,
  });
  initial.entitlements = applyEntitlementOverrides(
    initial.entitlements,
    { TACTICS_OPTIMIZATION: false },
    "founder@growth.test",
  );

  const reassessment = evaluateGrowthReassessment(initial.profile, {
    activeUsers: 400,
    vehicles: 150,
    warehouses: 12,
    customers: 800,
    carriers: 20,
    shipments: 6_500,
    orders: 6_500,
  });
  assert.equal(reassessment.needsReassessment, true);
  assert.equal(reassessment.currentTier, "SMALL");
  assert.equal(reassessment.projectedTier, "ENTERPRISE");

  const upgraded = applyGrowthReassessment(
    initial,
    reassessment.recommendedProfile,
    "founder@growth.test",
    { preserveAdminOverrides: true },
  );
  assert.equal(upgraded.orgId, "org-growth-unit");
  assert.equal(upgraded.classification.tier, "ENTERPRISE");
  assert.equal(upgraded.approvedConfig.status, "APPROVED");
  assert.equal(upgraded.growthHistory.length, 1);
  assert.equal(upgraded.growthHistory[0].fromTier, "SMALL");
  assert.equal(upgraded.growthHistory[0].toTier, "ENTERPRISE");
  // Preserved admin override
  assert.equal(upgraded.entitlements.TACTICS_OPTIMIZATION.enabled, false);
  assert.equal(upgraded.entitlements.TACTICS_OPTIMIZATION.source, "ADMIN_OVERRIDE");
});

test("persisted workspace configuration isolates tenants, adapts nav, and preserves operational records across growth", async () => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const signupA = await signUp({
    companyName: `Growth Courier ${runId}`,
    name: "Founder A",
    email: `founder-a-${runId}@p1.test`,
    password: "StrongP1Password!2026",
  });
  const signupB = await signUp({
    companyName: `Isolated Freight ${runId}`,
    name: "Admin B",
    email: `admin-b-${runId}@p1.test`,
    password: "StrongP1Password!2026",
  });
  assert.equal(signupA.ok, true);
  assert.equal(signupB.ok, true);
  if (!signupA.ok || !signupB.ok) return;

  const orgA = signupA.user.orgId;
  const orgB = signupB.user.orgId;

  // Seed an existing shipment in Org A before configuration changes
  await runWithOrgScope(orgA, async () => {
    await query(
      `INSERT INTO shipments (reference, state, customer_ref, origin, destination, cargo, created_via)
       VALUES ($1, 'IN_TRANSIT', $2, $3::jsonb, $4::jsonb, $5::jsonb, 'MANUAL')`,
      [
        `LG-P1-${runId}`,
        "Acme Retail",
        JSON.stringify({ city: "Lagos" }),
        JSON.stringify({ city: "Abuja" }),
        JSON.stringify({ quantity: 5, weight_kg: 120 }),
      ],
    );
  });

  // Save Org A as SMALL courier with TACTICS_OPTIMIZATION explicitly disabled
  const savedA = await saveWorkspaceConfiguration(orgA, signupA.user.email, {
    profile: {
      businessModel: "COURIER",
      employeeCount: 8,
      vehicleCount: 3,
      warehouseCount: 1,
      branchCount: 1,
      monthlyShipments: 30,
      customerCount: 15,
      carrierCount: 2,
      transportModes: ["ROAD"],
    },
    approve: true,
    entitlementOverrides: { TACTICS_OPTIMIZATION: false },
  });
  assert.equal(savedA.configuration.classification.tier, "SMALL");

  // Save Org B as ENTERPRISE international freight
  const savedB = await saveWorkspaceConfiguration(orgB, signupB.user.email, {
    profile: {
      businessModel: "INTERNATIONAL_FREIGHT",
      employeeCount: 500,
      vehicleCount: 180,
      warehouseCount: 14,
      branchCount: 8,
      monthlyShipments: 8_000,
      customerCount: 900,
      carrierCount: 25,
      transportModes: ["AIR", "SEA", "ROAD"],
      operatesInternationally: true,
      requiresCustomsClearance: true,
    },
    approve: true,
  });
  assert.equal(savedB.configuration.classification.tier, "ENTERPRISE");

  // Verify tenant isolation: Org A is still SMALL and Org B is ENTERPRISE
  const reloadedA = await getWorkspaceConfiguration(orgA);
  const reloadedB = await getWorkspaceConfiguration(orgB);
  assert.equal(reloadedA.configuration.classification.tier, "SMALL");
  assert.equal(reloadedB.configuration.classification.tier, "ENTERPRISE");

  // Verify nav adaptation hides /tactics for Org A but keeps it for Org B
  const navA = await getWorkspaceNavAdaptation(orgA);
  const navB = await getWorkspaceNavAdaptation(orgB);
  assert.ok(navA.disabledHrefs.includes("/tactics"));
  assert.equal(navB.disabledHrefs.includes("/tactics"), false);

  // Grow Org A from SMALL to ENTERPRISE without losing its historical shipment
  const grownA = await saveWorkspaceConfiguration(orgA, signupA.user.email, {
    applyGrowthReassessment: true,
    preserveAdminOverrides: true,
    profile: {
      businessModel: "ENTERPRISE_NETWORK",
      employeeCount: 800,
      vehicleCount: 250,
      warehouseCount: 20,
      branchCount: 10,
      monthlyShipments: 10_000,
      customerCount: 2_000,
      carrierCount: 30,
      transportModes: ["ROAD", "AIR"],
    },
  });
  assert.equal(grownA.configuration.orgId, orgA);
  assert.equal(grownA.configuration.classification.tier, "ENTERPRISE");
  assert.equal(grownA.configuration.entitlements.TACTICS_OPTIMIZATION.enabled, false);

  // Historical shipment in Org A is 100% intact
  const surviving = await runWithOrgScope(orgA, () =>
    query<{ reference: string }>(
      `SELECT reference FROM shipments WHERE upper(reference) = $1 LIMIT 1`,
      [`LG-P1-${runId}`.toUpperCase()],
    ),
  );
  assert.equal(surviving.length, 1);
  assert.equal(surviving[0].reference, `LG-P1-${runId}`);

  // Distributed rate limiter enforces per-tenant limits via database backend cleanly
  const bucket = `p1-rate-${runId}`;
  const r1 = await checkDistributedTenantRateLimit(orgA, bucket, 2, 60_000);
  const r2 = await checkDistributedTenantRateLimit(orgA, bucket, 2, 60_000);
  const r3 = await checkDistributedTenantRateLimit(orgA, bucket, 2, 60_000);
  const rB = await checkDistributedTenantRateLimit(orgB, bucket, 2, 60_000);
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 1);
  assert.equal(r1.backend, "database");
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 0);
  assert.equal(r3.allowed, false);
  assert.ok(r3.retryAfterSec >= 1);
  assert.equal(rB.allowed, true, "Tenant B rate bucket must be isolated from Tenant A");
});
