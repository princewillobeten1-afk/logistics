import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMockAssistantReply,
  buildMockSupportReply,
  filterShipments,
  formatStateLabel,
} from "./view-helpers";

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
      reference: "LG-82931",
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
      reference: "LG-90014",
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
  assert.equal(filterShipments(sample, { query: "abuja" })[0]?.reference, "LG-82931");
  assert.equal(filterShipments(sample, { query: "tema" })[0]?.reference, "LG-90014");
  assert.equal(filterShipments(sample, { state: "EXCEPTION", query: "abuja" }).length, 0);
});

test("buildMockAssistantReply adapts to delay and quote questions", () => {
  const delayReply = buildMockAssistantReply({
    reference: "LG-82931",
    question: "Why is this delayed?",
    state: "EXCEPTION",
    originCity: "Lagos",
    destinationCity: "Abuja",
    customer: "ABC Retail Ltd",
    exceptionSummary: "Lokoja bridge checkpoint congestion (+4h)",
  });
  assert.match(delayReply.body, /Lokoja bridge/);
  assert.ok(delayReply.next_step.length > 0);

  const quoteReply = buildMockAssistantReply({
    reference: "LG-90014",
    question: "What alternatives do we have?",
    state: "AWAITING_APPROVAL",
    originCity: "Lagos",
    destinationCity: "Tema",
    customer: "Tema Trading Co",
    quoteSummary: "GIG Logistics ₦485,000 (28h)",
  });
  assert.match(quoteReply.body, /GIG Logistics/);
});

test("buildMockSupportReply answers customer tracking questions safely", () => {
  const reply = buildMockSupportReply({
    reference: "LG-82931",
    question: "Who is delivering it?",
    status: "In transit",
    origin: "Lagos",
    destination: "Abuja",
    carrier: "KOBO360",
  });
  assert.match(reply, /KOBO360/);
});
