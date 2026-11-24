import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAutonomousIntent,
  dispatchToAutonomousAgent,
  extractOrderFieldsFromText,
  mapIntakeToSourceAndVia,
  selectDelegatedSpecialistsForIntent,
} from "./autonomous";

test("classifyAutonomousIntent classifies orders, planning, exceptions, customs, and billing accurately", () => {
  assert.equal(
    classifyAutonomousIntent("Send 20 cartons of laptops from Lagos to Abuja"),
    "NEW_ORDER",
  );
  assert.equal(
    classifyAutonomousIntent("Please reroute LG-00001 via road freight due to congestion"),
    "PLANNING_ROUTING",
  );
  assert.equal(
    classifyAutonomousIntent("Shipment LG-00001 arrived with damaged cartons"),
    "EXCEPTION_REPORT",
  );
  assert.equal(
    classifyAutonomousIntent("Need customs HS code clearance for Accra manifest"),
    "CUSTOMS_DOCS",
  );
  assert.equal(
    classifyAutonomousIntent("Check carrier invoice payment status for PO-2026-1001"),
    "BILLING_INVOICE",
  );
});

test("extractOrderFieldsFromText extracts shipment references, cities, weight, quantity, and handling flags", () => {
  const parsed = extractOrderFieldsFromText(
    "Book 50 cartons of frozen seafood (450 kg) from Lagos to Abuja before Friday on shipment LG-00001",
  );
  assert.equal(parsed.originCity, "Lagos");
  assert.equal(parsed.destinationCity, "Abuja");
  assert.equal(parsed.weightKg, 450);
  assert.equal(parsed.quantity, 50);
  assert.equal(parsed.reefer, true);
  assert.equal(parsed.shipmentReference, "LG-00001");
});

test("mapIntakeToSourceAndVia aligns all omnichannel and web form inputs to schema constraints", () => {
  assert.deepEqual(mapIntakeToSourceAndVia("WHATSAPP"), {
    orderSource: "WHATSAPP",
    shipmentCreatedVia: "CHAT",
    contactChannel: "WHATSAPP",
  });
  assert.deepEqual(mapIntakeToSourceAndVia("TELEGRAM"), {
    orderSource: "API",
    shipmentCreatedVia: "CHAT",
    contactChannel: "TELEGRAM",
  });
  assert.deepEqual(mapIntakeToSourceAndVia("WEB_FORM_ORDER"), {
    orderSource: "PORTAL",
    shipmentCreatedVia: "MANUAL",
    contactChannel: null,
  });
  assert.deepEqual(mapIntakeToSourceAndVia("EXTERNAL_API"), {
    orderSource: "API",
    shipmentCreatedVia: "API",
    contactChannel: null,
  });
});

test("selectDelegatedSpecialistsForIntent maps intents to backend domain specialists", () => {
  const orderSpecs = selectDelegatedSpecialistsForIntent("NEW_ORDER", "Create new order");
  assert.ok(orderSpecs.includes("order-management"));
  assert.ok(orderSpecs.includes("shipment-management"));
  assert.ok(orderSpecs.includes("route-optimization"));

  const planSpecs = selectDelegatedSpecialistsForIntent("PLANNING_ROUTING", "Optimize corridor");
  assert.ok(planSpecs.includes("route-optimization"));
  assert.ok(planSpecs.includes("fleet-management"));
});

test("dispatchToAutonomousAgent creates orders, shipments, and delegates immediately for website & external intakes", async () => {
  const prevKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const orderOut = await dispatchToAutonomousAgent({
      sourceChannel: "WEB_FORM_ORDER",
      message: "Website order from Lagos to Kano",
      orgId: null,
      structured: {
        customerName: "Test Logistics Client",
        originCity: "Lagos",
        destinationCity: "Kano",
        cargoDescription: "Solar inverters",
        weightKg: 320,
        quantity: 12,
      },
    });
    assert.equal(orderOut.intent, "NEW_ORDER");
    assert.equal(orderOut.startedWork, true);
    assert.ok(orderOut.orderReference?.startsWith("PO-2026-"));
    assert.ok(orderOut.shipmentReference?.startsWith("LG-"));
    assert.ok(orderOut.delegatedAgents.includes("order-management"));

    const planOut = await dispatchToAutonomousAgent({
      sourceChannel: "EXTERNAL_API",
      intentHint: "PLANNING_ROUTING",
      message: `External route planning for ${orderOut.shipmentReference}`,
      reference: orderOut.shipmentReference ?? undefined,
      orgId: null,
      structured: {
        preferredMode: "ROAD",
        notes: "Prioritize fastest corridor",
      },
    });
    assert.equal(planOut.intent, "PLANNING_ROUTING");
    assert.equal(planOut.startedWork, true);
    assert.ok(planOut.delegatedAgents.includes("route-optimization"));
  } finally {
    if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
  }
});
