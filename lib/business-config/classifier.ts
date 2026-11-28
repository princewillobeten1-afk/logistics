import type { WorkspaceDepartment } from "@/lib/departments";
import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  type ApprovedOperationalConfig,
  type BusinessArchetype,
  type BusinessClassificationResult,
  type BusinessOperationalProfile,
  type BusinessTier,
  type FeatureEntitlementMap,
  type FeatureKey,
  type GrowthReassessment,
  type ObservedWorkspaceMetrics,
  type TransportMode,
  type WorkspaceConfigurationRecord,
} from "./types";

const VALID_ARCHETYPES = new Set<BusinessArchetype>([
  "COURIER",
  "REGIONAL_LOGISTICS",
  "ENTERPRISE_NETWORK",
  "INTERNATIONAL_FREIGHT",
  "THIRD_PARTY_LOGISTICS",
]);

const VALID_MODES = new Set<TransportMode>(["ROAD", "AIR", "SEA", "RAIL"]);

export function createDefaultBusinessProfile(): BusinessOperationalProfile {
  return {
    businessModel: "REGIONAL_LOGISTICS",
    employeeCount: 25,
    vehicleCount: 10,
    warehouseCount: 2,
    branchCount: 1,
    monthlyShipments: 250,
    customerCount: 40,
    carrierCount: 5,
    transportModes: ["ROAD"],
    operatesInternationally: false,
    requiresCustomsClearance: false,
    managesThirdPartyClients: false,
  };
}

function clampNonNegativeInt(val: unknown, fallback: number, max = 1_000_000): number {
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.round(n), max);
}

/**
 * Validates and normalizes untrusted business operational profile input.
 */
export function normalizeBusinessProfile(
  input: Partial<BusinessOperationalProfile> | null | undefined,
  fallback: BusinessOperationalProfile = createDefaultBusinessProfile(),
): BusinessOperationalProfile {
  const rawModel = String(input?.businessModel ?? fallback.businessModel).toUpperCase() as BusinessArchetype;
  const businessModel = VALID_ARCHETYPES.has(rawModel) ? rawModel : fallback.businessModel;

  const rawModes = Array.isArray(input?.transportModes)
    ? input.transportModes
        .map((m) => String(m).toUpperCase() as TransportMode)
        .filter((m) => VALID_MODES.has(m))
    : fallback.transportModes;
  const transportModes: TransportMode[] =
    rawModes.length > 0 ? Array.from(new Set(rawModes)) : ["ROAD"];

  const operatesInternationally =
    typeof input?.operatesInternationally === "boolean"
      ? input.operatesInternationally
      : businessModel === "INTERNATIONAL_FREIGHT" ||
        transportModes.includes("AIR") ||
        transportModes.includes("SEA") ||
        fallback.operatesInternationally;

  const requiresCustomsClearance =
    typeof input?.requiresCustomsClearance === "boolean"
      ? input.requiresCustomsClearance
      : operatesInternationally && businessModel === "INTERNATIONAL_FREIGHT"
        ? true
        : fallback.requiresCustomsClearance;

  const managesThirdPartyClients =
    typeof input?.managesThirdPartyClients === "boolean"
      ? input.managesThirdPartyClients
      : businessModel === "THIRD_PARTY_LOGISTICS"
        ? true
        : fallback.managesThirdPartyClients;

  return {
    businessModel,
    employeeCount: clampNonNegativeInt(input?.employeeCount, fallback.employeeCount, 250_000),
    vehicleCount: clampNonNegativeInt(input?.vehicleCount, fallback.vehicleCount, 100_000),
    warehouseCount: clampNonNegativeInt(input?.warehouseCount, fallback.warehouseCount, 5_000),
    branchCount: Math.max(1, clampNonNegativeInt(input?.branchCount, fallback.branchCount, 5_000)),
    monthlyShipments: clampNonNegativeInt(input?.monthlyShipments, fallback.monthlyShipments, 50_000_000),
    customerCount: clampNonNegativeInt(input?.customerCount, fallback.customerCount, 5_000_000),
    carrierCount: clampNonNegativeInt(input?.carrierCount, fallback.carrierCount, 50_000),
    transportModes,
    operatesInternationally,
    requiresCustomsClearance,
    managesThirdPartyClients,
  };
}

