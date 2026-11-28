import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "./auth";
import {
  WORKSPACE_DEPARTMENTS,
  type WorkspaceDepartment,
} from "./departments";

export { WORKSPACE_DEPARTMENTS, type WorkspaceDepartment };

const DEPARTMENT_SET = new Set<string>(WORKSPACE_DEPARTMENTS);

export interface TenantContext {
  orgId: string;
  orgName: string;
  userId: string;
  email: string;
  role: Role;
  departments: WorkspaceDepartment[];
  branchCodes: string[];
}

export function normalizeDepartments(raw: unknown): WorkspaceDepartment[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<WorkspaceDepartment>();
  for (const item of raw) {
    const upper = String(item ?? "").trim().toUpperCase();
    if (DEPARTMENT_SET.has(upper)) {
      unique.add(upper as WorkspaceDepartment);
    }
  }
  return Array.from(unique);
}

export function normalizeBranchCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<string>();
  for (const item of raw) {
    const code = String(item ?? "").trim().toUpperCase();
    if (code && /^[A-Z0-9._-]{1,32}$/.test(code)) {
      unique.add(code);
    }
  }
  return Array.from(unique);
}

/**
 * Checks whether a user may access a given department.
 * - Workspace ADMINs always have full access.
 * - Non-admin members with an empty `departments` list have standard role-wide access.
 * - Non-admin members with explicit `departments` assigned are strictly scoped to those departments.
 */
export function hasDepartmentAccess(
  user: { role: Role; departments?: readonly string[] },
  department: WorkspaceDepartment,
): boolean {
  if (user.role === "ADMIN") return true;
  const assigned = user.departments ?? [];
  if (assigned.length === 0) return true;
  return assigned.includes(department);
}

/**
 * Checks whether a user may access a specific branch / warehouse code.
 * - Workspace ADMINs always have full workspace access.
 * - Non-admin members with an empty `branchCodes` list have workspace-wide branch access.
 * - Non-admin members with explicit `branchCodes` assigned may only access matching branches.
 */
export function hasBranchAccess(
  user: { role: Role; branchCodes?: readonly string[] },
  branchCode: string | null | undefined,
): boolean {
  if (user.role === "ADMIN") return true;
  const assigned = user.branchCodes ?? [];
  if (assigned.length === 0) return true;
  if (!branchCode) return false;
  return assigned.includes(branchCode.trim().toUpperCase());
}

/**
 * Maps every Control Tower AI agent ID to its governing enterprise department.
 */
export function departmentForAgent(agentId: string): WorkspaceDepartment {
  switch (agentId) {
    case "fleet-management":
    case "route-optimization":
      return "FLEET";
    case "warehouse-coordination":
      return "WAREHOUSE";
    case "carrier-management":
      return "FREIGHT";
    case "order-management":
      return "ORDERS";
    case "shipment-management":
    case "shipment-tracking":
    case "exception-resolution":
    case "human-escalation":
    case "workflow-automation":
      return "SHIPMENTS";
    case "financial-management":
      return "FINANCE";
    case "logistics-analytics":
      return "ANALYTICS";
    case "ai-customer-support":
    case "customer-communication":
      return "SUPPORT";
    case "orchestrator":
    default:
      return "SHIPMENTS";
  }
}

/**
 * Asserts that an operation has an explicit, non-empty verified tenant orgId.
 * Fails closed instead of allowing null/blank org context to touch operational data.
 */
export function assertVerifiedOrgId(
  orgId: string | null | undefined,
  operation = "operation",
): string {
  const clean = typeof orgId === "string" ? orgId.trim() : "";
  if (!clean) {
    throw new Error(`Missing verified workspace context for ${operation}.`);
  }
  return clean;
}

export interface WorkspaceTamperingRequestLike {
  headers?: { get(name: string): string | null };
  nextUrl?: { searchParams?: URLSearchParams };
  url?: string;
}

/**
 * Detects client-side workspace/tenant parameter tampering.
 * Supports two call forms:
 *   1. `detectWorkspaceTampering(verifiedOrgId, [candidate1, candidate2, ...])`
 *   2. `detectWorkspaceTampering(req, verifiedOrgId, body?)`
 *
 * If a caller supplies orgId / workspaceId / tenantId in a request header, query string,
 * or JSON body that does NOT match their server-verified session orgId, returns an error
 * message so the route can immediately reject the attempt with HTTP 403.
 */
