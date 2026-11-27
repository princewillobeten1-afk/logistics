import type { NextRequest } from "next/server";
import type { Role } from "@/lib/auth";
import type {
  BiAccessPolicy,
  BiDepartmentId,
  BiSnapshot,
} from "@/lib/intelligence/types";

const ALL_DEPARTMENTS: BiDepartmentId[] = [
  "finance",
  "operations",
  "fleet",
  "shipments",
  "dispatch",
  "warehousing",
  "sales",
  "customers",
  "hr",
];

const OPERATIONAL_DEPARTMENTS: BiDepartmentId[] = [
  "operations",
  "fleet",
  "shipments",
  "dispatch",
  "warehousing",
  "sales",
  "customers",
  "hr",
];

/**
 * Resolves strict RBAC policy for Business Intelligence access.
 * - ADMIN & APPROVER: Full 9-department visibility including executive financial margins, spend ceilings, HR compliance & alert actions.
 * - DISPATCHER: Full operational visibility + operational alert actions; executive finance margin detail and HR personal PII are redacted.
 * - VIEWER: Read-only KPI & operational visibility; sensitive financial margins, HR PII, and alert state mutations are restricted.
 */
export function getBiAccessPolicy(role: Role): BiAccessPolicy {
  switch (role) {
    case "ADMIN":
      return {
        role,
        scopeLabel: "Executive Full Access (All 9 Departments)",
        canViewDetailedFinance: true,
        canViewHrCompliancePii: true,
        canAcknowledgeAlerts: true,
        canRunAiQueries: true,
        allowedDepartments: [...ALL_DEPARTMENTS],
        redactionNotes: [],
      };
    case "APPROVER":
      return {
        role,
        scopeLabel: "Finance & Executive Approver (All 9 Departments)",
        canViewDetailedFinance: true,
        canViewHrCompliancePii: true,
        canAcknowledgeAlerts: true,
        canRunAiQueries: true,
        allowedDepartments: [...ALL_DEPARTMENTS],
        redactionNotes: [],
      };
    case "DISPATCHER":
      return {
        role,
        scopeLabel: "Operations & Dispatch Scope (Finance Margins Redacted)",
        canViewDetailedFinance: false,
        canViewHrCompliancePii: false,
        canAcknowledgeAlerts: true,
        canRunAiQueries: true,
        allowedDepartments: [...OPERATIONAL_DEPARTMENTS, "finance"],
        redactionNotes: [
          "Detailed executive margin ceilings and spend approval overrides are restricted to Approver/Admin roles.",
          "HR workforce analytics are aggregated without driver personal contact or licence identifiers.",
        ],
      };
    case "VIEWER":
    default:
      return {
        role: "VIEWER",
        scopeLabel: "Read-Only Executive Summary (Sensitive Fields Redacted)",
        canViewDetailedFinance: false,
        canViewHrCompliancePii: false,
        canAcknowledgeAlerts: false,
        canRunAiQueries: true,
        allowedDepartments: [...OPERATIONAL_DEPARTMENTS, "finance"],
        redactionNotes: [
          "Viewer role is read-only: proactive alert acknowledgements require Dispatcher, Approver, or Admin access.",
          "Detailed executive finance margins and HR driver compliance identifiers are redacted for Viewer sessions.",
        ],
      };
  }
}

/**
 * Applies role-based redaction to a computed BiSnapshot BEFORE sending to the browser or to Gemini.
 * Ensuring the AI prompt receives the redacted snapshot prevents cross-role data leakage.
 */
