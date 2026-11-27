import assert from "node:assert/strict";
import test from "node:test";
import {
  computeLogisticsReadiness,
  findNearbyDrivers,
  haversineDistanceKm,
  resolveCityCoordinates,
} from "./driver-dispatch";
import { buildMapDriverPins } from "./map-data";
import type { DocumentRow, DriverRow, ShipmentRow } from "./queries";

function makeDriver(overrides: Partial<DriverRow>): DriverRow {
  return {
    id: overrides.id ?? "drv-1",
    name: overrides.name ?? "Test Driver",
    phone: overrides.phone ?? "+2348000000000",
    licence_number: overrides.licence_number ?? "CDL-100",
    licence_expiry:
      overrides.licence_expiry ?? new Date(Date.now() + 180 * 86_400_000),
    hazmat_certified: overrides.hazmat_certified ?? false,
    active: overrides.active ?? true,
    carrier_code: overrides.carrier_code ?? "OWN",
    carrier_name: overrides.carrier_name ?? "Own Fleet",
    assigned_to: overrides.assigned_to ?? null,
    days_to_expiry: overrides.days_to_expiry ?? "180",
    duty_status: overrides.duty_status ?? "AVAILABLE",
    current_lat:
      overrides.current_lat !== undefined ? overrides.current_lat : "6.5244",
    current_lon:
      overrides.current_lon !== undefined ? overrides.current_lon : "3.3792",
    current_city: overrides.current_city ?? "Lagos",
    last_ping_at: overrides.last_ping_at ?? new Date(),
    hos_drive_remaining_hours: overrides.hos_drive_remaining_hours ?? 9.0,
    hos_duty_remaining_hours: overrides.hos_duty_remaining_hours ?? 12.0,
    vehicle_registration: overrides.vehicle_registration ?? "LAG-101-AA",
    equipment_type: overrides.equipment_type ?? "DRY_VAN",
    reefer_capable: overrides.reefer_capable ?? false,
    max_payload_kg: overrides.max_payload_kg ?? 20000,
  };
}

test("haversineDistanceKm computes accurate great-circle distance between Lagos and Ibadan", () => {
  const km = haversineDistanceKm(6.5244, 3.3792, 7.3775, 3.947);
  assert.ok(km > 105 && km < 125, `Expected ~114 km, got ${km}`);
  assert.equal(haversineDistanceKm(6.5244, 3.3792, 6.5244, 3.3792), 0);
});

test("findNearbyDrivers ranks eligible closest drivers first and enforces HOS, CDL, hazmat, reefer, and radius gates", () => {
  const target = resolveCityCoordinates("Lagos");
  assert.ok(target);

  const drivers: DriverRow[] = [
    makeDriver({
      id: "drv-close-ok",
      name: "Adaeze Ikeja",
      current_lat: "6.6018",
      current_lon: "3.3515",
      current_city: "Ikeja",
      hazmat_certified: true,
      reefer_capable: true,
      equipment_type: "REEFER",
      hos_drive_remaining_hours: 8.5,
      days_to_expiry: "120",
    }),
    makeDriver({
      id: "drv-expired-cdl",
      name: "Expired Licence Driver",
      current_lat: "6.5250",
      current_lon: "3.3800",
      current_city: "Lagos",
      days_to_expiry: "-5",
    }),
    makeDriver({
      id: "drv-low-hos",
      name: "Low HOS Driver",
      current_lat: "6.5300",
      current_lon: "3.3900",
      current_city: "Lagos",
      hos_drive_remaining_hours: 1.0,
    }),
    makeDriver({
      id: "drv-ibadan",
      name: "Ibadan Driver",
      current_lat: "7.3775",
      current_lon: "3.9470",
      current_city: "Ibadan",
      hos_drive_remaining_hours: 9.0,
    }),
    makeDriver({
      id: "drv-kano-far",
      name: "Kano Far Driver",
      current_lat: "12.0022",
      current_lon: "8.5920",
      current_city: "Kano",
    }),
  ];

  const within200 = findNearbyDrivers(drivers, target!, { maxRadiusKm: 200 });
  // Kano (~830 km) must be excluded
  assert.equal(within200.some((m) => m.driver.id === "drv-kano-far"), false);
  // Eligible closest driver must rank first ahead of closer-but-ineligible drivers
  assert.equal(within200[0].driver.id, "drv-close-ok");
  assert.equal(within200[0].eligible, true);
  assert.equal(within200[1].driver.id, "drv-ibadan");
  assert.equal(within200[1].eligible, true);

  // Expired CDL and low HOS must be flagged ineligible with clear blocking reasons
  const expired = within200.find((m) => m.driver.id === "drv-expired-cdl");
  assert.ok(expired);
  assert.equal(expired!.eligible, false);
  assert.match(expired!.blockingReasons.join(" "), /expired/i);

  const lowHos = within200.find((m) => m.driver.id === "drv-low-hos");
  assert.ok(lowHos);
  assert.equal(lowHos!.eligible, false);
  assert.match(lowHos!.blockingReasons.join(" "), /HOS/i);

  // Strict hazmat + reefer filter returns only drv-close-ok
  const specialized = findNearbyDrivers(drivers, target!, {
    maxRadiusKm: 300,
    requireHazmat: true,
    requireReefer: true,
    requireValidLicence: true,
    onlyAvailable: true,
  });
  assert.equal(specialized.length, 1);
  assert.equal(specialized[0].driver.id, "drv-close-ok");
});

