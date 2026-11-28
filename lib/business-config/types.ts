import type { WorkspaceDepartment } from "@/lib/departments";

export type BusinessTier = "SMALL" | "MEDIUM" | "ENTERPRISE";

export type BusinessArchetype =
  | "COURIER"
  | "REGIONAL_LOGISTICS"
  | "ENTERPRISE_NETWORK"
  | "INTERNATIONAL_FREIGHT"
  | "THIRD_PARTY_LOGISTICS";

export type TransportMode = "ROAD" | "AIR" | "SEA" | "RAIL";

export const FEATURE_KEYS = [
  "CORE_OPERATIONS",
  "FLEET_DISPATCH",
  "WAREHOUSE_WMS",
  "INTERNATIONAL_CUSTOMS",
  "THIRD_PARTY_3PL",
  "AI_AUTONOMOUS_AGENTS",
  "AI_VOICE_COPILOT",
  "BUSINESS_INTELLIGENCE",
  "EXTERNAL_INTEGRATIONS",
  "TACTICS_OPTIMIZATION",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface FeatureDefinition {
  key: FeatureKey;
  label: string;
  description: string;
  coreRequired?: boolean;
  navHrefs: string[];
}

export const FEATURE_CATALOG: Record<FeatureKey, FeatureDefinition> = {
  CORE_OPERATIONS: {
    key: "CORE_OPERATIONS",
    label: "Core Operations & Tracking",
    description: "Orders, shipments, planning, exceptions, approvals, customers, and live map.",
    coreRequired: true,
    navHrefs: ["/", "/orders", "/shipments", "/planning", "/exceptions", "/approvals", "/map", "/customers"],
  },
  FLEET_DISPATCH: {
    key: "FLEET_DISPATCH",
    label: "Fleet & Driver Dispatch",
    description: "Vehicle capacity assignment, HOS compliance, driver telemetry, and dispatch control.",
    navHrefs: ["/fleet"],
  },
  WAREHOUSE_WMS: {
    key: "WAREHOUSE_WMS",
    label: "Warehouse & Inventory WMS",
    description: "Multi-warehouse inventory tracking, stock turns, cross-docking, and pick/pack instructions.",
    navHrefs: ["/warehouses"],
  },
  INTERNATIONAL_CUSTOMS: {
    key: "INTERNATIONAL_CUSTOMS",
    label: "International Freight & Customs",
    description: "Air/sea container routing, HS code clearance workflows, and export/import documentation.",
    navHrefs: ["/documents"],
  },
  THIRD_PARTY_3PL: {
    key: "THIRD_PARTY_3PL",
    label: "3PL Multi-Client Fulfillment",
    description: "Dedicated client account SLAs, shared warehouse stock segregation, and client reporting.",
    navHrefs: [],
  },
  AI_AUTONOMOUS_AGENTS: {
    key: "AI_AUTONOMOUS_AGENTS",
    label: "Autonomous AI Agent Orchestration",
    description: "Automated order intake, delay investigation, exception escalation, and carrier evaluation.",
    navHrefs: ["/activity", "/queue"],
  },
  AI_VOICE_COPILOT: {
    key: "AI_VOICE_COPILOT",
    label: "Voice Copilot & Live Briefings",
    description: "Real-time bidirectional voice operations assistant over authenticated WebSockets.",
    navHrefs: [],
  },
  BUSINESS_INTELLIGENCE: {
    key: "BUSINESS_INTELLIGENCE",
    label: "Business Intelligence & Executive Analytics",
    description: "Executive KPI comparisons, financial margin analysis, and predictive corridor intelligence.",
    navHrefs: ["/intelligence", "/analytics"],
  },
  EXTERNAL_INTEGRATIONS: {
    key: "EXTERNAL_INTEGRATIONS",
    label: "ERP / TMS / WMS Connectors & EDI",
    description: "SAP, NetSuite, Shopify, EDI X12, SQL sync, and bi-directional webhook ingestion.",
    navHrefs: ["/integrations", "/api-docs"],
  },
  TACTICS_OPTIMIZATION: {
    key: "TACTICS_OPTIMIZATION",
    label: "7-Tactics Logistics Optimization",
    description: "Barcode accuracy, mixed-SKU consolidation, pre-arrival customs, and postponement tracking.",
    navHrefs: ["/tactics"],
  },
};

export interface BusinessOperationalProfile {
  businessModel: BusinessArchetype;
  employeeCount: number;
  vehicleCount: number;
  warehouseCount: number;
  branchCount: number;
  monthlyShipments: number;
  customerCount: number;
  carrierCount: number;
  transportModes: TransportMode[];
  operatesInternationally: boolean;
  requiresCustomsClearance: boolean;
  managesThirdPartyClients: boolean;
}

export interface RecommendedOperationalConfig {
  defaultSlaHours: number;
  autoApproveLimitMinor: number;
  escalationThresholdMinutes: number;
  recommendedDepartments: WorkspaceDepartment[];
  recommendedFeatures: FeatureKey[];
  multiBranchEnabled: boolean;
  customsWorkflowEnabled: boolean;
  clientPortalReportingEnabled: boolean;
}

export interface BusinessClassificationResult {
  tier: BusinessTier;
  archetype: BusinessArchetype;
  complexityScore: number;
  complexityBand: "LOW" | "MODERATE" | "HIGH" | "VERY_HIGH";
  rationale: string[];
  recommendedConfig: RecommendedOperationalConfig;
}

export type EntitlementSource = "RECOMMENDED" | "ADMIN_OVERRIDE" | "PLAN";

export interface FeatureEntitlement {
  enabled: boolean;
  source: EntitlementSource;
  updatedBy: string | null;
  updatedAt: string;
}

export type FeatureEntitlementMap = Record<FeatureKey, FeatureEntitlement>;

export interface ApprovedOperationalConfig {
  defaultSlaHours: number;
  autoApproveLimitMinor: number;
  escalationThresholdMinutes: number;
  enabledDepartments: WorkspaceDepartment[];
  multiBranchEnabled: boolean;
  customsWorkflowEnabled: boolean;
  clientPortalReportingEnabled: boolean;
  status: "DRAFT" | "APPROVED";
}

export interface ObservedWorkspaceMetrics {
  activeUsers: number;
  vehicles: number;
  warehouses: number;
  customers: number;
  carriers: number;
  shipments: number;
  orders: number;
}

export interface GrowthReassessment {
  needsReassessment: boolean;
  currentTier: BusinessTier;
  projectedTier: BusinessTier;
  currentComplexityScore: number;
  projectedComplexityScore: number;
  reasons: string[];
  recommendedProfile: BusinessOperationalProfile;
  recommendedClassification: BusinessClassificationResult;
}

export interface GrowthHistoryEntry {
  timestamp: string;
  actor: string;
  fromTier: BusinessTier;
  toTier: BusinessTier;
  fromArchetype: BusinessArchetype;
  toArchetype: BusinessArchetype;
  note: string;
}

export interface WorkspaceConfigurationRecord {
  orgId: string;
  profile: BusinessOperationalProfile;
  classification: BusinessClassificationResult;
  approvedConfig: ApprovedOperationalConfig;
  entitlements: FeatureEntitlementMap;
  growthHistory: GrowthHistoryEntry[];
  approvedBy: string | null;
  approvedAt: string | null;
  updatedAt: string;
}