export function applyBiRoleRedaction(snapshot: BiSnapshot, role: Role): BiSnapshot {
  const policy = getBiAccessPolicy(role);
  if (policy.canViewDetailedFinance && policy.canViewHrCompliancePii) {
    return { ...snapshot, roleScope: policy };
  }

  const executiveKpis = snapshot.executiveKpis.map((kpi) => {
    if (!policy.canViewDetailedFinance && kpi.id === "gross_margin_est") {
      return {
        ...kpi,
        valueFormatted: "Restricted",
        numericValue: 0,
        priorValueFormatted: null,
        deltaPct: null,
        redacted: true,
        formula: "Visible to Approver and Admin roles only.",
      };
    }
    return kpi;
  });

  const departments = snapshot.departments.map((dept) => {
    if (!policy.canViewDetailedFinance && dept.id === "finance") {
      return {
        ...dept,
        headlineLabel: "Cost Variance Index",
        headlineValue:
          dept.deltaPct !== null
            ? `${dept.deltaPct >= 0 ? "+" : ""}${dept.deltaPct.toFixed(1)}% vs prior`
            : "Monitored",
        redacted: true,
        summary:
          "Aggregate operational cost direction is visible; unit margins and spend ceilings require Approver or Admin access.",
        metrics: dept.metrics.map((m) =>
          /margin|spend|ceiling|value|revenue/i.test(m.label)
            ? { ...m, value: "Restricted" }
            : m,
        ),
      };
    }
    if (!policy.canViewHrCompliancePii && dept.id === "hr") {
      return {
        ...dept,
        summary:
          "Aggregated workforce availability & HOS readiness (individual licence/contact identifiers hidden).",
      };
    }
    return dept;
  });

  const proactiveAlerts = snapshot.proactiveAlerts.map((alert) => {
    if (!policy.canViewDetailedFinance && alert.department === "finance") {
      return {
        ...alert,
        estimatedImpact: "Finance impact restricted (Approver/Admin)",
      };
    }
    return alert;
  });

  const comparisons = {
    ...snapshot.comparisons,
    departments: snapshot.comparisons.departments.map((row) =>
      !policy.canViewDetailedFinance && row.id === "finance"
        ? {
            ...row,
            primaryMetricFormatted: "Restricted",
            secondaryMetricFormatted: "Restricted",
          }
        : row,
    ),
    customers: snapshot.comparisons.customers.map((row) =>
      !policy.canViewDetailedFinance
        ? {
            ...row,
            secondaryMetricFormatted: "Restricted",
          }
        : row,
    ),
  };

  const forecast30d = !policy.canViewDetailedFinance
    ? {
        ...snapshot.forecast30d,
        carrierCostRedacted: true,
        totalProjectedCarrierCostMajor: 0,
        projectedCarrierCostRange: [0, 0] as [number, number],
        projectedAvgCostPerShipmentMajor: 0,
        dailyCostSlopeMajor: 0,
        peakDayCarrierCostMajor: 0,
        dailySeries: snapshot.forecast30d.dailySeries.map((pt) => ({
          ...pt,
          actualCarrierCostMajor: null,
          projectedCarrierCostMajor: null,
          carrierCostLower: null,
          carrierCostUpper: null,
          carrierCostBandBase: null,
          carrierCostBandSpan: null,
          cumulativeProjectedCostMajor: null,
        })),
        weeklyRollup: snapshot.forecast30d.weeklyRollup.map((w) => ({
          ...w,
          projectedCarrierCostMajor: 0,
          carrierCostLower: 0,
          carrierCostUpper: 0,
        })),
        modeAllocation: snapshot.forecast30d.modeAllocation.map((m) => ({
          ...m,
          projectedCarrierCostMajor: 0,
          avgCostPerShipmentMajor: 0,
        })),
      }
    : snapshot.forecast30d;

  return {
    ...snapshot,
    roleScope: policy,
    executiveKpis,
    departments,
    proactiveAlerts,
    comparisons,
    forecast30d,
  };
}

/**
 * Validates that a dynamic internal link is strictly a relative app route.
 * Blocks javascript:, data:, protocol-relative //, or external origins.
 */
export function sanitizeInternalPath(path: string | null | undefined, fallback = "/intelligence"): string {
  if (!path || typeof path !== "string") return fallback;
  const trimmed = path.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) {
    return fallback;
  }
  return trimmed;
}

/**
 * Verifies same-origin for cookie-authenticated POST mutations (CSRF protection).
 */
export function isSameOriginMutation(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) {
    // Allow non-browser / same-origin fetch without Origin when X-Requested-With is set or referer matches
    const requestedWith = req.headers.get("x-requested-with");
    if (requestedWith === "XMLHttpRequest" || requestedWith === "ControlTowerBI") {
      return true;
    }
    const referer = req.headers.get("referer");
    if (!referer) return true;
    try {
      const refHost = new URL(referer).host.toLowerCase();
      const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").toLowerCase();
      return !host || refHost === host;
    } catch {
      return false;
    }
  }
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const expectedHost = (
      req.headers.get("x-forwarded-host") ??
      req.headers.get("host") ??
      ""
    ).toLowerCase();
    return Boolean(expectedHost) && originHost === expectedHost;
  } catch {
    return false;
  }
}