export function detectWorkspaceTampering(
  verifiedOrgId: string,
  candidates: Array<unknown>,
): string | null;
export function detectWorkspaceTampering(
  req: WorkspaceTamperingRequestLike,
  verifiedOrgId: string,
  body?: unknown,
): string | null;
export function detectWorkspaceTampering(
  first: string | WorkspaceTamperingRequestLike,
  second: Array<unknown> | string,
  body?: unknown,
): string | null {
  let verifiedOrgId: string;
  let candidates: Array<unknown>;

  if (typeof first === "string") {
    verifiedOrgId = first;
    candidates = Array.isArray(second) ? second : [];
  } else {
    const req = first;
    verifiedOrgId = typeof second === "string" ? second : "";
    candidates = [];

    if (req?.headers) {
      candidates.push(
        req.headers.get("x-workspace-id"),
        req.headers.get("x-org-id"),
        req.headers.get("x-tenant-id"),
      );
    }

    let searchParams = req?.nextUrl?.searchParams;
    if (!searchParams && req?.url) {
      try {
        searchParams = new URL(req.url).searchParams;
      } catch {
        // ignore malformed URL
      }
    }
    if (searchParams) {
      candidates.push(
        searchParams.get("workspaceId"),
        searchParams.get("workspace_id"),
        searchParams.get("orgId"),
        searchParams.get("org_id"),
        searchParams.get("tenantId"),
        searchParams.get("tenant_id"),
      );
    }

    if (body && typeof body === "object") {
      const rec = body as Record<string, unknown>;
      candidates.push(
        rec.workspaceId,
        rec.workspace_id,
        rec.orgId,
        rec.org_id,
        rec.tenantId,
        rec.tenant_id,
      );
    }
  }

  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const supplied = String(raw).trim();
    if (!supplied) continue;
    if (supplied !== verifiedOrgId) {
      return "Cross-workspace access denied. Requests are strictly bound to your authenticated workspace.";
    }
  }
  return null;
}

/**
 * Verifies Meta/WhatsApp X-Hub-Signature-256 HMAC-SHA256 against raw unparsed request bytes
 * using constant-time comparison.
 */
export function verifyWhatsAppHmacSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null,
  appSecret: string | null | undefined,
): boolean {
  const secret = appSecret?.trim();
  if (!secret || !signatureHeader) return false;
  const trimmed = signatureHeader.trim();
  if (!trimmed.startsWith("sha256=")) return false;
  const providedHex = trimmed.slice("sha256=".length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(providedHex)) return false;

  const expectedHex = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(providedHex, "hex"),
      Buffer.from(expectedHex, "hex"),
    );
  } catch {
    return false;
  }
}

/**
 * Constant-time string comparison for webhook secret tokens.
 */
export function constantTimeTokenEqual(
  expected: string | null | undefined,
  provided: string | null | undefined,
): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Per-tenant in-memory sliding-window rate limiter to protect AI agent execution
 * and webhook endpoints from noisy-neighbor exhaustion.
 */
const globalForGuard = globalThis as unknown as {
  tenantRateBuckets?: Map<string, number[]>;
  webhookReplayCache?: Map<string, number>;
};

const rateBuckets =
  globalForGuard.tenantRateBuckets ??
  (globalForGuard.tenantRateBuckets = new Map<string, number[]>());

const replayCache =
  globalForGuard.webhookReplayCache ??
  (globalForGuard.webhookReplayCache = new Map<string, number>());

export function checkTenantRateLimit(
  orgId: string,
  bucket: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; remaining: number; retryAfterSec: number } {
  const key = `${orgId}:${bucket}`;
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (rateBuckets.get(key) ?? []).filter((ts) => ts > cutoff);

  if (hits.length >= maxRequests) {
    const oldest = hits[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    rateBuckets.set(key, hits);
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  hits.push(now);
  rateBuckets.set(key, hits);
  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - hits.length),
    retryAfterSec: 0,
  };
}

/**
 * Tenant-scoped webhook replay guard (in-memory fast path backed by DB table when available).
 * Returns true if this delivery is new and should be processed, false if duplicate/replayed.
 */
export function claimWebhookDeliveryMemory(
  orgId: string,
  channel: string,
  deliveryId: string,
  ttlMs = 7 * 24 * 60 * 60 * 1000,
): boolean {
  const cleanId = deliveryId.trim();
  if (!cleanId) return true;
  const now = Date.now();
  const key = `${orgId}:${channel}:${cleanId}`;
  const expiresAt = replayCache.get(key);
  if (expiresAt && expiresAt > now) {
    return false;
  }
  replayCache.set(key, now + ttlMs);
  if (replayCache.size > 5000) {
    for (const [k, exp] of replayCache.entries()) {
      if (exp <= now) replayCache.delete(k);
    }
  }
  return true;
}

/**
 * Filters an operational record list by a member's assigned branch/warehouse codes.
 * Workspace ADMINs and unscoped members receive the full tenant-isolated list.
 */
export function filterByBranchScope<T>(
  items: T[],
  user: { role?: Role | string; branchCodes?: readonly string[] },
  extractCodes: (item: T) => Array<string | null | undefined>,
): T[] {
  if (user.role === "ADMIN") return items;
  const assigned = user.branchCodes ?? [];
  if (assigned.length === 0) return items;
  const allowed = new Set(assigned.map((c) => c.trim().toUpperCase()));
  return items.filter((item) => {
    const codes = extractCodes(item)
      .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      .map((c) => c.trim().toUpperCase());
    if (codes.length === 0) return false;
    return codes.some((c) => allowed.has(c));
  });
}
