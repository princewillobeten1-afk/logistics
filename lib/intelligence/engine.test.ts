import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getBiAccessPolicy,
  sanitizeInternalPath,
} from "@/lib/intelligence/access";
import {
  answerBiQuestionDeterministically,
  buildBiSnapshot,
  pctDelta,
  type BiRawInputs,
} from "@/lib/intelligence/engine";

const NOW = new Date("2026-11-27T12:00:00.000Z");
const DAY = 86_400_000;

function makeSampleInputs(): BiRawInputs {
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

  return {
    orgName: "Apex Freight Logistics",
    currency: "USD",
    shipments: [
      // Current 7D window (higher cost per shipment, 1 outlier, 1 delayed/exception)
      {
        id: "s1",
        reference: "SHP-1001",
        state: "IN_TRANSIT",
        version: 1,
        customer_ref: "ACME",
        origin: { city: "Lagos" },
        destination: { city: "Abuja" },
        cargo: {},
        deadline: daysAgo(-2),
        allocation: null,
        plan: { estimated_cost_minor: 280000, distance_km: 750, modes: ["ROAD"] },
        booking: null,
        created_at: daysAgo(1),
        updated_at: new Date(NOW.getTime() - 8 * 3_600_000), // dwell risk
      },
      {
        id: "s2",
        reference: "SHP-1002",
        state: "EXCEPTION",
        version: 1,
        customer_ref: "ACME",
        origin: { city: "Lagos" },
        destination: { city: "Kano" },
        cargo: {},
        deadline: daysAgo(1), // overdue
        allocation: null,
        plan: { estimated_cost_minor: 650000, distance_km: 1050, modes: ["AIR"] }, // outlier
        booking: null,
        created_at: daysAgo(2),
        updated_at: new Date(NOW.getTime() - 5 * 3_600_000),
      },
      {
        id: "s3",
        reference: "SHP-1003",
        state: "BOOKED",
        version: 1,
        customer_ref: "BETA",
        origin: { city: "Port Harcourt" },
        destination: { city: "Abuja" },
        cargo: {},
        deadline: daysAgo(-3),
        allocation: null,
        plan: { estimated_cost_minor: 260000, distance_km: 620, modes: ["ROAD"] },
        booking: null,
        created_at: daysAgo(3),
        updated_at: new Date(NOW.getTime() - 4 * 3_600_000), // detention > 2h
      },
      // Prior 7D window (5 shipments at lower avg unit cost to trigger both cost spike & volume decline)
      ...([8, 9, 10, 11, 12] as const).map((d, idx) => ({
        id: `p${idx}`,
        reference: `SHP-090${idx}`,
        state: "CLOSED",
        version: 1,
        customer_ref: idx % 2 === 0 ? "ACME" : "BETA",
        origin: { city: "Lagos" },
        destination: { city: "Abuja" },
        cargo: {},
        deadline: daysAgo(d - 2),
        allocation: null,
        plan: { estimated_cost_minor: 150000, distance_km: 750, modes: ["ROAD"] },
        booking: null,
        created_at: daysAgo(d),
        updated_at: daysAgo(d - 1),
      })),
    ],
    legs: [
      { shipment_id: "s1", sequence: 1, mode: "ROAD", state: "IN_TRANSIT", distance_km: 750, cost_minor: 280000, currency: "USD", co2e_kg: 420 },
      { shipment_id: "s2", sequence: 1, mode: "AIR", state: "EXCEPTION", distance_km: 1050, cost_minor: 650000, currency: "USD", co2e_kg: 1900 },
      { shipment_id: "s3", sequence: 1, mode: "ROAD", state: "BOOKED", distance_km: 620, cost_minor: 260000, currency: "USD", co2e_kg: 340 },
      ...([0, 1, 2, 3, 4] as const).map((idx) => ({
        shipment_id: `p${idx}`,
        sequence: 1,
        mode: "ROAD",
        state: "COMPLETED",
        distance_km: 750,
        cost_minor: 150000,
        currency: "USD",
        co2e_kg: 410,
      })),
    ],
    quotes: [
      { id: "q1", shipment_id: "s1", state: "SELECTED", amount_minor: 280000, currency: "USD", carrier_name: "FastLine" },
      { id: "q2", shipment_id: "s1", state: "RECEIVED", amount_minor: 210000, currency: "USD", carrier_name: "EcoHaul" },
    ],
    warehouses: [
      {
        id: "w1",
        code: "LOS-HUB",
        name: "Lagos Apapa Hub",
        dispatch_lead_hours: 10,
        handles_hazmat: true,
        handles_reefer: true,
        active: true,
        city: "Lagos",
        country: "NG",
        skus: 12,
        on_hand: 1000,
        reserved: 910, // >85% strained
      },
      {
        id: "w2",
        code: "ABJ-HUB",
        name: "Abuja Central Hub",
        dispatch_lead_hours: 3,
        handles_hazmat: false,
        handles_reefer: true,
        active: true,
        city: "Abuja",
        country: "NG",
        skus: 8,
        on_hand: 600,
        reserved: 220,
      },
    ],
    inventory: [
      { warehouse: "LOS-HUB", sku: "SKU-001", on_hand: 100, reserved: 90, available: 10 }, // <20%
      { warehouse: "ABJ-HUB", sku: "SKU-002", on_hand: 200, reserved: 40, available: 160 },
    ],
    conveyances: [
      {
        id: "v1",
        mode: "ROAD",
        kind: "40T Tractor",
        registration: "LAG-401-TR",
        carrier_code: "OWN",
        carrier_name: "Own Fleet",
        capacity_kg: "40000",
        capacity_cbm: "85",
        reefer: false,
        hazmat_certified: true,
        active: true,
        assigned_to: "SHP-1001",
        leg_state: "IN_TRANSIT",
        last_seen_at: NOW,
        last_lat: "6.5244",
        last_lon: "3.3792",
        last_speed: "72",
      },
      {
        id: "v2",
        mode: "ROAD",
        kind: "Reefer Van",
        registration: "ABJ-202-RF",
        carrier_code: "OWN",
        carrier_name: "Own Fleet",
        capacity_kg: "18000",
        capacity_cbm: "45",
        reefer: true,
        hazmat_certified: false,
        active: true,
        assigned_to: null,
        leg_state: null,
        last_seen_at: null,
        last_lat: null,
        last_lon: null,
        last_speed: null,
      },
      {
        id: "v3",
        mode: "ROAD",
        kind: "Flatbed",
        registration: "KAN-303-FB",
        carrier_code: "OWN",
        carrier_name: "Own Fleet",
        capacity_kg: "30000",
        capacity_cbm: "60",
        reefer: false,
        hazmat_certified: false,
        active: true,
        assigned_to: null,
        leg_state: null,
        last_seen_at: null,
        last_lat: null,
        last_lon: null,
        last_speed: null,
      },
    ],
    drivers: [
      {
        id: "d1",
        name: "Chidi Okafor",
        phone: "+2348001112222",
        licence_number: "CDL-111",
        licence_expiry: daysAgo(10), // expired!
        hazmat_certified: true,
        active: true,
        carrier_code: "OWN",
        carrier_name: "Own Fleet",
        assigned_to: null,
        days_to_expiry: "-10",
        duty_status: "AVAILABLE",
        current_lat: "6.5244",
        current_lon: "3.3792",
        hos_drive_remaining_hours: 8.5,
        hos_duty_remaining_hours: 11,
      },
      {
        id: "d2",
        name: "Amina Bello",
        phone: "+2348003334444",
        licence_number: "CDL-222",
        licence_expiry: daysAgo(-180),
        hazmat_certified: false,
        active: true,
        carrier_code: "OWN",
        carrier_name: "Own Fleet",
        assigned_to: "SHP-1001",
        days_to_expiry: "180",
        duty_status: "ON_ROUTE",
        current_lat: "7.3775",
        current_lon: "3.947",
        hos_drive_remaining_hours: 2.0, // low HOS
        hos_duty_remaining_hours: 4.0,
      },
    ],
    orders: [
      {
        id: "o1",
        reference: "ORD-1",
        state: "CONFIRMED",
        source: "EDI",
        currency: "USD",
        ordered_at: daysAgo(1),
        required_by: daysAgo(-4),
        customer: "Acme Manufacturing",
        items: 3,
      },
    ],
    customers: [
      {
        id: "c1",
        code: "ACME",
        name: "Acme Manufacturing",
        sla_hours: 48,
        payment_terms: "NET30",
        default_currency: "USD",
        contacts: [],
        active: true,
        total: "5",
        open: "2",
        late: "1",
        last_shipment_at: daysAgo(1),
      },
      {
        id: "c2",
        code: "BETA",
        name: "Beta Retail",
        sla_hours: 72,
        payment_terms: "NET15",
        default_currency: "USD",
        contacts: [],
        active: true,
        total: "3",
        open: "1",
        late: "0",
        last_shipment_at: daysAgo(3),
      },
    ],
    exceptions: [
      {
        id: "ex1",
        kind: "WEATHER_DELAY",
        severity: "CRITICAL",
        detected_by: "monitor",
        detail: {},
        created_at: daysAgo(1),
        reference: "SHP-1002",
      },
    ],
    approvals: [
      {
        id: "ap1",
        summary: "Air recovery surcharge",
        amount_minor: 650000,
        currency: "USD",
        requested_at: daysAgo(1),
        reference: "SHP-1002",
      },
    ],
    communications: [
      {
        id: "cm1",
        channel: "EMAIL",
        direction: "INBOUND",
        state: "RECEIVED",
        created_at: daysAgo(1),
        reference: "SHP-1002",
      },
    ],
    documents: [],
    customs: [
      { id: "cu1", direction: "EXPORT", clearance_state: "HOLD", reference: "SHP-1002" },
    ],
    queueCounts: { PENDING: 4 },
    deadWorkCount: 1,
    spendCeilingMinor: 500000,
  };
}

