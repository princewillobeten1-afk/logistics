import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { query, runWithOrgScope } from "@/lib/db";
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
import { buildTacticsSnapshot } from "./engine";
import type {
  TacticsTenantMutations,
  TacticsWorkspaceSnapshot,
} from "./types";

const TACTICS_STORE_PATH = "/tmp/logistics-tactics-store.json";

type TacticsStoreMap = Record<string, TacticsTenantMutations>;

const globalForTactics = globalThis as unknown as {
  tacticsStore?: TacticsStoreMap;
  tacticsStoreMtimeMs?: number;
};

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

function readAllTacticsStore(): TacticsStoreMap {
  try {
    if (existsSync(TACTICS_STORE_PATH)) {
      const mtimeMs = statSync(TACTICS_STORE_PATH).mtimeMs;
      if (
        !globalForTactics.tacticsStore ||
        globalForTactics.tacticsStoreMtimeMs !== mtimeMs
      ) {
        const parsed = JSON.parse(
          readFileSync(TACTICS_STORE_PATH, "utf8"),
        ) as TacticsStoreMap;
        globalForTactics.tacticsStore =
          parsed && typeof parsed === "object" ? parsed : {};
        globalForTactics.tacticsStoreMtimeMs = mtimeMs;
      }
    }
  } catch {
    // Ignore parse/fs errors and fall back to memory store
  }
  if (!globalForTactics.tacticsStore) {
    globalForTactics.tacticsStore = {};
  }
  return globalForTactics.tacticsStore;
}

function writeAllTacticsStore(map: TacticsStoreMap): void {
  globalForTactics.tacticsStore = map;
  try {
    writeFileSync(TACTICS_STORE_PATH, JSON.stringify(map), "utf8");
    globalForTactics.tacticsStoreMtimeMs = statSync(TACTICS_STORE_PATH).mtimeMs;
  } catch {
    // Ignore read-only fs errors
  }
}

export function getTenantTacticsMutations(orgId: string): TacticsTenantMutations {
  const all = readAllTacticsStore();
  const existing = all[orgId];
  if (!existing) return createEmptyMutations();
  return {
    supplierSyncs: Array.isArray(existing.supplierSyncs)
      ? existing.supplierSyncs
      : [],
    initiatives: Array.isArray(existing.initiatives) ? existing.initiatives : [],
    barcodeScans: Array.isArray(existing.barcodeScans)
      ? existing.barcodeScans
      : [],
    crossDockSkuKeys: Array.isArray(existing.crossDockSkuKeys)
      ? existing.crossDockSkuKeys
      : [],
    postponementWarehouseCodes: Array.isArray(existing.postponementWarehouseCodes)
      ? existing.postponementWarehouseCodes
      : [],
    postponementOrders: Array.isArray(existing.postponementOrders)
      ? existing.postponementOrders
      : [],
    mixedShipments: Array.isArray(existing.mixedShipments)
      ? existing.mixedShipments
      : [],
    preArrivalFilings:
      existing.preArrivalFilings && typeof existing.preArrivalFilings === "object"
        ? existing.preArrivalFilings
        : {},
  };
}

export function updateTenantTacticsMutations(
  orgId: string,
  updater: (current: TacticsTenantMutations) => TacticsTenantMutations,
): TacticsTenantMutations {
  const all = readAllTacticsStore();
  const current = getTenantTacticsMutations(orgId);
  const next = updater(current);
  all[orgId] = next;
  writeAllTacticsStore(all);
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
    ]);

    const currency =
      legs.find((l) => l.currency)?.currency ||
      customers.find((c) => c.default_currency)?.default_currency ||
      "NGN";

    const mutations = getTenantTacticsMutations(orgId);

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
