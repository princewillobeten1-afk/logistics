import { recordAudit } from "@/lib/audit";
import { queryAs } from "@/lib/db";
import { assertVerifiedOrgId } from "@/lib/tenant-guard";
import {
  applyEntitlementOverrides,
  applyGrowthReassessment,
  buildDefaultEntitlements,
  buildDefaultWorkspaceConfiguration,
  classifyBusinessProfile,
  evaluateGrowthReassessment,
  normalizeBusinessProfile,
} from "./classifier";
import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  type ApprovedOperationalConfig,
  type BusinessOperationalProfile,
  type FeatureEntitlementMap,
  type FeatureKey,
  type GrowthHistoryEntry,
  type GrowthReassessment,
  type ObservedWorkspaceMetrics,
  type WorkspaceConfigurationRecord,
} from "./types";

type RawConfigRow = {
  org_id: string;
  profile: Partial<BusinessOperationalProfile> | null;
  classification: WorkspaceConfigurationRecord["classification"] | null;
  approved_config: Partial<ApprovedOperationalConfig> | null;
  entitlements: Partial<FeatureEntitlementMap> | null;
  growth_history: GrowthHistoryEntry[] | null;
  approved_by: string | null;
  approved_at: Date | string | null;
  updated_at: Date | string | null;
};

export interface WorkspaceConfigurationBundle {
  configuration: WorkspaceConfigurationRecord;
  observedMetrics: ObservedWorkspaceMetrics;
  growthReassessment: GrowthReassessment;
}

export interface SaveWorkspaceConfigurationInput {
  profile?: Partial<BusinessOperationalProfile>;
  approvedConfig?: Partial<Omit<ApprovedOperationalConfig, "status">>;
  approve?: boolean;
  entitlementOverrides?: Partial<Record<FeatureKey, boolean>>;
  applyGrowthReassessment?: boolean;
  preserveAdminOverrides?: boolean;
  note?: string;
}

/**
 * Reads live workspace entity counts under verified tenant isolation so
 * business growth can automatically trigger reassessment without touching other tenants.
 */
export async function getObservedWorkspaceMetrics(
  orgId: string,
): Promise<ObservedWorkspaceMetrics> {
  const verifiedOrgId = assertVerifiedOrgId(orgId, "getObservedWorkspaceMetrics");
  const rows = await queryAs<{
    active_users: string;
    vehicles: string;
    warehouses: string;
    customers: string;
    carriers: string;
    shipments: string;
    orders: string;
  }>(
    verifiedOrgId,
    `/* workspace_observed_metrics */
     SELECT
       (SELECT count(*)::text FROM users WHERE org_id = app_current_org_id() AND active = true) AS active_users,
       (SELECT count(*)::text FROM conveyances WHERE active = true) AS vehicles,
       (SELECT count(*)::text FROM warehouses WHERE active = true) AS warehouses,
       (SELECT count(*)::text FROM customers WHERE active = true) AS customers,
       (SELECT count(*)::text FROM carriers WHERE active = true) AS carriers,
       (SELECT count(*)::text FROM shipments) AS shipments,
       (SELECT count(*)::text FROM orders) AS orders`,
    [],
  );
  const row = rows[0];
  return {
    activeUsers: Number(row?.active_users ?? 0),
    vehicles: Number(row?.vehicles ?? 0),
    warehouses: Number(row?.warehouses ?? 0),
    customers: Number(row?.customers ?? 0),
    carriers: Number(row?.carriers ?? 0),
    shipments: Number(row?.shipments ?? 0),
    orders: Number(row?.orders ?? 0),
  };
}

