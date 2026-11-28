/**
 * Enterprise departments across Control Tower.
 * Pure client- and server-safe constants (no Node.js built-ins).
 */
export const WORKSPACE_DEPARTMENTS = [
  "FLEET",
  "WAREHOUSE",
  "FREIGHT",
  "ORDERS",
  "SHIPMENTS",
  "FINANCE",
  "HR",
  "CUSTOMERS",
  "PROCUREMENT",
  "COMPLIANCE",
  "CUSTOMS",
  "BI",
  "ANALYTICS",
  "SUPPORT",
] as const;

export type WorkspaceDepartment = (typeof WORKSPACE_DEPARTMENTS)[number];
