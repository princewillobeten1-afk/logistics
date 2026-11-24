import assert from "node:assert/strict";
import test from "node:test";
import { buildMapNetworkData } from "./map-data";

test("buildMapNetworkData projects finite coordinates, builds active lanes, and filters closed states", () => {
  const locations = [
    {
      id: "loc-1",
      type: "PORT",
      name: "Lagos Port",
      code: "LOS",
      city: "Lagos",
      country: "Nigeria",
      latitude: "6.4474",
      longitude: "3.3903",
    },
    {
      id: "loc-2",
      type: "PORT",
      name: "Tema Port",
      code: "TEM",
      city: "Tema",
      country: "Ghana",
      latitude: "5.6167",
      longitude: "0.0167",
    },
    {
      id: "loc-bad",
      type: "WAREHOUSE",
      name: "Unmapped",
      code: null,
      city: "Accra",
      country: "Ghana",
      latitude: null,
      longitude: null,
    },
  ];

  const now = new Date("2026-11-19T10:00:00.000Z");
  const shipments = [
    {
      id: "ship-1",
      reference: "LG-10001",
      state: "IN_TRANSIT",
      customer_ref: "CUST-1",
      origin: { city: "Lagos" },
      destination: { city: "Tema" },
      cargo: { weight_kg: 1200 },
      updated_at: now,
    },
    {
      id: "ship-2",
      reference: "LG-10002",
      state: "EXCEPTION",
      customer_ref: "CUST-2",
      origin: { city: "Lagos" },
      destination: { city: "Tema" },
      cargo: { weight_kg: 800 },
      updated_at: "2026-11-19T09:00:00.000Z",
    },
    {
      id: "ship-closed",
      reference: "LG-10003",
      state: "CLOSED",
      customer_ref: "CUST-3",
      origin: { city: "Lagos" },
      destination: { city: "Tema" },
      cargo: { weight_kg: 500 },
      updated_at: now,
    },
  ];

  const result = buildMapNetworkData(locations, shipments);

  assert.equal(result.points.length, 2);
  assert.equal(result.active.length, 2);
  assert.equal(result.lanes.length, 2);
  assert.equal(result.lanes[0].alert, false);
  assert.equal(result.lanes[1].alert, true);
  assert.equal(result.active[0].updated_at, "2026-11-19T10:00:00.000Z");
  assert.ok(Number.isFinite(result.points[0].x));
  assert.ok(Number.isFinite(result.points[0].y));
});