describe("AI Business Intelligence Engine", () => {
  it("computes pctDelta accurately including zero-prior safeguards", () => {
    assert.equal(pctDelta(150, 100), 50);
    assert.equal(pctDelta(75, 100), -25);
    assert.equal(pctDelta(0, 0), 0);
    assert.equal(pctDelta(50, 0), null);
  });

  it("collects and scores all 9 departments from live tenant records", () => {
    const snap = buildBiSnapshot(makeSampleInputs(), { periodDays: 7, role: "ADMIN", now: NOW });
    assert.equal(snap.departments.length, 9);
    const ids = snap.departments.map((d) => d.id);
    assert.deepEqual(ids, [
      "finance",
      "operations",
      "fleet",
      "shipments",
      "dispatch",
      "warehousing",
      "sales",
      "customers",
      "hr",
    ]);
    for (const dept of snap.departments) {
      assert.ok(dept.healthScore >= 0 && dept.healthScore <= 100);
      assert.ok(["VERIFIED", "ESTIMATE", "PREDICTION"].includes(dept.provenance));
    }
  });

  it("proactively detects cost spikes, fuel intensity rise, outliers, revenue decline, delays, branch strain, fleet underutilization, HR compliance, and customer SLA risks", () => {
    const snap = buildBiSnapshot(makeSampleInputs(), { periodDays: 7, role: "ADMIN", now: NOW });
    const alertIds = new Set(snap.proactiveAlerts.map((a) => a.id));

    assert.ok(alertIds.has("cost-spike-7d"), "should detect surging unit cost");
    assert.ok(alertIds.has("fuel-intensity-7d"), "should detect rising fuel cost/km");
    assert.ok(alertIds.has("expense-outliers-7d"), "should detect outlier shipment >1.6x median");
    assert.ok(alertIds.has("quote-spread-leakage"), "should detect carrier consolidation opportunity");
    assert.ok(alertIds.has("delayed-shipments-active"), "should detect active delayed/exception loads");
    assert.ok(alertIds.has("dock-detention-exposure"), "should detect dock detention >2h");
    assert.ok(alertIds.has("branch-warehouse-pressure"), "should detect strained warehouse branch");
    assert.ok(alertIds.has("fleet-underutilization"), "should detect idle fleet opportunity");
    assert.ok(alertIds.has("hr-driver-compliance-risk"), "should detect expired CDL & low HOS");
    assert.ok(alertIds.has("pending-spend-approvals"), "should detect pending spend approval bottleneck");
    assert.ok(alertIds.has("customer-sla-exposure"), "should detect customer SLA risk");
  });

  it("honors persisted acknowledged alert IDs and sorts open urgent alerts first", () => {
    const ackSet = new Set(["delayed-shipments-active"]);
    const snap = buildBiSnapshot(makeSampleInputs(), {
      periodDays: 7,
      role: "ADMIN",
      acknowledgedAlertIds: ackSet,
      now: NOW,
    });
    const acked = snap.proactiveAlerts.find((a) => a.id === "delayed-shipments-active");
    assert.ok(acked?.acknowledged === true);
    // Acknowledged alert should be sorted after unacknowledged ones
    const firstUnackedIdx = snap.proactiveAlerts.findIndex((a) => !a.acknowledged);
    const ackedIdx = snap.proactiveAlerts.findIndex((a) => a.id === "delayed-shipments-active");
    assert.ok(firstUnackedIdx >= 0 && ackedIdx > firstUnackedIdx);
  });

  it("produces verified historical buckets plus 7-day PREDICTION forecasts with valid lower/upper confidence bounds", () => {
    const snap = buildBiSnapshot(makeSampleInputs(), { periodDays: 7, role: "ADMIN", now: NOW });
    const actuals = snap.trendWithForecast.filter((p) => !p.isForecast);
    const forecasts = snap.trendWithForecast.filter((p) => p.isForecast);

    assert.equal(actuals.length, 7);
    assert.equal(forecasts.length, 7);
    assert.ok(actuals.every((p) => p.provenance === "VERIFIED"));
    assert.ok(forecasts.every((p) => p.provenance === "PREDICTION"));

    for (const f of forecasts) {
      assert.ok((f.shipmentsLower ?? 0) <= f.shipments);
      assert.ok((f.shipmentsUpper ?? f.shipments) >= f.shipments);
      assert.ok((f.freightSpendLower ?? 0) <= f.freightSpendMajor);
      assert.ok((f.freightSpendUpper ?? f.freightSpendMajor) >= f.freightSpendMajor);
    }
  });

  it("populates all 5 multi-dimensional comparisons (departments, branches, vehicles, routes, customers)", () => {
    const snap = buildBiSnapshot(makeSampleInputs(), { periodDays: 7, role: "ADMIN", now: NOW });
    assert.equal(snap.comparisons.departments.length, 9);
    assert.equal(snap.comparisons.branches.length, 2);
    assert.equal(snap.comparisons.vehicles.length, 3);
    assert.ok(snap.comparisons.routes.length >= 2);
    assert.equal(snap.comparisons.customers.length, 2);
  });

  it("enforces RBAC access policies and redacts sensitive finance/HR details for VIEWER and DISPATCHER", () => {
    const adminPolicy = getBiAccessPolicy("ADMIN");
    const approverPolicy = getBiAccessPolicy("APPROVER");
    const dispatcherPolicy = getBiAccessPolicy("DISPATCHER");
    const viewerPolicy = getBiAccessPolicy("VIEWER");

    assert.equal(adminPolicy.canViewDetailedFinance, true);
    assert.equal(approverPolicy.canViewDetailedFinance, true);
    assert.equal(dispatcherPolicy.canViewDetailedFinance, false);
    assert.equal(dispatcherPolicy.canAcknowledgeAlerts, true);
    assert.equal(viewerPolicy.canViewDetailedFinance, false);
    assert.equal(viewerPolicy.canAcknowledgeAlerts, false);

    const viewerSnap = buildBiSnapshot(makeSampleInputs(), {
      periodDays: 7,
      role: "VIEWER",
      now: NOW,
    });
    const marginKpi = viewerSnap.executiveKpis.find((k) => k.id === "gross_margin_est");
    assert.equal(marginKpi?.valueFormatted, "Restricted");
    assert.equal(marginKpi?.redacted, true);

    const finDept = viewerSnap.departments.find((d) => d.id === "finance");
    assert.equal(finDept?.redacted, true);
  });

  it("sanitizes dynamic internal deep links against unsafe URL schemes", () => {
    assert.equal(sanitizeInternalPath("/shipments"), "/shipments");
    assert.equal(sanitizeInternalPath("javascript:alert(1)"), "/intelligence");
    assert.equal(sanitizeInternalPath("https://evil.example/phish"), "/intelligence");
    assert.equal(sanitizeInternalPath("//evil.example/phish"), "/intelligence");
  });

  it("answers natural-language questions deterministically with charts, tables, formulas, and provenance", () => {
    const snap = buildBiSnapshot(makeSampleInputs(), { periodDays: 7, role: "ADMIN", now: NOW });

    const fcAns = answerBiQuestionDeterministically("What is our 7-day forecast?", snap);
    assert.equal(fcAns.answeredBy, "DETERMINISTIC_ENGINE");
    assert.ok(fcAns.provenanceTags.includes("PREDICTION"));
    assert.ok(fcAns.chart && fcAns.chart.points.length === 7);
    assert.ok(fcAns.table && fcAns.table.rows.length === 7);

    const branchAns = answerBiQuestionDeterministically("Compare our warehouse branches", snap);
    assert.ok(branchAns.table && branchAns.table.rows.length === 2);
    assert.ok(branchAns.recommendations.length > 0);

    const custAns = answerBiQuestionDeterministically("Which customer has SLA risk?", snap);
    assert.ok(custAns.chart && custAns.chart.points.length === 2);

    const fc30Ans = answerBiQuestionDeterministically(
      "Analyze our 30-day predictive forecast for shipment volume and carrier cost requirements",
      snap,
    );
    assert.equal(fc30Ans.answeredBy, "DETERMINISTIC_ENGINE");
    assert.ok(fc30Ans.provenanceTags.includes("PREDICTION"));
    assert.ok(fc30Ans.chart && fc30Ans.chart.points.length === 4);
    assert.ok(fc30Ans.table && fc30Ans.table.rows.length === 4);
  });

  it("projects 30-day shipment volume and carrier cost requirements with confidence bands, weekly rollups, mode mix, and RBAC cost redaction", () => {
    const adminSnap = buildBiSnapshot(makeSampleInputs(), {
      periodDays: 7,
      role: "ADMIN",
      now: NOW,
    });
    const f30 = adminSnap.forecast30d;

    assert.equal(f30.horizonDays, 30);
    assert.equal(f30.historicalDaysUsed, 30);
    assert.equal(f30.dailySeries.length, 60);

    const hist = f30.dailySeries.filter((p) => !p.isForecast);
    const future = f30.dailySeries.filter((p) => p.isForecast);
    assert.equal(hist.length, 30);
    assert.equal(future.length, 30);
    assert.ok(hist.every((p) => p.provenance === "VERIFIED"));
    assert.ok(future.every((p) => p.provenance === "PREDICTION"));

    // Today bridge point populates both actual & projected values seamlessly
    const todayPt = hist[hist.length - 1];
    assert.equal(todayPt.dayIndex, 0);
    assert.equal(todayPt.actualShipments, todayPt.projectedShipments);
    assert.equal(todayPt.actualCarrierCostMajor, todayPt.projectedCarrierCostMajor);

    // Every future point has valid non-negative bounds and stacked band spans
    let prevCumCost = 0;
    for (const pt of future) {
      assert.equal(pt.actualShipments, null);
      assert.equal(pt.actualCarrierCostMajor, null);
      assert.ok((pt.shipmentsLower ?? 0) >= 0);
      assert.ok((pt.shipmentsLower ?? 0) <= (pt.projectedShipments ?? 0));
      assert.ok((pt.shipmentsUpper ?? 0) >= (pt.projectedShipments ?? 0));
      assert.ok(
        Math.abs(
          (pt.shipmentsBandBase ?? 0) +
            (pt.shipmentsBandSpan ?? 0) -
            (pt.shipmentsUpper ?? 0),
        ) <= 0.15,
      );
      assert.ok((pt.carrierCostLower ?? 0) >= 0);
      assert.ok((pt.carrierCostLower ?? 0) <= (pt.projectedCarrierCostMajor ?? 0));
      assert.ok((pt.carrierCostUpper ?? 0) >= (pt.projectedCarrierCostMajor ?? 0));
      assert.equal(
        (pt.carrierCostBandBase ?? 0) + (pt.carrierCostBandSpan ?? 0),
        pt.carrierCostUpper,
      );
      assert.ok((pt.cumulativeProjectedCostMajor ?? 0) >= prevCumCost);
      prevCumCost = pt.cumulativeProjectedCostMajor ?? prevCumCost;
    }

    // 4 weekly rollups cover all 30 days and sum cleanly to 30-day totals
    assert.equal(f30.weeklyRollup.length, 4);
    const weeklyCostSum = f30.weeklyRollup.reduce(
      (s, w) => s + w.projectedCarrierCostMajor,
      0,
    );
    assert.equal(weeklyCostSum, f30.totalProjectedCarrierCostMajor);
    assert.ok(f30.totalProjectedShipments > 0);
    assert.ok(f30.totalProjectedCarrierCostMajor > 0);
    assert.ok(f30.modeAllocation.length >= 1);

    // RBAC: VIEWER retains shipment volume forecast while carrier cost budget is redacted
    const viewerSnap = buildBiSnapshot(makeSampleInputs(), {
      periodDays: 7,
      role: "VIEWER",
      now: NOW,
    });
    assert.equal(viewerSnap.forecast30d.carrierCostRedacted, true);
    assert.equal(
      viewerSnap.forecast30d.totalProjectedShipments,
      f30.totalProjectedShipments,
    );
    assert.equal(viewerSnap.forecast30d.totalProjectedCarrierCostMajor, 0);
    assert.ok(
      viewerSnap.forecast30d.dailySeries.every(
        (p) =>
          p.actualCarrierCostMajor === null &&
          p.projectedCarrierCostMajor === null &&
          p.carrierCostBandSpan === null,
      ),
    );
    assert.ok(
      viewerSnap.forecast30d.weeklyRollup.every(
        (w) => w.projectedCarrierCostMajor === 0 && w.carrierCostUpper === 0,
      ),
    );
  });
});