/**
 * Pure, deterministic Business Classification Engine.
 * Evaluates scale AND operational complexity (modes, customs, multi-branch, 3PL).
 */
export function classifyBusinessProfile(
  rawProfile: BusinessOperationalProfile,
): BusinessClassificationResult {
  const profile = normalizeBusinessProfile(rawProfile);
  const rationale: string[] = [];

  // 1. Scale score (0 - 65)
  let scaleScore = 0;
  if (profile.employeeCount >= 250) scaleScore += 20;
  else if (profile.employeeCount >= 30) scaleScore += 12;
  else if (profile.employeeCount >= 10) scaleScore += 6;
  else scaleScore += 3;

  if (profile.vehicleCount >= 100) scaleScore += 15;
  else if (profile.vehicleCount >= 15) scaleScore += 9;
  else if (profile.vehicleCount >= 4) scaleScore += 4;
  else scaleScore += 2;

  if (profile.warehouseCount >= 10) scaleScore += 15;
  else if (profile.warehouseCount >= 3) scaleScore += 9;
  else if (profile.warehouseCount >= 1) scaleScore += 4;

  if (profile.monthlyShipments >= 5_000) scaleScore += 15;
  else if (profile.monthlyShipments >= 300) scaleScore += 9;
  else if (profile.monthlyShipments >= 50) scaleScore += 4;
  else scaleScore += 2;

  // 2. Operational complexity score (0 - 35)
  let opsScore = 0;
  if (profile.branchCount >= 5) opsScore += 8;
  else if (profile.branchCount >= 2) opsScore += 4;

  if (profile.carrierCount >= 15) opsScore += 6;
  else if (profile.carrierCount >= 5) opsScore += 3;

  if (profile.transportModes.length >= 3) opsScore += 7;
  else if (profile.transportModes.length === 2) opsScore += 4;

  if (profile.operatesInternationally) opsScore += 5;
  if (profile.requiresCustomsClearance) opsScore += 5;
  if (profile.managesThirdPartyClients) opsScore += 4;

  const complexityScore = Math.max(5, Math.min(100, scaleScore + opsScore));
  const complexityBand: BusinessClassificationResult["complexityBand"] =
    complexityScore >= 75
      ? "VERY_HIGH"
      : complexityScore >= 52
        ? "HIGH"
        : complexityScore >= 28
          ? "MODERATE"
          : "LOW";

  // 3. Tier classification (SMALL, MEDIUM, ENTERPRISE)
  let tier: BusinessTier;
  if (
    profile.employeeCount >= 250 ||
    profile.vehicleCount >= 100 ||
    profile.warehouseCount >= 10 ||
    profile.monthlyShipments >= 5_000 ||
    complexityScore >= 72
  ) {
    tier = "ENTERPRISE";
    rationale.push(
      `Enterprise-scale network (${profile.employeeCount} employees, ${profile.vehicleCount} vehicles, ${profile.warehouseCount} warehouses, ${profile.monthlyShipments.toLocaleString()} monthly shipments).`,
    );
  } else if (
    profile.employeeCount >= 25 ||
    profile.vehicleCount >= 12 ||
    profile.warehouseCount >= 3 ||
    profile.monthlyShipments >= 250 ||
    complexityScore >= 38
  ) {
    tier = "MEDIUM";
    rationale.push(
      `Mid-market operational footprint (${profile.employeeCount} employees, ${profile.vehicleCount} vehicles, ${profile.warehouseCount} warehouses).`,
    );
  } else {
    tier = "SMALL";
    rationale.push(
      `Streamlined small-business operation (${profile.employeeCount} employees, ${profile.vehicleCount} vehicles, ${profile.warehouseCount} warehouse${profile.warehouseCount === 1 ? "" : "s"}).`,
    );
  }

  // 4. Operational archetype
  let archetype: BusinessArchetype = profile.businessModel;
  if (profile.managesThirdPartyClients && archetype !== "THIRD_PARTY_LOGISTICS") {
    rationale.push("Multi-client 3PL fulfillment enabled alongside primary business model.");
  }
  if (profile.operatesInternationally || profile.requiresCustomsClearance) {
    rationale.push(
      `Cross-border ${profile.transportModes.join("/")} operations with ${profile.requiresCustomsClearance ? "active customs clearance" : "international lane tracking"}.`,
    );
  }
  if (archetype === "COURIER" && tier === "ENTERPRISE") {
    archetype = "ENTERPRISE_NETWORK";
    rationale.push("Upgraded archetype to Enterprise Network due to national/enterprise scale.");
  }

  // 5. Recommended departments, modules, and operational guardrails
  const departments = new Set<WorkspaceDepartment>([
    "ORDERS",
    "SHIPMENTS",
    "CUSTOMERS",
    "SUPPORT",
  ]);
  if (profile.vehicleCount > 0) departments.add("FLEET");
  if (profile.warehouseCount > 0) departments.add("WAREHOUSE");
  if (profile.carrierCount > 0) departments.add("FREIGHT");
  if (tier !== "SMALL") {
    departments.add("FINANCE");
    departments.add("BI");
    departments.add("ANALYTICS");
  }
  if (tier === "ENTERPRISE") {
    departments.add("HR");
    departments.add("PROCUREMENT");
    departments.add("COMPLIANCE");
  }
  if (profile.requiresCustomsClearance || profile.operatesInternationally) {
    departments.add("CUSTOMS");
    departments.add("COMPLIANCE");
  }

  const features = new Set<FeatureKey>(["CORE_OPERATIONS", "AI_AUTONOMOUS_AGENTS"]);
  if (profile.vehicleCount > 0) features.add("FLEET_DISPATCH");
  if (profile.warehouseCount > 0 || profile.managesThirdPartyClients) {
    features.add("WAREHOUSE_WMS");
  }
  if (profile.operatesInternationally || profile.requiresCustomsClearance) {
    features.add("INTERNATIONAL_CUSTOMS");
  }
  if (profile.managesThirdPartyClients || archetype === "THIRD_PARTY_LOGISTICS") {
    features.add("THIRD_PARTY_3PL");
  }
  if (tier === "MEDIUM" || tier === "ENTERPRISE" || complexityScore >= 40) {
    features.add("BUSINESS_INTELLIGENCE");
    features.add("EXTERNAL_INTEGRATIONS");
    features.add("TACTICS_OPTIMIZATION");
  }
  if (tier === "ENTERPRISE" || complexityScore >= 55) {
    features.add("AI_VOICE_COPILOT");
  }

  const defaultSlaHours =
    archetype === "COURIER"
      ? 24
      : archetype === "INTERNATIONAL_FREIGHT"
        ? 120
        : tier === "ENTERPRISE"
          ? 48
          : 72;

  const autoApproveLimitMinor =
    tier === "ENTERPRISE"
      ? 250_000_00
      : tier === "MEDIUM"
        ? 50_000_00
        : 10_000_00;

  const escalationThresholdMinutes =
    archetype === "COURIER" ? 30 : tier === "ENTERPRISE" ? 45 : 90;

  return {
    tier,
    archetype,
    complexityScore,
    complexityBand,
    rationale,
    recommendedConfig: {
      defaultSlaHours,
      autoApproveLimitMinor,
      escalationThresholdMinutes,
      recommendedDepartments: Array.from(departments),
      recommendedFeatures: Array.from(features),
      multiBranchEnabled: profile.branchCount > 1 || tier === "ENTERPRISE",
      customsWorkflowEnabled: profile.requiresCustomsClearance || profile.operatesInternationally,
      clientPortalReportingEnabled:
        profile.managesThirdPartyClients || archetype === "THIRD_PARTY_LOGISTICS",
    },
  };
}

