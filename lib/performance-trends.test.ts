import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSevenDayPerformanceTrend,
  summarizeSevenDayPerformance,
} from "./performance-trends";

test("buildSevenDayPerformanceTrend aggregates daily shipments, CO2e emissions, and cost per shipment with leg/quote fallbacks", () => {
  const now = new Date("2026-11-26T15:30:00Z");

  const shipments = [
    // Today (Nov 26): uses plan fields directly
    {
      id: "s1",
      created_at: "2026-11-26T08:00:00Z",
      plan: { co2e_kg: 120.5, estimated_cost_minor: 500000 },
    },
    // Today (Nov 26): falls back to legs for both CO2e and cost
    {
      id: "s2",
      created_at: "2026-11-26T11:00:00Z",
      plan: {},
    },
    // 2 days ago (Nov 24): falls back to selected quote for cost, leg for CO2e
    {
      id: "s3",
      created_at: "2026-11-24T09:15:00Z",
      plan: null,
    },
    // Outside 7-day window (Nov 10): must be excluded
    {
      id: "s-old",
      created_at: "2026-11-10T10:00:00Z",
      plan: { co2e_kg: 999, estimated_cost_minor: 9999999 },
    },
  ];

  const legs = [
    { shipment_id: "s2", cost_minor: "300000", co2e_kg: "79.5" },
    { shipment_id: "s3", cost_minor: null, co2e_kg: "45.2" },
  ];

  const quotes = [
    { shipment_id: "s3", state: "RECEIVED", amount_minor: "420000" },
    { shipment_id: "s3", state: "SELECTED", amount_minor: "380000" },
  ];

  const series = buildSevenDayPerformanceTrend({
    shipments,
    legs,
    quotes,
    now,
    days: 7,
  });

  assert.equal(series.length, 7);
  assert.equal(series[0].dateIso, "2026-11-20");
  assert.equal(series[6].dateIso, "2026-11-26");

  // Nov 26: 2 shipments, 120.5 + 79.5 = 200 kg CO2e, (500000 + 300000)/2 = 400000 minor avg
  assert.equal(series[6].shipments, 2);
  assert.equal(series[6].emissionsKg, 200);
  assert.equal(series[6].totalCostMinor, 800000);
  assert.equal(series[6].costPerShipmentMinor, 400000);

  // Nov 24 (index 4): 1 shipment, 45.2 kg CO2e, selected quote 380000
  assert.equal(series[4].shipments, 1);
  assert.equal(series[4].emissionsKg, 45.2);
  assert.equal(series[4].costPerShipmentMinor, 380000);

  // Empty days remain zero cleanly
  assert.equal(series[0].shipments, 0);
  assert.equal(series[0].costPerShipmentMinor, 0);

  const summary = summarizeSevenDayPerformance(series);
  assert.equal(summary.totalShipments, 3);
  assert.equal(summary.totalEmissionsKg, 245.2);
  assert.equal(summary.totalCostMinor, 1180000);
  assert.equal(summary.avgCostPerShipmentMinor, Math.round(1180000 / 3));
  assert.equal(summary.hasAnyData, true);
});

test("summarizeSevenDayPerformance handles completely empty 7-day window safely", () => {
  const series = buildSevenDayPerformanceTrend({
    shipments: [],
    legs: [],
    quotes: [],
    now: new Date("2026-11-26T12:00:00Z"),
  });
  assert.equal(series.length, 7);
  const summary = summarizeSevenDayPerformance(series);
  assert.equal(summary.totalShipments, 0);
  assert.equal(summary.avgCostPerShipmentMinor, 0);
  assert.equal(summary.hasAnyData, false);
});
