import { query, queryAs, runWithOrgScope } from "@/lib/db";
import {
  listCarriers,
  listConveyances,
  listCustomers,
  listCustoms,
  listDocuments,
  listDrivers,
  listInventory,
  listShipments,
  listWarehouses,
} from "@/lib/queries";
import { assertVerifiedOrgId } from "@/lib/tenant-guard";
import { buildTacticsSnapshot } from "./engine";
import type {
  TacticsTenantMutations,
  TacticsWorkspaceSnapshot,
} from "./types";

export function createEmptyMutations(): TacticsTenantMutations {
  return {
    supplierSyncs: [],
    initiatives: [],
    barcodeScans: [],
    crossDockSkuKeys: [],
    postponementWarehouseCodes: [],
    postponementOrders: [],
    mixedShipments: [],
    preArrivalFilings: {},
  };
}

function normalizeMutations(
  raw: Partial<TacticsTenantMutations> | null | undefined,
): TacticsTenantMutations {
  if (!raw || typeof raw !== "object") return createEmptyMutations();
  return {
    supplierSyncs: Array.isArray(raw.supplierSyncs) ? raw.supplierSyncs : [],
    initiatives: Array.isArray(raw.initiatives) ? raw.initiatives : [],
    barcodeScans: Array.isArray(raw.barcodeScans) ? raw.barcodeScans : [],
    crossDockSkuKeys: Array.isArray(raw.crossDockSkuKeys)
      ? raw.crossDockSkuKeys
      : [],
    postponementWarehouseCodes: Array.isArray(raw.postponementWarehouseCodes)
      ? raw.postponementWarehouseCodes
      : [],
    postponementOrders: Array.isArray(raw.postponementOrders)
      ? raw.postponementOrders
      : [],
    mixedShipments: Array.isArray(raw.mixedShipments) ? raw.mixedShipments : [],
    preArrivalFilings:
      raw.preArrivalFilings && typeof raw.preArrivalFilings === "object"
        ? raw.preArrivalFilings
        : {},
  };
}

/**
 * Loads tenant-isolated tactics mutations from the RLS-protected `tactics_state`
 * table (or per-org bucket in local fallback mode). Never reads shared `/tmp` files.
 */
export async function getTenantTacticsMutations(
  orgId: string,
): Promise<TacticsTenantMutations> {
  assertVerifiedOrgId(orgId, "getTenantTacticsMutations");
  const rows = await queryAs<{ payload: Partial<TacticsTenantMutations> | string }>(
    orgId,
    `SELECT payload FROM tactics_state WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  if (rows.length === 0) return createEmptyMutations();
  const raw = rows[0].payload;
  if (typeof raw === "string") {
    try {
      return normalizeMutations(JSON.parse(raw) as Partial<TacticsTenantMutations>);
    } catch {
      return createEmptyMutations();
    }
  }
  return normalizeMutations(raw);
}

/**
 * Persists tenant-isolated tactics mutations into `tactics_state` under RLS.
 */
export async function updateTenantTacticsMutations(
  orgId: string,
  updater: (current: TacticsTenantMutations) => TacticsTenantMutations,
): Promise<TacticsTenantMutations> {
  assertVerifiedOrgId(orgId, "updateTenantTacticsMutations");
  const current = await getTenantTacticsMutations(orgId);
  const next = normalizeMutations(updater(current));
  await queryAs(
    orgId,
    `INSERT INTO tactics_state (payload, updated_at)
     VALUES ($1::jsonb, now())
     ON CONFLICT (org_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           updated_at = now()`,
    [JSON.stringify(next)],
  );
  return next;
}

/**
 * Collects live tenant records and builds the complete 7-Tactic Logistics Workspace snapshot.
 */
export async function collectTacticsSnapshot({
  orgId,
  orgName,
}: {
  orgId: string;
  orgName: string;
}): Promise<TacticsWorkspaceSnapshot> {
  assertVerifiedOrgId(orgId, "collectTacticsSnapshot");
  return runWithOrgScope(orgId, async () => {
    const [
      warehouses,
      inventory,
      carriers,
      customers,
      shipments,
      legs,
      conveyances,
      drivers,
      customs,
      documents,
      mutations,
    ] = await Promise.all([
      listWarehouses(),
      listInventory(),
      listCarriers(),
      listCustomers(),
      listShipments(),
      query<{
        shipment_id: string;
        mode: string;
        state: string;
        distance_km: string;
        cost_minor: string | null;
        currency?: string;
      }>(
        `SELECT shipment_id, mode, state, distance_km, cost_minor, currency
           FROM shipment_legs
          ORDER BY sequence`,
      ),
      listConveyances(),
      listDrivers(),
      listCustoms(),
      listDocuments(),
      getTenantTacticsMutations(orgId),
    ]);

    const currency =
      legs.find((l) => l.currency)?.currency ||
      customers.find((c) => c.default_currency)?.default_currency ||
      "NGN";

    return buildTacticsSnapshot({
      orgName,
      currency,
      warehouses,
      inventory,
      carriers,
      customers,
      shipments,
      legs,
      conveyances,
      drivers,
      customs,
      documents,
      mutations,
    });
  });
}