/**
 * Creates the initial feature entitlement map from classification recommendations.
 * Once created, any feature can be toggled independently of classification tier.
 */
export function buildDefaultEntitlements(
  classification: BusinessClassificationResult,
  actorEmail: string | null = null,
  nowIso = new Date().toISOString(),
): FeatureEntitlementMap {
  const recommended = new Set<FeatureKey>(classification.recommendedConfig.recommendedFeatures);
  const map = {} as FeatureEntitlementMap;
  for (const key of FEATURE_KEYS) {
    const isCore = Boolean(FEATURE_CATALOG[key].coreRequired);
    map[key] = {
      enabled: isCore || recommended.has(key),
      source: "RECOMMENDED",
      updatedBy: actorEmail,
      updatedAt: nowIso,
    };
  }
  return map;
}

/**
 * Applies explicit admin feature entitlement toggles strictly independently of business tier.
 * Core operational features remain enabled to prevent workspace lockout.
 */
export function applyEntitlementOverrides(
  current: FeatureEntitlementMap,
  overrides: Partial<Record<FeatureKey, boolean>>,
  actorEmail: string,
  nowIso = new Date().toISOString(),
): FeatureEntitlementMap {
  const next: FeatureEntitlementMap = { ...current };
  for (const key of FEATURE_KEYS) {
    if (typeof overrides[key] !== "boolean") continue;
    if (FEATURE_CATALOG[key].coreRequired) {
      next[key] = {
        enabled: true,
        source: "RECOMMENDED",
        updatedBy: actorEmail,
        updatedAt: nowIso,
      };
      continue;
    }
    const existing = current[key];
    if (!existing || existing.enabled !== overrides[key] || existing.source !== "ADMIN_OVERRIDE") {
      next[key] = {
        enabled: overrides[key] as boolean,
        source: "ADMIN_OVERRIDE",
        updatedBy: actorEmail,
        updatedAt: nowIso,
      };
    }
  }
  return next;
}