function hydrateConfigRow(
  orgId: string,
  row: RawConfigRow | undefined,
): WorkspaceConfigurationRecord {
  if (!row) {
    return buildDefaultWorkspaceConfiguration(orgId);
  }
  const profile = normalizeBusinessProfile(row.profile ?? undefined);
  const classification = classifyBusinessProfile(profile);
  const fallbackDefaults = buildDefaultEntitlements(classification);
  const entitlements = {} as FeatureEntitlementMap;
  for (const key of FEATURE_KEYS) {
    const saved = row.entitlements?.[key];
    entitlements[key] =
      saved && typeof saved.enabled === "boolean"
        ? {
            enabled: FEATURE_CATALOG[key].coreRequired ? true : saved.enabled,
            source: saved.source ?? "RECOMMENDED",
            updatedBy: saved.updatedBy ?? null,
            updatedAt: saved.updatedAt ?? new Date().toISOString(),
          }
        : fallbackDefaults[key];
  }

  const rawApproved = row.approved_config ?? {};
  const approvedConfig: ApprovedOperationalConfig = {
    defaultSlaHours:
      typeof rawApproved.defaultSlaHours === "number" && rawApproved.defaultSlaHours > 0
        ? rawApproved.defaultSlaHours
        : classification.recommendedConfig.defaultSlaHours,
    autoApproveLimitMinor:
      typeof rawApproved.autoApproveLimitMinor === "number" && rawApproved.autoApproveLimitMinor >= 0
        ? rawApproved.autoApproveLimitMinor
        : classification.recommendedConfig.autoApproveLimitMinor,
    escalationThresholdMinutes:
      typeof rawApproved.escalationThresholdMinutes === "number" && rawApproved.escalationThresholdMinutes > 0
        ? rawApproved.escalationThresholdMinutes
        : classification.recommendedConfig.escalationThresholdMinutes,
    enabledDepartments: Array.isArray(rawApproved.enabledDepartments) && rawApproved.enabledDepartments.length > 0
      ? rawApproved.enabledDepartments
      : classification.recommendedConfig.recommendedDepartments,
    multiBranchEnabled:
      typeof rawApproved.multiBranchEnabled === "boolean"
        ? rawApproved.multiBranchEnabled
        : classification.recommendedConfig.multiBranchEnabled,
    customsWorkflowEnabled:
      typeof rawApproved.customsWorkflowEnabled === "boolean"
        ? rawApproved.customsWorkflowEnabled
        : classification.recommendedConfig.customsWorkflowEnabled,
    clientPortalReportingEnabled:
      typeof rawApproved.clientPortalReportingEnabled === "boolean"
        ? rawApproved.clientPortalReportingEnabled
        : classification.recommendedConfig.clientPortalReportingEnabled,
    status: rawApproved.status === "APPROVED" ? "APPROVED" : "DRAFT",
  };

  return {
    orgId,
    profile,
    classification,
    approvedConfig,
    entitlements,
    growthHistory: Array.isArray(row.growth_history) ? row.growth_history : [],
    approvedBy: row.approved_by ?? null,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
  };
}

/**
 * Loads the workspace configuration alongside live observed operational metrics
 * and real-time growth reassessment diagnostics.
 */
export async function getWorkspaceConfiguration(
  orgId: string,
): Promise<WorkspaceConfigurationBundle> {
  const verifiedOrgId = assertVerifiedOrgId(orgId, "getWorkspaceConfiguration");
  const [rows, observedMetrics] = await Promise.all([
    queryAs<RawConfigRow>(
      verifiedOrgId,
      `SELECT org_id, profile, classification, approved_config, entitlements,
              growth_history, approved_by, approved_at, updated_at
         FROM workspace_configurations
        WHERE org_id = app_current_org_id()
        LIMIT 1`,
      [],
    ).catch(() => [] as RawConfigRow[]),
    getObservedWorkspaceMetrics(verifiedOrgId).catch(
      (): ObservedWorkspaceMetrics => ({
        activeUsers: 0,
        vehicles: 0,
        warehouses: 0,
        customers: 0,
        carriers: 0,
        shipments: 0,
        orders: 0,
      }),
    ),
  ]);

  const configuration = hydrateConfigRow(verifiedOrgId, rows[0]);
  const growthReassessment = evaluateGrowthReassessment(
    configuration.profile,
    observedMetrics,
  );

  return {
    configuration,
    observedMetrics,
    growthReassessment,
  };
}

/**
 * Persists admin updates to business profile, classification approval, independent
 * feature entitlements, or non-destructive growth reassessment.
 */