test("computeLogisticsReadiness surfaces detention dwell risks (>2h), unverified e-POD/e-BOL, and driver compliance", () => {
  const nowMs = Date.now();
  const drivers: DriverRow[] = [
    makeDriver({ id: "d1", days_to_expiry: "90", hos_drive_remaining_hours: 8 }),
    makeDriver({ id: "d2", days_to_expiry: "-2", hos_drive_remaining_hours: 7 }),
    makeDriver({ id: "d3", days_to_expiry: "15", hos_drive_remaining_hours: 1.5 }),
  ];

  const shipments: ShipmentRow[] = [
    {
      id: "s1",
      reference: "SHP-DETAIN-1",
      state: "BOOKED",
      version: 1,
      customer_ref: "ACME",
      origin: { city: "Lagos" },
      destination: { city: "Abuja" },
      cargo: { weight_kg: 1200 },
      deadline: null,
      allocation: null,
      plan: {},
      booking: null,
      created_at: new Date(nowMs - 5 * 3_600_000),
      updated_at: new Date(nowMs - 3.5 * 3_600_000),
    },
    {
      id: "s2",
      reference: "SHP-FRESH-2",
      state: "BOOKED",
      version: 1,
      customer_ref: "ACME",
      origin: { city: "Lagos" },
      destination: { city: "Ibadan" },
      cargo: { weight_kg: 500 },
      deadline: null,
      allocation: null,
      plan: { assigned_driver_name: "Adaeze Ikeja" },
      booking: null,
      created_at: new Date(nowMs - 30 * 60_000),
      updated_at: new Date(nowMs - 30 * 60_000),
    },
  ];

  const docs: DocumentRow[] = [
    {
      id: "doc1",
      kind: "POD",
      direction: "INBOUND",
      filename: "signed_pod_001.pdf",
      extraction_model: null,
      extraction_confidence: null,
      reference: "SHP-DETAIN-1",
      verified_at: null,
      created_at: new Date(nowMs - 60_000),
    },
    {
      id: "doc2",
      kind: "BOL",
      direction: "OUTBOUND",
      filename: "verified_bol.pdf",
      extraction_model: null,
      extraction_confidence: null,
      reference: "SHP-FRESH-2",
      verified_at: new Date(nowMs - 30_000),
      created_at: new Date(nowMs - 60_000),
    },
  ];

  const report = computeLogisticsReadiness({
    drivers,
    shipments,
    documents: docs,
    nowMs,
  });

  assert.equal(report.driversTotal, 3);
  assert.equal(report.driversWithGps, 3);
  assert.equal(report.driversExpiredLicence, 1);
  assert.equal(report.driversExpiringSoon, 1);
  assert.equal(report.driversLowHos, 1);
  assert.equal(report.driversDispatchReady, 1);
  assert.equal(report.unassignedActiveShipments, 1);
  assert.equal(report.unverifiedPodBolCount, 1);
  assert.equal(report.detentionRisks.length, 1);
  assert.equal(report.detentionRisks[0].reference, "SHP-DETAIN-1");
  assert.ok(report.detentionRisks[0].estimatedExposureMinutes >= 85);
});

test("buildMapDriverPins maps live GPS and city-inferred drivers cleanly for Google Maps", () => {
  const pins = buildMapDriverPins([
    makeDriver({ id: "d-gps", name: "Live GPS Driver", current_lat: "6.52", current_lon: "3.38" }),
    makeDriver({
      id: "d-city",
      name: "City Fallback Driver",
      current_lat: null,
      current_lon: null,
      current_city: "Rotterdam",
    }),
    makeDriver({
      id: "d-inactive",
      name: "Inactive Driver",
      active: false,
    }),
  ]);
  assert.equal(pins.length, 2);
  assert.equal(pins[0].inferredFromCity, false);
  assert.equal(pins[1].inferredFromCity, true);
  assert.ok(Math.abs(pins[1].lat - 51.9244) < 0.01);
});
