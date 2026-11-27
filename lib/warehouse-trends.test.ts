import assert from "node:assert/strict";
import test from "node:test";
import { buildWarehouseInventoryTrend } from "./warehouse-trends";

test("buildWarehouseInventoryTrend builds 30-day UTC series anchored to live verified balances", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  const result = buildWarehouseInventoryTrend({
    inventory: [
      { warehouse: "WH-LOS", sku: "SKU-A", on_hand: 400, reserved: 180, available: 220 },
      { warehouse: "WH-ABJ", sku: "SKU-B", on_hand: 250, reserved: 95, available: 155 },
    ],
    shipments: [
      {
        id: "s1",
        reference: "SHP-1001",
        state: "ALLOCATED",
        cargo: { units: 40 },
        allocation: { warehouse_code: "WH-LOS" },
        created_at: "2026-11-24T09:00:00Z",
      },
      {
        id: "s2",
        reference: "SHP-1002",
        state: "DELIVERED",
        cargo: { units: 30 },
        allocation: { warehouse_code: "WH-ABJ" },
        created_at: "2026-11-18T10:00:00Z",
        updated_at: "2026-11-21T16:00:00Z",
      },
    ],
    now,
    days: 30,
  });

  assert.equal(result.series.length, 30);
  const last = result.series[result.series.length - 1];
  assert.equal(last.dateIso, "2026-11-27");
  assert.equal(last.isToday, true);
  assert.equal(last.onHand, 650);
  assert.equal(last.reserved, 275);
  assert.equal(last.available, 375);
  assert.equal(result.summary.hasInventoryData, true);
  assert.equal(result.summary.currentOnHand, 650);
  assert.equal(result.summary.currentReserved, 275);
  assert.equal(result.summary.totalShipmentsLinked, 2);

  for (const pt of result.series) {
    assert.ok(pt.onHand >= 0, "onHand must be non-negative");
    assert.ok(pt.reserved >= 0, "reserved must be non-negative");
    assert.ok(pt.reserved <= pt.onHand, "reserved must not exceed onHand");
    assert.equal(pt.available, pt.onHand - pt.reserved);
    assert.ok(pt.utilizationPct >= 0 && pt.utilizationPct <= 100);
  }
});

test("buildWarehouseInventoryTrend filters cleanly by individual warehouse code", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  const result = buildWarehouseInventoryTrend({
    inventory: [
      { warehouse: "WH-LOS", sku: "SKU-A", on_hand: 400, reserved: 180, available: 220 },
      { warehouse: "WH-ABJ", sku: "SKU-B", on_hand: 250, reserved: 95, available: 155 },
    ],
    shipments: [
      {
        id: "s1",
        reference: "SHP-1001",
        state: "IN_TRANSIT",
        cargo: { units: 40 },
        allocation: { warehouse_code: "WH-LOS" },
        created_at: "2026-11-25T10:00:00Z",
      },
      {
        id: "s2",
        reference: "SHP-1002",
        state: "IN_TRANSIT",
        cargo: { units: 25 },
        allocation: { warehouse_code: "WH-ABJ" },
        created_at: "2026-11-25T10:00:00Z",
      },
    ],
    warehouseCode: "WH-LOS",
    now,
    days: 30,
  });

  assert.equal(result.summary.warehouseCode, "WH-LOS");
  assert.equal(result.summary.currentOnHand, 400);
  assert.equal(result.summary.currentReserved, 180);
  assert.equal(result.summary.totalShipmentsLinked, 1);
  assert.equal(result.series[result.series.length - 1].onHand, 400);
  assert.equal(result.series[result.series.length - 1].reserved, 180);
});

test("buildWarehouseInventoryTrend handles empty inventory without NaN or errors", () => {
  const result = buildWarehouseInventoryTrend({
    inventory: [],
    shipments: [],
    now: new Date("2026-11-27T12:00:00Z"),
    days: 30,
  });

  assert.equal(result.series.length, 30);
  assert.equal(result.summary.hasInventoryData, false);
  assert.equal(result.summary.currentOnHand, 0);
  assert.equal(result.summary.currentReserved, 0);
  assert.equal(result.summary.currentUtilizationPct, 0);
  assert.ok(result.series.every((p) => p.onHand === 0 && p.reserved === 0));
});