export async function saveWorkspaceConfiguration(
  orgId: string,
  actorEmail: string,
  input: SaveWorkspaceConfigurationInput,
): Promise<WorkspaceConfigurationBundle> {
  const verifiedOrgId = assertVerifiedOrgId(orgId, "saveWorkspaceConfiguration");
  const currentBundle = await getWorkspaceConfiguration(verifiedOrgId);
  const nowIso = new Date().toISOString();

  let nextRecord: WorkspaceConfigurationRecord = currentBundle.configuration;

  if (input.applyGrowthReassessment) {
    const targetProfile = input.profile
      ? normalizeBusinessProfile(input.profile, currentBundle.growthReassessment.recommendedProfile)
      : currentBundle.growthReassessment.recommendedProfile;

    nextRecord = applyGrowthReassessment(nextRecord, targetProfile, actorEmail, {
      preserveAdminOverrides: input.preserveAdminOverrides !== false,
      note: input.note,
      nowIso,
    });
  } else {
    const nextProfile = input.profile
      ? normalizeBusinessProfile(input.profile, nextRecord.profile)
      : nextRecord.profile;
    const nextClassification = classifyBusinessProfile(nextProfile);

    const tierChanged =
      nextClassification.tier !== nextRecord.classification.tier ||
      nextClassification.archetype !== nextRecord.classification.archetype;

    // Recompute recommended entitlements only for non-overridden features when profile changes
    let nextEntitlements = nextRecord.entitlements;
    if (input.profile) {
      const recommendedDefaults = buildDefaultEntitlements(
        nextClassification,
        actorEmail,
        nowIso,
      );
      const merged = {} as FeatureEntitlementMap;
      for (const key of FEATURE_KEYS) {
        if (nextRecord.entitlements[key]?.source === "ADMIN_OVERRIDE") {
          merged[key] = nextRecord.entitlements[key];
        } else {
          merged[key] = recommendedDefaults[key];
        }
      }
      nextEntitlements = merged;
    }

    if (input.entitlementOverrides) {
      nextEntitlements = applyEntitlementOverrides(
        nextEntitlements,
        input.entitlementOverrides,
        actorEmail,
        nowIso,
      );
    }

    const baseApproved = nextRecord.approvedConfig;
    const rec = nextClassification.recommendedConfig;
    const nextApproved: ApprovedOperationalConfig = {
      defaultSlaHours:
        typeof input.approvedConfig?.defaultSlaHours === "number" &&
        input.approvedConfig.defaultSlaHours >= 1 &&
        input.approvedConfig.defaultSlaHours <= 2400
          ? Math.round(input.approvedConfig.defaultSlaHours)
          : input.profile
            ? rec.defaultSlaHours
            : baseApproved.defaultSlaHours,
      autoApproveLimitMinor:
        typeof input.approvedConfig?.autoApproveLimitMinor === "number" &&
        input.approvedConfig.autoApproveLimitMinor >= 0
          ? Math.round(input.approvedConfig.autoApproveLimitMinor)
          : input.profile
            ? rec.autoApproveLimitMinor
            : baseApproved.autoApproveLimitMinor,
      escalationThresholdMinutes:
        typeof input.approvedConfig?.escalationThresholdMinutes === "number" &&
        input.approvedConfig.escalationThresholdMinutes >= 5 &&
        input.approvedConfig.escalationThresholdMinutes <= 10_080
          ? Math.round(input.approvedConfig.escalationThresholdMinutes)
          : input.profile
            ? rec.escalationThresholdMinutes
            : baseApproved.escalationThresholdMinutes,
      enabledDepartments:
        Array.isArray(input.approvedConfig?.enabledDepartments) &&
        input.approvedConfig.enabledDepartments.length > 0
          ? input.approvedConfig.enabledDepartments
          : input.profile
            ? rec.recommendedDepartments
            : baseApproved.enabledDepartments,
      multiBranchEnabled:
        typeof input.approvedConfig?.multiBranchEnabled === "boolean"
          ? input.approvedConfig.multiBranchEnabled
          : input.profile
            ? rec.multiBranchEnabled
            : baseApproved.multiBranchEnabled,
      customsWorkflowEnabled:
        typeof input.approvedConfig?.customsWorkflowEnabled === "boolean"
          ? input.approvedConfig.customsWorkflowEnabled
          : input.profile
            ? rec.customsWorkflowEnabled
            : baseApproved.customsWorkflowEnabled,
      clientPortalReportingEnabled:
        typeof input.approvedConfig?.clientPortalReportingEnabled === "boolean"
          ? input.approvedConfig.clientPortalReportingEnabled
          : input.profile
            ? rec.clientPortalReportingEnabled
            : baseApproved.clientPortalReportingEnabled,
      status: input.approve ? "APPROVED" : baseApproved.status,
    };

    const nextHistory = tierChanged
      ? [
          {
            timestamp: nowIso,
            actor: actorEmail,
            fromTier: nextRecord.classification.tier,
            toTier: nextClassification.tier,
            fromArchetype: nextRecord.classification.archetype,
            toArchetype: nextClassification.archetype,
            note:
              input.note ??
              `Business profile updated (${nextRecord.classification.tier} → ${nextClassification.tier}).`,
          },
          ...nextRecord.growthHistory,
        ].slice(0, 25)
      : nextRecord.growthHistory;

    nextRecord = {
      ...nextRecord,
      profile: nextProfile,
      classification: nextClassification,
      approvedConfig: nextApproved,
      entitlements: nextEntitlements,
      growthHistory: nextHistory,
      approvedBy: input.approve ? actorEmail : nextRecord.approvedBy,
      approvedAt: input.approve ? nowIso : nextRecord.approvedAt,
      updatedAt: nowIso,
    };
  }

  await queryAs(
    verifiedOrgId,
    `INSERT INTO workspace_configurations
       (org_id, profile, classification, approved_config, entitlements, growth_history, approved_by, approved_at, updated_at)
     VALUES
       (app_current_org_id(), $1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7::timestamptz, now())
     ON CONFLICT (org_id)
     DO UPDATE SET
       profile = EXCLUDED.profile,
       classification = EXCLUDED.classification,
       approved_config = EXCLUDED.approved_config,
       entitlements = EXCLUDED.entitlements,
       growth_history = EXCLUDED.growth_history,
       approved_by = EXCLUDED.approved_by,
       approved_at = EXCLUDED.approved_at,
       updated_at = now()`,
    [
      JSON.stringify(nextRecord.profile),
      JSON.stringify(nextRecord.classification),
      JSON.stringify(nextRecord.approvedConfig),
      JSON.stringify(nextRecord.entitlements),
      JSON.stringify(nextRecord.growthHistory),
      nextRecord.approvedBy,
      nextRecord.approvedAt,
    ],
  );

  await recordAudit({
    actor: actorEmail,
    orgId: verifiedOrgId,
    action: input.applyGrowthReassessment
      ? "WORKSPACE_GROWTH_REASSESSED"
      : "WORKSPACE_CONFIGURATION_UPDATED",
    entityType: "workspace_configuration",
    after: {
      tier: nextRecord.classification.tier,
      archetype: nextRecord.classification.archetype,
      complexityScore: nextRecord.classification.complexityScore,
      status: nextRecord.approvedConfig.status,
      enabledFeatures: FEATURE_KEYS.filter((k) => nextRecord.entitlements[k]?.enabled),
    },
  });

  const observedMetrics = await getObservedWorkspaceMetrics(verifiedOrgId).catch(
    () => currentBundle.observedMetrics,
  );
  const growthReassessment = evaluateGrowthReassessment(
    nextRecord.profile,
    observedMetrics,
  );

  return {
    configuration: nextRecord,
    observedMetrics,
    growthReassessment,
  };
}

