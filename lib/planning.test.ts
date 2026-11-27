import assert from "node:assert/strict";
import test from "node:test";
import {
  KNOWN_HUB_KM,
  calculateShipmentPlan,
  computeInventoryEconomics,
  estimateLaneKm,
  matchBestConveyance,
  normalizeTransportMode,
  poolConsolidatableShipments,
  type ConveyanceCandidate,
} from "./planning";

test("estimateLaneKm resolves known corridors, reverse corridors, same-city, and fallback distances", () => {
  assert.equal(estimateLaneKm("Lagos", "Abuja"), 755);
  assert.equal(estimateLaneKm("  abuja ", "LAGOS"), 755);
  assert.equal(estimateLaneKm("Port Harcourt", "Kano"), 1025);
  assert.equal(estimateLaneKm("Lagos", "Lagos"), 25);
  assert.equal(estimateLaneKm("Enugu", "Sokoto"), 520);
  assert.equal(estimateLaneKm(null, "Abuja"), 450);
  assert.equal(estimateLaneKm("Lagos", ""), 450);

  // Every known corridor should have a strictly positive distance
  for (const [lane, km] of Object.entries(KNOWN_HUB_KM)) {
    assert.ok(km > 0, `Expected positive distance for ${lane}`);
  }
});

test("normalizeTransportMode defaults unknown or missing modes safely to ROAD", () => {
  assert.equal(normalizeTransportMode("air"), "AIR");
  assert.equal(normalizeTransportMode(" Sea "), "SEA");
  assert.equal(normalizeTransportMode("RAIL"), "RAIL");
  assert.equal(normalizeTransportMode("ROAD"), "ROAD");
  assert.equal(normalizeTransportMode("drone"), "ROAD");
  assert.equal(normalizeTransportMode(null), "ROAD");
});

test("calculateShipmentPlan computes accurate mode-aware cost, CO2e, transit hours, and deadline feasibility", () => {
  const nowMs = Date.parse("2026-11-24T12:00:00.000Z");

  // Lagos -> Abuja (755 km) by ROAD: round(755/55) = 14 hours
  const roadPlan = calculateShipmentPlan({
    originCity: "Lagos",
    destinationCity: "Abuja",
    weightKg: 600,
    preferredMode: "ROAD",
    deadlineIso: "2026-11-25T12:00:00.000Z", // +24h -> feasible
    currency: "ngn",
    nowMs,
  });

  assert.equal(roadPlan.mode, "ROAD");
  assert.equal(roadPlan.distanceKm, 755);
  assert.equal(roadPlan.weightKg, 600);
  assert.equal(roadPlan.transitHours, 14);
  assert.equal(roadPlan.meetsDeadline, true);
  assert.equal(roadPlan.currency, "NGN");
  assert.equal(roadPlan.estimatedCostMinor, Math.round((755 * 850 + 600 * 120) * 100));
  assert.equal(roadPlan.co2eKg, Math.round(755 * 0.6 * 62 * 10) / 10);

  // Tight 6-hour deadline on the same ROAD corridor must flag meetsDeadline = false
  const tightRoadPlan = calculateShipmentPlan({
    originCity: "Lagos",
    destinationCity: "Abuja",
    weightKg: 600,
    preferredMode: "ROAD",
    deadlineIso: "2026-11-24T18:00:00.000Z", // +6h < 14h transit
    nowMs,
  });
  assert.equal(tightRoadPlan.meetsDeadline, false);

  // Switching the same tight 6-hour deadline to AIR (4h min transit) makes it feasible at higher cost & CO2e
  const airPlan = calculateShipmentPlan({
    originCity: "Lagos",
    destinationCity: "Abuja",
    weightKg: 600,
    preferredMode: "AIR",
    deadlineIso: "2026-11-24T18:00:00.000Z", // +6h >= 4h AIR transit
    nowMs,
  });
  assert.equal(airPlan.mode, "AIR");
  assert.equal(airPlan.transitHours, 4);
  assert.equal(airPlan.meetsDeadline, true);
  assert.ok(airPlan.estimatedCostMinor > roadPlan.estimatedCostMinor);
  assert.ok(airPlan.co2eKg > roadPlan.co2eKg);

  // SEA mode should be slower and lower-emission than ROAD
  const seaPlan = calculateShipmentPlan({
    originCity: "Lagos",
    destinationCity: "Abidjan",
    weightKg: 2000,
    preferredMode: "SEA",
    nowMs,
  });
  assert.equal(seaPlan.mode, "SEA");
  assert.ok(seaPlan.transitHours >= 24);
  assert.ok(seaPlan.co2eKg < calculateShipmentPlan({
    originCity: "Lagos",
    destinationCity: "Abidjan",
    weightKg: 2000,
    preferredMode: "ROAD",
    nowMs,
  }).co2eKg);
});

test("calculateShipmentPlan falls back cleanly on invalid dates, negative weights, or missing currency", () => {
  const nowMs = Date.parse("2026-11-24T12:00:00.000Z");
  const plan = calculateShipmentPlan({
    originCity: "Lagos",
    destinationCity: "Ibadan",
    weightKg: -50,
    deadlineIso: "not-a-valid-iso-date",
    currency: "",
    nowMs,
  });

  assert.equal(plan.weightKg, 250);
  assert.equal(plan.currency, "NGN");
  assert.equal(plan.distanceKm, 130);
  assert.equal(plan.transitHours, 8); // minimum ROAD dwell
  assert.equal(plan.deadlineIso, new Date(nowMs + 72 * 3_600_000).toISOString());
  assert.equal(plan.meetsDeadline, true);
});

