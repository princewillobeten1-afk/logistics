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
