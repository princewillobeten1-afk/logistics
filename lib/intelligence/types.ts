import type { Role } from "@/lib/auth";

export type DataProvenance = "VERIFIED" | "ESTIMATE" | "PREDICTION";

export type BiPeriodDays = 7 | 14 | 30;

export type BiDepartmentId =
  | "finance"
  | "operations"
  | "fleet"
  | "shipments"
  | "dispatch"
  | "warehousing"
  | "sales"
  | "customers"
  | "hr";

export type AlertSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "OPPORTUNITY";

export type AlertCategory =
  | "COST_ANOMALY"
  | "REVENUE_DECLINE"
  | "SHIPMENT_DELAY"
  | "BRANCH_PERFORMANCE"
  | "FLEET_EFFICIENCY"
  | "COMPLIANCE_HR"
  | "GROWTH_OPPORTUNITY";

export type DepartmentStatus = "HEALTHY" | "WATCH" | "CRITICAL" | "NO_DATA";

export interface BiAccessPolicy {
  role: Role;
  scopeLabel: string;
  canViewDetailedFinance: boolean;
  canViewHrCompliancePii: boolean;
  canAcknowledgeAlerts: boolean;
  canRunAiQueries: boolean;
  allowedDepartments: BiDepartmentId[];
  redactionNotes: string[];
}

export interface ExecutiveKpi {
  id: string;
  label: string;
  valueFormatted: string;
  numericValue: number;
  unit: string;
  priorValueFormatted: string | null;
  deltaPct: number | null;
  /** Whether a higher numeric value is operationally better (e.g. true for revenue/SLA, false for cost/delays). */
  higherIsBetter: boolean;
  provenance: DataProvenance;
  formula: string;
  department: BiDepartmentId;
  redacted?: boolean;
}

export interface DepartmentMetric {
  label: string;
  value: string;
  provenance: DataProvenance;
}

export interface DepartmentScorecard {
  id: BiDepartmentId;
  name: string;
  status: DepartmentStatus;
  healthScore: number; // 0-100 deterministic composite
  headlineLabel: string;
  headlineValue: string;
  deltaPct: number | null;
  higherIsBetter: boolean;
  provenance: DataProvenance;
  formula: string;
  metrics: DepartmentMetric[];
  alertCount: number;
  summary: string;
  deepLink: string;
  redacted?: boolean;
}

export interface ProactiveAlert {
  id: string;
  severity: AlertSeverity;
  category: AlertCategory;
  department: BiDepartmentId;
  departmentName: string;
  title: string;
  summary: string;
  observedValue: string;
  baselineValue: string;
  deltaPct: number | null;
  estimatedImpact: string;
  provenance: DataProvenance;
  formula: string;
  recommendedAction: string;
  deepLink: string;
  acknowledged: boolean;
  detectedAt: string;
}

export interface ComparisonRow {
  id: string;
  name: string;
  subtitle?: string;
  status: DepartmentStatus;
  primaryMetricLabel: string;
  primaryMetricValue: number;
  primaryMetricFormatted: string;
  secondaryMetricLabel: string;
  secondaryMetricValue: number;
  secondaryMetricFormatted: string;
  efficiencyLabel: string;
  efficiencyFormatted: string;
  riskLabel: string;
  riskCount: number;
  deltaPct: number | null;
  provenance: DataProvenance;
  deepLink?: string;
}

export interface BiComparisonSuite {
  departments: ComparisonRow[];
  branches: ComparisonRow[];
  vehicles: ComparisonRow[];
  routes: ComparisonRow[];
  customers: ComparisonRow[];
}

export interface TrendForecastPoint {
  dateIso: string;
  label: string;
  isForecast: boolean;
  provenance: DataProvenance;
  shipments: number;
  shipmentsLower?: number;
  shipmentsUpper?: number;
  freightSpendMajor: number;
  freightSpendLower?: number;
  freightSpendUpper?: number;
  co2eKg: number;
  co2eLower?: number;
  co2eUpper?: number;
  costPerShipmentMajor: number;
}

export interface ForecastSummary {
  horizonDays: number;
  projectedShipments: number;
  projectedShipmentsRange: [number, number];
  projectedSpendMajor: number;
  projectedSpendRange: [number, number];
  projectedCo2eKg: number;
  shipmentSlopePerDay: number;
  confidenceLevel: "HIGH" | "MODERATE" | "LOW";
  methodology: string;
}

