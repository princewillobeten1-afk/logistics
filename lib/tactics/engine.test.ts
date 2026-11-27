import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTacticsSnapshot,
  computeInventoryAccuracyPct,
  computeSyncStatus,
  evaluateMixedShipmentLoad,
  evaluatePreArrivalCustoms,
  nextPdcaStage,
  nextPostponementStage,
  parseBarcodeToken,
} from "./engine";
import { createEmptyMutations } from "./store";

const NOW = new Date("2026-11-27T12:00:00Z");

describe("Logistics Strategy 7-Tactics Engine", () => {
  it("parses GS1-128 and SKU barcode payloads accurately", () => {
    const known = ["SKU-ELEC-01", "SKU-PHARMA-09"];
    assert.equal(
      parseBarcodeToken("(01)SKU-ELEC-01(10)LOT44", known).extractedSku,
      "SKU-ELEC-01",
    );
    assert.equal(
      parseBarcodeToken("GS1-SKU-PHARMA-09-WH1", known).extractedSku,
      "SKU-PHARMA-09",
    );
    assert.equal(
      parseBarcodeToken("(01)WIDGET-882(17)261231", []).extractedSku,
      "WIDGET-882",
    );
  });

  it("computes inventory accuracy from barcode scan variances", () => {
    const acc = computeInventoryAccuracyPct([
      {
        id: "1",
        barcode: "(01)SKU-A",
        sku: "SKU-A",
        warehouseCode: "WH-1",
        checkpoint: "RECEIVING",
        expectedQty: 100,
        scannedQty: 98,
        variance: -2,
        gpsLat: 6.5,
        gpsLon: 3.3,
        locationLabel: "Lagos Hub",
        scannedBy: "Op",
        scannedAt: NOW.toISOString(),
      },
      {
        id: "2",
        barcode: "(01)SKU-B",
        sku: "SKU-B",
        warehouseCode: "WH-1",
        checkpoint: "PICKING",
        expectedQty: 100,
        scannedQty: 100,
        variance: 0,
        gpsLat: 6.5,
        gpsLon: 3.3,
        locationLabel: "Lagos Hub",
        scannedBy: "Op",
        scannedAt: NOW.toISOString(),
      },
    ]);
    assert.equal(acc, 99);
  });

  it("evaluates mixed-SKU load capacity, consolidation count, and reefer/hazmat compatibility", () => {
    const good = evaluateMixedShipmentLoad(
      [
        { sku: "SKU-A", warehouseCode: "WH-1", quantity: 30, unitWeightKg: 10, unitVolumeCbm: 0.1 },
        { sku: "SKU-B", warehouseCode: "WH-1", quantity: 20, unitWeightKg: 15, unitVolumeCbm: 0.15 },
        { sku: "SKU-C", warehouseCode: "WH-1", quantity: 10, unitWeightKg: 5, unitVolumeCbm: 0.05 },
      ],
      "DRY_VAN_53",
    );
    assert.equal(good.compatible, true);
    assert.equal(good.totalUnits, 60);
    assert.equal(good.totalWeightKg, 650);
    assert.equal(good.consolidatedDeliveriesSaved, 2);

    const badReefer = evaluateMixedShipmentLoad(
      [
        {
          sku: "SKU-COLD",
          warehouseCode: "WH-1",
          quantity: 10,
          unitWeightKg: 12,
          unitVolumeCbm: 0.1,
          reefer: true,
        },
      ],
      "DRY_VAN_53",
    );
    assert.equal(badReefer.compatible, false);
    assert.ok(badReefer.warnings.some((w) => w.includes("Reefer")));
  });

  it("evaluates pre-arrival on-water and wheels-up customs readiness and savings", () => {
    const seaCleared = evaluatePreArrivalCustoms({
      mode: "SEA",
      hasCommercialInvoice: true,
      hasPackingList: true,
      hasWaybill: true,
      hsCodes: ["8471.30"],
      stage: "PRE_CLEARED_WHEELS_UP",
      currency: "USD",
    });
    assert.equal(seaCleared.readinessPct, 100);
    assert.equal(seaCleared.portHoursSaved, 36);
    assert.ok(seaCleared.avoidedDemurrageMajor > 0);

    const airUnfiled = evaluatePreArrivalCustoms({
      mode: "AIR",
      hasCommercialInvoice: true,
      hasPackingList: false,
      hasWaybill: true,
      hsCodes: [],
      stage: "NOT_FILED",
      currency: "USD",
    });
    assert.equal(airUnfiled.readinessPct, 50);
    assert.equal(airUnfiled.portHoursSaved, 0);
  });

  it("advances PDCA and postponement stages deterministically and detects overdue syncs", () => {
    assert.equal(nextPdcaStage("PLAN"), "DO");
    assert.equal(nextPdcaStage("DO"), "CHECK");
    assert.equal(nextPdcaStage("CHECK"), "ACT");
    assert.equal(nextPdcaStage("ACT"), "ACT");

    assert.equal(nextPostponementStage("BASE_STOCK_HELD"), "ORDER_COMMITTED");
    assert.equal(nextPostponementStage("ORDER_COMMITTED"), "ASSEMBLING");
    assert.equal(nextPostponementStage("ASSEMBLING"), "READY_TO_SHIP");

    assert.equal(
      computeSyncStatus("2026-11-25T12:00:00Z", NOW.getTime()),
      "OVERDUE",
    );
    assert.equal(
      computeSyncStatus("2026-12-05T12:00:00Z", NOW.getTime()),
      "ON_TRACK",
    );
  });

  it("builds a complete 7-tactic workspace snapshot and reflects cross-dock, postponement, and pre-arrival mutations", () => {
    const mutations = createEmptyMutations();
    mutations.crossDockSkuKeys.push("WH-LOS::SKU-01");
    mutations.postponementWarehouseCodes.push("WH-LOS");
    mutations.preArrivalFilings["SHP-SEA-1"] = {
      stage: "PRE_CLEARED_WHEELS_UP",
      filedAt: NOW.toISOString(),
      clearedAt: NOW.toISOString(),
    };

    const snap = buildTacticsSnapshot({
      orgName: "Meridian Freight",
      currency: "USD",
      now: NOW,
      warehouses: [
        {
          id: "w1",
          code: "WH-LOS",
          name: "Lagos Main Hub",
          city: "Lagos",
          country: "NG",
          dispatch_lead_hours: 4,
          handles_hazmat: true,
          handles_reefer: true,
          active: true,
          latitude: "6.5244",
          longitude: "3.3792",
        },
      ],
      inventory: [
        { warehouse: "WH-LOS", sku: "SKU-01", on_hand: 200, reserved: 40, available: 160 },
        { warehouse: "WH-LOS", sku: "SKU-02", on_hand: 120, reserved: 20, available: 100 },
      ],
      carriers: [
        {
          id: "c1",
          code: "MAERSK",
          name: "Maersk Line",
          modes: ["SEA", "ROAD"],
          on_time_rate: 0.91,
          damage_rate: 0.012,
          active: true,
        },
      ],
      customers: [{ id: "cu1", code: "ACME", name: "Acme Retail", active: true }],
      shipments: [
        {
          id: "s1",
          reference: "SHP-SEA-1",
          state: "IN_TRANSIT",
          origin: { city: "Rotterdam" },
          destination: { city: "Lagos" },
          cargo: { weight_kg: 4500 },
          deadline: new Date("2026-11-30T12:00:00Z"),
        },
      ],
      legs: [{ shipment_id: "s1", mode: "SEA", state: "IN_TRANSIT", distance_km: 5200 }],
      conveyances: [{ id: "v1", active: true, last_lat: "6.5", last_lon: "3.3" }],
      drivers: [{ id: "d1", active: true, current_lat: "6.5", current_lon: "3.3" }],
      customs: [
        {
          id: "cu-1",
          shipment_id: "s1",
          direction: "IMPORT",
          clearance_state: "SUBMITTED",
          hs_codes: ["8471.30"],
          broker: "Apex Brokers",
          submitted_at: NOW,
        },
      ],
      documents: [{ id: "doc1", shipment_id: "s1", kind: "COMMERCIAL_INVOICE" }],
      mutations,
    });

    assert.equal(snap.scorecards.length, 7);
    assert.equal(snap.inTransit.crossDockEnabledSkus, 1);
    assert.ok(snap.inTransit.inTransitUnits > 0);
    assert.ok(snap.inTransit.monthlyCarryingSavingsMajor > 0);
    assert.equal(snap.postponementCenters[0].enabled, true);
    assert.equal(snap.preArrivalFilings[0].stage, "PRE_CLEARED_WHEELS_UP");
    assert.equal(snap.totalPortHoursSaved, 36);
    assert.equal(snap.gpsTrackedAssetsCount, 2);
  });
});
