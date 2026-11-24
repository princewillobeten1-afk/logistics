import test from "node:test";
import assert from "node:assert/strict";
import { filterShipments, formatStateLabel } from "./view-helpers";

test("formatStateLabel formats uppercase enum tokens cleanly", () => {
  assert.equal(formatStateLabel("AWAITING_APPROVAL"), "Awaiting approval");
  assert.equal(formatStateLabel("IN_TRANSIT"), "In transit");
  assert.equal(formatStateLabel("POD_VERIFIED"), "POD verified");
  assert.equal(formatStateLabel("OK"), "Healthy");
  assert.equal(formatStateLabel("CUSTOM_STATE"), "Custom state");
});

test("filterShipments filters by state and query case-insensitively", () => {
  const sample = [
    {
      id: "1",
      reference: "LG-10421",
      state: "IN_TRANSIT",
      customer_ref: "ABC Retail Ltd",
      origin: { city: "Lagos", address: "Plot 14 Acme Way, Ikeja" },
      destination: { city: "Abuja", address: "12 Ahmadu Bello Way" },
      cargo: { sku: "ELEC-100", description: "100 cartons" },
      deadline: "2026-09-02T18:00:00Z",
      updated_at: "2026-09-01T10:00:00Z",
    },
    {
      id: "2",
      reference: "LG-10422",
      state: "AWAITING_APPROVAL",
      customer_ref: "Tema Trading Co",
      origin: { city: "Lagos" },
      destination: { city: "Tema" },
      cargo: { sku: "IND-200", description: "100 cartons, palletised" },
      deadline: "2026-09-20T17:00:00Z",
      updated_at: "2026-09-01T09:00:00Z",
    },
  ];

  assert.equal(filterShipments(sample, {}).length, 2);
  assert.equal(filterShipments(sample, { state: "AWAITING_APPROVAL" }).length, 1);
  assert.equal(filterShipments(sample, { query: "lg-10421" })[0]?.reference, "LG-10421");
  assert.equal(filterShipments(sample, { query: "abuja" })[0]?.reference, "LG-10421");
  assert.equal(filterShipments(sample, { query: "tema" })[0]?.reference, "LG-10422");
  assert.equal(filterShipments(sample, { query: "abc retail" })[0]?.reference, "LG-10421");
  assert.equal(filterShipments(sample, { query: "Lagos -> Abuja" }).length, 1);
  assert.equal(filterShipments(sample, { query: "Lagos → Tema" })[0]?.reference, "LG-10422");
  assert.equal(filterShipments(sample, { query: "Abuja -> Lagos" }).length, 0);
  assert.equal(filterShipments(sample, { query: "Lagos to Abuja" })[0]?.reference, "LG-10421");
  assert.equal(filterShipments(sample, { state: "EXCEPTION", query: "abuja" }).length, 0);
});