/**
 * Checks whether a specific feature is currently enabled for a workspace.
 */
export function isFeatureEntitled(
  entitlements: Partial<FeatureEntitlementMap> | null | undefined,
  feature: FeatureKey,
): boolean {
  if (FEATURE_CATALOG[feature].coreRequired) return true;
  if (!entitlements || !entitlements[feature]) return true;
  return Boolean(entitlements[feature]?.enabled);
}

/**
 * Evaluates whether observed live workspace growth (or a proposed profile expansion)
 * warrants a non-destructive tier/configuration reassessment.
 */
export function evaluateGrowthReassessment(
  storedProfile: BusinessOperationalProfile,
  observed: ObservedWorkspaceMetrics,
): GrowthReassessment {
  const currentClassification = classifyBusinessProfile(storedProfile);

  const recommendedProfile: BusinessOperationalProfile = normalizeBusinessProfile({
    ...storedProfile,
    employeeCount: Math.max(storedProfile.employeeCount, observed.activeUsers),
    vehicleCount: Math.max(storedProfile.vehicleCount, observed.vehicles),
    warehouseCount: Math.max(storedProfile.warehouseCount, observed.warehouses),
    customerCount: Math.max(storedProfile.customerCount, observed.customers),
    carrierCount: Math.max(storedProfile.carrierCount, observed.carriers),
    monthlyShipments: Math.max(
      storedProfile.monthlyShipments,
      Math.max(observed.shipments, observed.orders),
    ),
  });

  const projectedClassification = classifyBusinessProfile(recommendedProfile);
  const reasons: string[] = [];

  if (projectedClassification.tier !== currentClassification.tier) {
    reasons.push(
      `Observed operational volume crossed from ${currentClassification.tier} to ${projectedClassification.tier} tier.`,
    );
  }
  if (observed.activeUsers > storedProfile.employeeCount * 1.5 && observed.activeUsers >= 20) {
    reasons.push(`Active workforce (${observed.activeUsers}) exceeds configured profile (${storedProfile.employeeCount}).`);
  }
  if (observed.vehicles > storedProfile.vehicleCount * 1.5 && observed.vehicles >= 10) {
    reasons.push(`Active fleet size (${observed.vehicles}) exceeds configured profile (${storedProfile.vehicleCount}).`);
  }
  if (observed.warehouses > storedProfile.warehouseCount && observed.warehouses >= 3) {
    reasons.push(`Warehouse count grew from ${storedProfile.warehouseCount} to ${observed.warehouses}.`);
  }
  if (
    Math.max(observed.shipments, observed.orders) > storedProfile.monthlyShipments * 2 &&
    Math.max(observed.shipments, observed.orders) >= 200
  ) {
    reasons.push(
      `Recorded shipment/order volume (${Math.max(observed.shipments, observed.orders).toLocaleString()}) exceeds baseline (${storedProfile.monthlyShipments.toLocaleString()}).`,
    );
  }

  return {
    needsReassessment:
      projectedClassification.tier !== currentClassification.tier ||
      projectedClassification.complexityScore >= currentClassification.complexityScore + 15 ||
      reasons.length > 0,
    currentTier: currentClassification.tier,
    projectedTier: projectedClassification.tier,
    currentComplexityScore: currentClassification.complexityScore,
    projectedComplexityScore: projectedClassification.complexityScore,
    reasons,
    recommendedProfile,
    recommendedClassification: projectedClassification,
  };
}