export interface Forecast30dPoint {
  dateIso: string;
  label: string;
  dayIndex: number;
  isForecast: boolean;
  provenance: DataProvenance;
  /** Verified historical daily shipments (null on future forecast days so Recharts splits solid vs dashed cleanly). */
  actualShipments: number | null;
  /** Projected daily shipments (populated on forecast days + bridge point on Today). */
  projectedShipments: number | null;
  shipmentsLower: number | null;
  shipmentsUpper: number | null;
  /** Helper band [lower, upper] for Recharts stacked/range confidence visualization. */
  shipmentsBandBase: number | null;
  shipmentsBandSpan: number | null;
  /** Verified historical daily carrier cost in major currency units. */
  actualCarrierCostMajor: number | null;
  /** Projected daily carrier cost requirement in major currency units. */
  projectedCarrierCostMajor: number | null;
  carrierCostLower: number | null;
  carrierCostUpper: number | null;
  carrierCostBandBase: number | null;
  carrierCostBandSpan: number | null;
  /** Cumulative projected carrier spend from Day +1 onward. */
  cumulativeProjectedCostMajor: number | null;
}

export interface Forecast30dWeeklyBucket {
  weekLabel: string;
  dateRangeLabel: string;
  projectedShipments: number;
  shipmentsLower: number;
  shipmentsUpper: number;
  projectedCarrierCostMajor: number;
  carrierCostLower: number;
  carrierCostUpper: number;
  provenance: DataProvenance;
}

export interface Forecast30dModeProjection {
  mode: string;
  sharePct: number;
  projectedShipments: number;
  projectedCarrierCostMajor: number;
  avgCostPerShipmentMajor: number;
  provenance: DataProvenance;
}

export interface PredictiveForecast30d {
  horizonDays: 30;
  historicalDaysUsed: number;
  todayLabel: string;
  totalProjectedShipments: number;
  projectedShipmentsRange: [number, number];
  totalProjectedCarrierCostMajor: number;
  projectedCarrierCostRange: [number, number];
  projectedAvgCostPerShipmentMajor: number;
  dailyShipmentSlope: number;
  dailyCostSlopeMajor: number;
  peakDayLabel: string;
  peakDayShipments: number;
  peakDayCarrierCostMajor: number;
  confidenceLevel: "HIGH" | "MODERATE" | "LOW";
  methodology: string;
  carrierCostRedacted?: boolean;
  dailySeries: Forecast30dPoint[];
  weeklyRollup: Forecast30dWeeklyBucket[];
  modeAllocation: Forecast30dModeProjection[];
}

export interface MethodologyNote {
  provenance: DataProvenance;
  title: string;
  description: string;
}

export interface BiSnapshot {
  orgName: string;
  roleScope: BiAccessPolicy;
  periodDays: BiPeriodDays;
  periodLabel: string;
  comparisonLabel: string;
  generatedAt: string;
  currency: string;
  recordCounts: {
    shipments: number;
    orders: number;
    vehicles: number;
    drivers: number;
    warehouses: number;
    customers: number;
    openExceptions: number;
  };
  executiveKpis: ExecutiveKpi[];
  departments: DepartmentScorecard[];
  proactiveAlerts: ProactiveAlert[];
  comparisons: BiComparisonSuite;
  trendWithForecast: TrendForecastPoint[];
  forecastSummary: ForecastSummary;
  forecast30d: PredictiveForecast30d;
  methodologyNotes: MethodologyNote[];
}

export interface BiChartSpec {
  type: "bar" | "line" | "horizontal_bar";
  title: string;
  unit: string;
  provenance: DataProvenance;
  points: {
    label: string;
    value: number;
    secondaryValue?: number;
    secondaryLabel?: string;
  }[];
}

export interface BiTableSpec {
  title: string;
  columns: string[];
  rows: string[][];
  provenance: DataProvenance;
}

export interface BiRecommendation {
  priority: "P1" | "P2" | "P3";
  department: BiDepartmentId;
  action: string;
  expectedImpact: string;
  provenance: DataProvenance;
  deepLink?: string;
}

export interface BiQueryResponse {
  question: string;
  answeredBy: "GEMINI_AI" | "DETERMINISTIC_ENGINE";
  modelUsed?: string;
  latencyMs?: number;
  generatedAt: string;
  summary: string;
  explanation: string;
  provenanceTags: DataProvenance[];
  formulasUsed: string[];
  chart?: BiChartSpec | null;
  table?: BiTableSpec | null;
  recommendations: BiRecommendation[];
  followUpQuestions: string[];
  accessNote?: string | null;
}