/**
 * Returns optional nav hrefs explicitly disabled via workspace entitlements so the
 * sidebar adapts to admin-approved workspace configuration without hiding core tools.
 */
export async function getWorkspaceNavAdaptation(orgId: string): Promise<{
  disabledHrefs: string[];
  tierLabel: string | null;
}> {
  try {
    const rows = await queryAs<RawConfigRow>(
      orgId,
      `SELECT org_id, profile, classification, approved_config, entitlements,
              growth_history, approved_by, approved_at, updated_at
         FROM workspace_configurations
        WHERE org_id = app_current_org_id()
        LIMIT 1`,
      [],
    );
    if (!rows[0]) {
      return { disabledHrefs: [], tierLabel: null };
    }
    const config = hydrateConfigRow(orgId, rows[0]);
    const disabled = new Set<string>();
    for (const key of FEATURE_KEYS) {
      const def = FEATURE_CATALOG[key];
      if (def.coreRequired) continue;
      if (config.entitlements[key] && !config.entitlements[key].enabled) {
        for (const href of def.navHrefs) {
          disabled.add(href);
        }
      }
    }
    return {
      disabledHrefs: Array.from(disabled),
      tierLabel: `${config.classification.tier} · ${config.classification.archetype.replace(/_/g, " ")}`,
    };
  } catch {
    return { disabledHrefs: [], tierLabel: null };
  }
}