/**
 * Applies a non-destructive growth reassessment to an existing workspace configuration.
 * Preserves orgId, audit history, and all explicit ADMIN_OVERRIDE entitlements.
 */
export function applyGrowthReassessment(
  record: WorkspaceConfigurationRecord,
  nextRawProfile: BusinessOperationalProfile,
  actorEmail: string,
  options?: { preserveAdminOverrides?: boolean; note?: string; nowIso?: string },
): WorkspaceConfigurationRecord {
  const nowIso = options?.nowIso ?? new Date().toISOString();
  const preserveOverrides = options?.preserveAdminOverrides !== false;
  const nextProfile = normalizeBusinessProfile(nextRawProfile, record.profile);
  const nextClassification = classifyBusinessProfile(nextProfile);
  const recommendedDefaults = buildDefaultEntitlements(nextClassification, actorEmail, nowIso);

  const mergedEntitlements = {} as FeatureEntitlementMap;
  for (const key of FEATURE_KEYS) {
    const existing = record.entitlements[key];
    if (preserveOverrides && existing && existing.source === "ADMIN_OVERRIDE") {
      mergedEntitlements[key] = existing;
    } else {
      mergedEntitlements[key] = recommendedDefaults[key];
    }
  }

  const nextApprovedConfig: ApprovedOperationalConfig = {
    defaultSlaHours: nextClassification.recommendedConfig.defaultSlaHours,
    autoApproveLimitMinor: nextClassification.recommendedConfig.autoApproveLimitMinor,
    escalationThresholdMinutes: nextClassification.recommendedConfig.escalationThresholdMinutes,
    enabledDepartments: nextClassification.recommendedConfig.recommendedDepartments,
    multiBranchEnabled: nextClassification.recommendedConfig.multiBranchEnabled,
    customsWorkflowEnabled: nextClassification.recommendedConfig.customsWorkflowEnabled,
    clientPortalReportingEnabled: nextClassification.recommendedConfig.clientPortalReportingEnabled,
    status: "APPROVED",
  };

  const historyEntry = {
    timestamp: nowIso,
    actor: actorEmail,
    fromTier: record.classification.tier,
    toTier: nextClassification.tier,
    fromArchetype: record.classification.archetype,
    toArchetype: nextClassification.archetype,
    note:
      options?.note ??
      `Workspace reassessed from ${record.classification.tier} (${record.classification.archetype}) to ${nextClassification.tier} (${nextClassification.archetype}) while preserving all workspace records.`,
  };

  return {
    ...record,
    profile: nextProfile,
    classification: nextClassification,
    approvedConfig: nextApprovedConfig,
    entitlements: mergedEntitlements,
    growthHistory: [historyEntry, ...record.growthHistory].slice(0, 25),
    approvedBy: actorEmail,
    approvedAt: nowIso,
    updatedAt: nowIso,
  };
}

export function buildDefaultWorkspaceConfiguration(
  orgId: string,
  profile: BusinessOperationalProfile = createDefaultBusinessProfile(),
  nowIso = new Date().toISOString(),
): WorkspaceConfigurationRecord {
  const normalized = normalizeBusinessProfile(profile);
  const classification = classifyBusinessProfile(normalized);
  const entitlements = buildDefaultEntitlements(classification, null, nowIso);
  return {
    orgId,
    profile: normalized,
    classification,
    approvedConfig: {
      defaultSlaHours: classification.recommendedConfig.defaultSlaHours,
      autoApproveLimitMinor: classification.recommendedConfig.autoApproveLimitMinor,
      escalationThresholdMinutes: classification.recommendedConfig.escalationThresholdMinutes,
      enabledDepartments: classification.recommendedConfig.recommendedDepartments,
      multiBranchEnabled: classification.recommendedConfig.multiBranchEnabled,
      customsWorkflowEnabled: classification.recommendedConfig.customsWorkflowEnabled,
      clientPortalReportingEnabled: classification.recommendedConfig.clientPortalReportingEnabled,
      status: "DRAFT",
    },
    entitlements,
    growthHistory: [],
    approvedBy: null,
    approvedAt: null,
    updatedAt: nowIso,
  };
}