test("matchBestConveyance enforces reefer, hazmat, weight capacity, active/idle state, and best-fit sizing", () => {
  const fleet: ConveyanceCandidate[] = [
    {
      registration: "LAG-DRY-10T",
      active: true,
      assigned_to: null,
      capacity_kg: 10000,
      reefer: false,
      hazmat_certified: false,
      mode: "ROAD",
    },
    {
      registration: "LAG-REEF-5T",
      active: true,
      assigned_to: null,
      capacity_kg: 5000,
      reefer: true,
      hazmat_certified: false,
      mode: "ROAD",
    },
    {
      registration: "LAG-REEF-1T",
      active: true,
      assigned_to: null,
      capacity_kg: "1000",
      reefer: true,
      hazmat_certified: false,
      mode: "ROAD",
    },
    {
      registration: "LAG-HAZ-3T",
      active: true,
      assigned_to: null,
      capacity_kg: 3000,
      reefer: false,
      hazmat_certified: true,
      mode: "ROAD",
    },
    {
      registration: "LAG-HAZ-BUSY",
      active: true,
      assigned_to: "LG-99999",
      capacity_kg: 5000,
      reefer: true,
      hazmat_certified: true,
      mode: "ROAD",
    },
    {
      registration: "LAG-HAZ-INACTIVE",
      active: false,
      assigned_to: null,
      capacity_kg: 5000,
      reefer: true,
      hazmat_certified: true,
      mode: "ROAD",
    },
  ];

  // Cold-chain 600 kg shipment should pick the tightest-fit 1,000 kg reefer van (not the 5,000 kg truck)
  const reeferMatch = matchBestConveyance({ weightKg: 600, reefer: true }, fleet);
  assert.equal(reeferMatch?.registration, "LAG-REEF-1T");

  // Cold-chain 2,500 kg shipment exceeds 1,000 kg van -> picks 5,000 kg reefer truck
  const heavyReeferMatch = matchBestConveyance({ weightKg: 2500, reefer: true }, fleet);
  assert.equal(heavyReeferMatch?.registration, "LAG-REEF-5T");

  // Hazmat 1,400 kg shipment picks idle certified hazmat truck, ignoring busy/inactive ones
  const hazmatMatch = matchBestConveyance({ weightKg: 1400, hazmat: true }, fleet);
  assert.equal(hazmatMatch?.registration, "LAG-HAZ-3T");

  // Excluded registration cannot be double-assigned in the same optimization pass
  const excludedHazmat = matchBestConveyance(
    { weightKg: 1400, hazmat: true },
    fleet,
    new Set(["LAG-HAZ-3T"]),
  );
  assert.equal(excludedHazmat, null);

  // Combined hazmat + reefer with no idle dual-certified vehicle returns null instead of unsafe fallback
  const dualMatch = matchBestConveyance({ weightKg: 500, hazmat: true, reefer: true }, fleet);
  assert.equal(dualMatch, null);

  // Load heavier than any idle compliant vehicle returns null
  const overweight = matchBestConveyance({ weightKg: 15000 }, fleet);
  assert.equal(overweight, null);
});

test("computeInventoryEconomics computes stock health, valuation, and carrying cost", () => {
  const critical = computeInventoryEconomics({
    onHand: 20,
    reserved: 5,
    safetyStock: 20,
    reorderPoint: 40,
    reorderQuantity: 80,
    unitCostMinor: 500_000,
    annualHoldingRate: 0.2,
  });
  assert.equal(critical.available, 15);
  assert.equal(critical.stockHealth, "CRITICAL");
  assert.equal(critical.inventoryValueMinor, 10_000_000);
  assert.equal(critical.annualHoldingCostMinor, 2_000_000);
  assert.equal(critical.dailyHoldingCostMinor, Math.round(2_000_000 / 365));
  assert.ok(critical.suggestedReorderQty >= 80);

  const healthy = computeInventoryEconomics({
    onHand: 150,
    reserved: 10,
    safetyStock: 20,
    reorderPoint: 40,
    reorderQuantity: 80,
    unitCostMinor: 500_000,
    annualHoldingRate: 0.2,
  });
  assert.equal(healthy.stockHealth, "HEALTHY");
  assert.equal(healthy.suggestedReorderQty, 0);
});

test("poolConsolidatableShipments groups >= 2 LTL/LCL orders on matching lane and mode", () => {
  const pools = poolConsolidatableShipments([
    {
      shipmentId: "s1",
      reference: "LG-1",
      originCity: "Lagos",
      destinationCity: "Abuja",
      mode: "ROAD",
      loadType: "LTL",
      weightKg: 1100,
      estimatedCostMinor: 10_000_000,
    },
    {
      shipmentId: "s2",
      reference: "LG-2",
      originCity: "Lagos",
      destinationCity: "Abuja",
      mode: "ROAD",
      loadType: "LTL",
      weightKg: 1900,
      estimatedCostMinor: 15_000_000,
    },
    {
      shipmentId: "s3",
      reference: "LG-3",
      originCity: "Lagos",
      destinationCity: "Kano",
      mode: "ROAD",
      loadType: "LTL",
      weightKg: 900,
    },
    {
      shipmentId: "s4",
      reference: "LG-4",
      originCity: "Lagos",
      destinationCity: "Abuja",
      mode: "ROAD",
      loadType: "FTL",
      weightKg: 8000,
    },
  ]);

  assert.equal(pools.length, 1);
  assert.equal(pools[0].loadType, "CONSOLIDATED_LTL");
  assert.equal(pools[0].totalWeightKg, 3000);
  assert.equal(pools[0].items.length, 2);
  assert.equal(pools[0].estimatedSavingsMinor, Math.round(25_000_000 * 0.28));
});
