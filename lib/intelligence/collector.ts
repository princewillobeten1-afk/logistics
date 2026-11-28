import type { Role } from "@/lib/auth";
import { query, runWithOrgScope } from "@/lib/db";
import { buildBiSnapshot, type BiLegInput, type BiQuoteInput } from "@/lib/intelligence/engine";
import type { BiPeriodDays, BiSnapshot } from "@/lib/intelligence/types";
import {
  activePolicy,
  auditLogs,
  deadWork,
  listCommunications,
  listConveyances,
  listCustomers,
  listCustoms,
  listDocuments,
  listDrivers,
  listInventory,
  listOrders,
  listShipments,
  listWarehouses,
  openApprovals,
  openExceptions,
  queueStats,
} from "@/lib/queries";
import {
  assertVerifiedOrgId,
  filterByBranchScope,
} from "@/lib/tenant-guard";

export function parseBiPeriod(raw: string | number | null | undefined): BiPeriodDays {
  const n = Number(raw);
  if (n === 14) return 14;
  if (n === 30) return 30;
  return 7;
}

/**
 * Reconstructs currently acknowledged proactive alert IDs from tenant audit logs.
 * Works identically in both PostgreSQL and local-store fallback mode without requiring schema changes.
 */
function resolveAcknowledgedAlerts(
  logs: { action: string; entity_type: string | null }[],
): Set<string> {
  const decided = new Map<string, boolean>();
  // Logs are ordered newest-first; the most recent action per alert wins.
  for (const row of logs) {
    if (!row.entity_type || !row.entity_type.startsWith("bi_alert:")) continue;
    const alertId = row.entity_type.slice("bi_alert:".length);
    if (!alertId || decided.has(alertId)) continue;
    if (row.action === "BI_ALERT_ACKNOWLEDGED") {
      decided.set(alertId, true);
    } else if (row.action === "BI_ALERT_REOPENED") {
      decided.set(alertId, false);
    }
  }
  const acked = new Set<string>();
  for (const [id, isAcked] of decided.entries()) {
    if (isAcked) acked.add(id);
  }
  return acked;
}

/**
 * Collects live, tenant-scoped operational & financial records across all 9 departments
 * and runs the deterministic BI engine with strict role-based redaction.
 */
export async function collectBiSnapshot({
  orgId,
  orgName,
  role,
  periodDays = 7,
  branchCodes = [],
}: {
  orgId: string;
  orgName: string;
  role: Role;
  periodDays?: BiPeriodDays;
  branchCodes?: string[];
}): Promise<BiSnapshot> {
  const verifiedOrgId = assertVerifiedOrgId(orgId, "collectBiSnapshot");
  const scopeUser = { role, branchCodes };
  return runWithOrgScope(verifiedOrgId, async () => {
    const [
      rawShipments,
      legs,
      quotes,
      rawWarehouses,
      rawInventory,
      conveyances,
      drivers,
      orders,
      customers,
      exceptions,
      approvals,
      communications,
      documents,
      customs,
      queueCounts,
      deadItems,
      policy,
      logs,
    ] = await Promise.all([
      listShipments(),
      query<BiLegInput>(
        `SELECT shipment_id, sequence, mode, state, distance_km, cost_minor, currency, co2e_kg
           FROM shipment_legs
          ORDER BY sequence`,
      ),
      query<BiQuoteInput>(
        `SELECT q.id, q.shipment_id, q.state, q.amount_minor, q.currency, c.name AS carrier_name
           FROM quotes q
           LEFT JOIN carriers c ON c.id = q.carrier_id`,
      ),
      listWarehouses(),
      listInventory(),
      listConveyances(),
      listDrivers(),
      listOrders(),
      listCustomers(),
      openExceptions(),
      openApprovals(),
      listCommunications(),
      listDocuments(),
      listCustoms(),
      queueStats(),
      deadWork(),
      activePolicy(),
      auditLogs(150),
    ]);

    const shipments = filterByBranchScope(rawShipments, scopeUser, (s) => [
      typeof s.origin?.city === "string" ? s.origin.city : null,
      typeof s.destination?.city === "string" ? s.destination.city : null,
    ]);
    const warehouses = filterByBranchScope(rawWarehouses, scopeUser, (w) => [
      w.code,
      w.city,
    ]);
    const inventory = filterByBranchScope(rawInventory, scopeUser, (inv) => [
      inv.warehouse,
    ]);

    const policyRules = (policy?.rules ?? {}) as Record<string, unknown>;
    const spendCeilingMinor =
      typeof policyRules.spend_ceiling_minor === "number"
        ? policyRules.spend_ceiling_minor
        : typeof policyRules.max_auto_approve_minor === "number"
          ? policyRules.max_auto_approve_minor
          : null;

    const currency =
      quotes.find((q) => q.currency)?.currency ??
      approvals.find((a) => a.currency)?.currency ??
      orders.find((o) => o.currency)?.currency ??
      "USD";

    const acknowledgedAlertIds = resolveAcknowledgedAlerts(logs);

    return buildBiSnapshot(
      {
        orgName,
        currency,
        shipments,
        legs,
        quotes,
        warehouses,
        inventory,
        conveyances,
        drivers,
        orders,
        customers,
        exceptions,
        approvals,
        communications,
        documents,
        customs,
        queueCounts,
        deadWorkCount: deadItems.length,
        spendCeilingMinor,
      },
      {
        periodDays,
        role,
        acknowledgedAlertIds,
      },
    );
  });
}
