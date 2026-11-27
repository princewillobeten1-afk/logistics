import assert from "node:assert/strict";
import test from "node:test";
import { query } from "@/lib/db";
import { dispatchToAutonomousAgent, extractOrderFieldsFromText } from "./autonomous";
import {
  BACKEND_WORKFLOW_AGENT_MAP,
  CORE_AGENTS,
  getAgentForBackendWorkflow,
  type BackendWorkflow,
} from "./catalog";
import { gatherOperationalContext } from "./context";

test("all 15 agents gather domain operational context on empty and populated stores without errors", async () => {
  for (const agent of CORE_AGENTS) {
    const emptyCtx = await gatherOperationalContext(agent.id);
    assert.ok(emptyCtx.snapshot.overview, `${agent.id} should include overview stats`);
  }

  const prevKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const created = await dispatchToAutonomousAgent({
      sourceChannel: "WEB_FORM_ORDER",
      message: "Test shipment from Lagos to Abuja",
      orgId: null,
      structured: {
        customerName: "Context Test Client",
        originCity: "Lagos",
        destinationCity: "Abuja",
        cargoDescription: "Medical supplies",
        weightKg: 180,
        quantity: 6,
      },
    });
    assert.ok(created.shipmentReference);

    for (const agent of CORE_AGENTS) {
      const ctx = await gatherOperationalContext(
        agent.id,
        created.shipmentReference ?? undefined,
      );
      assert.equal(ctx.resolvedReference, created.shipmentReference);
      assert.ok(ctx.shipmentId, `${agent.id} should resolve shipmentId`);
      assert.ok(ctx.snapshot.overview, `${agent.id} should include overview stats`);
      assert.ok(ctx.snapshot.focusShipment, `${agent.id} should include focusShipment`);
    }
  } finally {
    if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
  }
});

test("every backend workflow maps cleanly to a unique defined core agent", () => {
  const workflows = Object.keys(BACKEND_WORKFLOW_AGENT_MAP) as BackendWorkflow[];
  assert.equal(workflows.length, 15);
  for (const wf of workflows) {
    const agent = getAgentForBackendWorkflow(wf);
    assert.ok(agent.id);
    assert.ok(agent.quickPrompts.length > 0);
  }
});

test("extractOrderFieldsFromText trims trailing urgency adverbs cleanly", () => {
  const parsed = extractOrderFieldsFromText(
    "Book 300 kg spare parts from Lagos to Port Harcourt urgently",
  );
  assert.equal(parsed.originCity, "Lagos");
  assert.equal(parsed.destinationCity, "Port Harcourt");
  assert.equal(parsed.weightKg, 300);
});

test("work_items insert accurately parses columns when shipment_id is omitted", async () => {
  await query(
    `INSERT INTO work_items (kind, state, payload, priority, dedupe_key)
     VALUES ($1, 'DONE', $2::jsonb, 15, $3)
     ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
    [
      "support.test_delegation",
      JSON.stringify({ workflow: "support.customer_reply" }),
      `test-sweep:${Date.now()}`,
    ],
  );

  const rows = await query<{ kind: string; state: string; reference: string | null }>(
    `SELECT w.kind, w.state, s.reference
       FROM work_items w
       LEFT JOIN shipments s ON s.id = w.shipment_id
      WHERE w.kind LIKE 'support.%'
      ORDER BY w.created_at DESC
      LIMIT 25`,
  );
  const inserted = rows.find((r) => r.kind === "support.test_delegation");
  assert.ok(inserted);
  assert.equal(inserted?.state, "DONE");
  assert.equal(inserted?.reference, null);
});

test("orchestrator keyword routing and agent context cover nearby drivers, HOS, detention, and channel contacts", async () => {
  const { selectOrchestratorSpecialists } = await import("./catalog");

  const fleetRoute = selectOrchestratorSpecialists(
    "Find nearby HOS-compliant drivers around Lagos for urgent dispatch",
  ).map((s) => s.agentId);
  assert.ok(
    fleetRoute.includes("fleet-management"),
    `Expected fleet-management in ${JSON.stringify(fleetRoute)}`,
  );

  const detentionRoute = selectOrchestratorSpecialists(
    "Audit dock detention and dwell accessorial fees plus unverified e-POD",
  ).map((s) => s.agentId);
  assert.ok(detentionRoute.includes("exception-resolution"));
  assert.ok(detentionRoute.includes("financial-management"));

  // Regression: expired driver licence days_to_expiry must remain negative
  const expiredDate = new Date(Date.now() - 10 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await query(
    `INSERT INTO drivers (
       name, phone, licence_number, licence_expiry, hazmat_certified,
       current_lat, current_lon, current_city, duty_status,
       hos_drive_remaining_hours, hos_duty_remaining_hours
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      "Regression Expired Driver",
      "+2348011112222",
      "CDL-EXP-REG-1",
      expiredDate,
      false,
      6.5244,
      3.3792,
      "Lagos",
      "AVAILABLE",
      8.0,
      11.0,
    ],
  );

  const fleetCtx = await gatherOperationalContext("fleet-management");
  assert.ok(fleetCtx.snapshot.logisticsReadiness);
  const driversSnap = (fleetCtx.snapshot.drivers ?? []) as Array<{
    name: string;
    days_to_expiry: string | null;
  }>;
  const regDrv = driversSnap.find((d) => d.name === "Regression Expired Driver");
  assert.ok(regDrv, "Registered driver should appear in fleet-management context");
  assert.ok(
    Number(regDrv!.days_to_expiry) < 0,
    `Expected negative days_to_expiry, got ${regDrv!.days_to_expiry}`,
  );

  // Regression: channel_contacts query without alias must succeed for support agents
  const contacts = await query<{ channel: string }>(
    `SELECT channel FROM channel_contacts ORDER BY last_seen_at DESC LIMIT 5`,
  );
  assert.ok(Array.isArray(contacts));
});

