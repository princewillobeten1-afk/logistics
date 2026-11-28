import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  classifyGeminiError,
  CORE_AGENTS,
  type CoreAgentId,
} from "./catalog";
import {
  DEFAULT_NVIDIA_MODEL,
  extractJsonObject,
  generateAgentJson,
  generateCorridorText,
  getActiveAiProvider,
  getServerGeminiKey,
  MissingGeminiKeyError,
  toStandardJsonSchema,
  Type,
} from "./gemini-client";
import {
  dispatchToAutonomousAgent,
  extractOrderFieldsFromText,
  processOmnichannelSupportTurn,
} from "./autonomous";
import { executeAgentTask, runFleetOptimizationWithGemini } from "./orchestrator";
import { handleFrontendLogisticsAction } from "../controllers/action-controller";
import { isHttpsRequest, type SessionUser } from "../auth";
import { sanitizeAuditEntityId, sanitizeAuditIp } from "../audit";
import { query, runWithOrgScope } from "../db";
import { openExceptions } from "../queries";

const ADMIN_USER: SessionUser = {
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-0000-0000-000000000001",
  orgName: "DHL LOGISTICS",
  email: "jaykvngs2@gmail.com",
  name: "Admin Operator",
  role: "ADMIN",
  departments: [],
  branchCodes: [],
};

const VIEWER_USER: SessionUser = {
  ...ADMIN_USER,
  id: "00000000-0000-4000-8000-000000000002",
  email: "viewer@example.com",
  role: "VIEWER",
};

const DISPATCHER_USER: SessionUser = {
  ...ADMIN_USER,
  id: "00000000-0000-4000-8000-000000000003",
  email: "dispatcher@example.com",
  role: "DISPATCHER",
};

const APPROVER_USER: SessionUser = {
  ...ADMIN_USER,
  id: "00000000-0000-4000-8000-000000000004",
  email: "approver@example.com",
  role: "APPROVER",
};

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    if (out && typeof (out as Promise<void>).then === "function") {
      return (out as Promise<void>).finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

test("toStandardJsonSchema converts Gemini-style schema to standard JSON Schema", () => {
  const schema = toStandardJsonSchema({
    type: Type.OBJECT,
    properties: {
      answer: { type: Type.STRING },
      nextStep: { type: Type.STRING, nullable: true },
      items: {
        type: Type.ARRAY,
        items: { type: Type.NUMBER },
      },
    },
    required: ["answer"],
  });

  assert.equal(schema.type, "object");
  const props = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.answer.type, "string");
  assert.deepEqual(props.nextStep.type, ["string", "null"]);
  assert.equal(props.items.type, "array");
  assert.equal((props.items.items as Record<string, unknown>).type, "number");
});

test("extractJsonObject strips reasoning tags and markdown fences cleanly", () => {
  const raw =
    '<think>checking lanes and SLA</think>\n```json\n{"summary":"All clear","confidence":0.94}\n```';
  const parsed = extractJsonObject<{ summary: string; confidence: number }>(raw);
  assert.equal(parsed.summary, "All clear");
  assert.equal(parsed.confidence, 0.94);

  assert.throws(() => extractJsonObject("   "), /empty structured output/i);
  assert.throws(() => extractJsonObject("plain text without json"), /non-JSON/i);
});

test("generateAgentJson routes to NVIDIA Nemotron 3.5 Super VL and falls back from json_schema 400 to json_object", async () => {
  const origFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const headers = init?.headers as Record<string, string>;
    calls.push({ url, body, auth: headers?.Authorization ?? null });

    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: "unsupported strict schema" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        model: DEFAULT_NVIDIA_MODEL,
        choices: [
          {
            message: {
              content: '<think>routing check</think>{"ok":true,"note":"nemotron"}',
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 45 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    await withEnv(
      {
        NVIDIA_API_KEY: "nvapi-test-token-1234",
        NVIDIA_BASE_URL: "https://integrate.api.nvidia.com/v1",
        GEMINI_API_KEY: undefined,
        AI_PROVIDER: undefined,
      },
      async () => {
        assert.equal(getActiveAiProvider(), "nvidia");
        assert.equal(getServerGeminiKey(), "nvapi-test-token-1234");

        const res = await generateAgentJson<{ ok: boolean; note: string }>({
          systemInstruction: "Test system",
          prompt: "Test prompt",
          thinkingDepth: "HIGH",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              ok: { type: Type.BOOLEAN },
              note: { type: Type.STRING },
            },
            required: ["ok", "note"],
          },
        });

        assert.equal(res.data.ok, true);
        assert.equal(res.data.note, "nemotron");
        assert.equal(res.meta.provider, "nvidia");
        assert.equal(res.meta.model, DEFAULT_NVIDIA_MODEL);
        assert.equal(res.meta.promptTokens, 120);
        assert.equal(res.meta.completionTokens, 45);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].url, "https://integrate.api.nvidia.com/v1/chat/completions");
        assert.equal(calls[0].auth, "Bearer nvapi-test-token-1234");
        assert.deepEqual(calls[0].body.chat_template_kwargs, { enable_thinking: true });
        assert.equal(
          (calls[0].body.response_format as Record<string, unknown>).type,
          "json_schema",
        );
        assert.equal(
          (calls[1].body.response_format as Record<string, unknown>).type,
          "json_object",
        );
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("generateAgentJson retries without thinking in json_object mode when reasoning output truncates JSON", async () => {
  const origFetch = globalThis.fetch;
  const calls: Array<{ body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ body });

    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          model: DEFAULT_NVIDIA_MODEL,
          choices: [
            {
              finish_reason: "length",
              message: {
                content: '{"summary":"Truncated mid-json',
                reasoning_content: "long reasoning trace...",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        model: DEFAULT_NVIDIA_MODEL,
        choices: [
          {
            finish_reason: "stop",
            message: { content: '{"ok":true,"note":"recovered"}' },
          },
        ],
        usage: { prompt_tokens: 90, completion_tokens: 20 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    await withEnv(
      {
        NVIDIA_API_KEY: "nvapi-test-retry-1234",
        GEMINI_API_KEY: undefined,
      },
      async () => {
        const res = await generateAgentJson<{ ok: boolean; note: string }>({
          systemInstruction: "Test system",
          prompt: "Test prompt",
          thinkingDepth: "MEDIUM",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              ok: { type: Type.BOOLEAN },
              note: { type: Type.STRING },
            },
            required: ["ok", "note"],
          },
        });
        assert.equal(res.data.ok, true);
        assert.equal(res.data.note, "recovered");
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0].body.chat_template_kwargs, { enable_thinking: true });
        assert.equal(calls[0].body.max_tokens, 8192);
        assert.deepEqual(calls[1].body.chat_template_kwargs, { enable_thinking: false });
        assert.equal(
          (calls[1].body.response_format as Record<string, unknown>).type,
          "json_object",
        );
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("generateAgentJson throws MissingGeminiKeyError when neither NVIDIA nor Gemini key is set", async () => {
  await withEnv(
    { NVIDIA_API_KEY: undefined, GEMINI_API_KEY: undefined, AI_PROVIDER: undefined },
    async () => {
      assert.equal(getActiveAiProvider(), null);
      assert.equal(getServerGeminiKey(), null);
      await assert.rejects(
        () =>
          generateAgentJson({
            systemInstruction: "sys",
            prompt: "hi",
            responseSchema: { type: Type.OBJECT },
          }),
        MissingGeminiKeyError,
      );
    },
  );
});

test("generateCorridorText works with NVIDIA Nemotron when GEMINI_API_KEY is unset", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        model: DEFAULT_NVIDIA_MODEL,
        choices: [
          {
            message: {
              content: "## Lagos -> Abuja Corridor\nUse Ibadan-Ilorin-Lokoja highway.",
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    await withEnv(
      { NVIDIA_API_KEY: "nvapi-corridor", GEMINI_API_KEY: undefined },
      async () => {
        const out = await generateCorridorText({
          prompt: "Assess Lagos to Abuja corridor",
          lat: 6.52,
          lng: 3.37,
        });
        assert.equal(out.provider, "nvidia");
        assert.equal(out.model, DEFAULT_NVIDIA_MODEL);
        assert.match(out.text, /Lokoja/);
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("all 15 core agents execute autonomously through NVIDIA Nemotron and record live model telemetry", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const reqBody = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ role: string; content: string }>;
    };
    const sys = reqBody.messages?.[0]?.content ?? "";
    const isOrchestrator = sys.includes('agent id: "orchestrator"');
    const content = isOrchestrator
      ? JSON.stringify({
          summary: "Orchestrator synthesized specialist domain findings.",
          findings: ["All active corridors inspected"],
          recommendedActions: [
            {
              title: "Review pending approval",
              detail: "Check spend gate before booking.",
              priority: "HIGH",
              ownerAgentId: "human-escalation",
              targetRoute: "/approvals",
            },
          ],
          delegations: [
            {
              agentId: "exception-resolution",
              agentName: "Exception Handling & Resolution Agent",
              task: "Audit open exceptions",
              finding: "Exception queue triaged cleanly.",
            },
          ],
          requiresHumanApproval: false,
          escalationReason: null,
          confidence: 0.91,
        })
      : JSON.stringify({
          summary: "Specialist audit complete.",
          findings: ["Verified active shipments and constraints."],
          recommendedActions: [
            {
              title: "Monitor corridor",
              detail: "Keep tracking telemetry active.",
              priority: "MEDIUM",
              ownerAgentId: "shipment-tracking",
              targetRoute: "/shipments",
            },
          ],
          requiresHumanApproval: false,
          escalationReason: null,
          confidence: 0.89,
        });

    return new Response(
      JSON.stringify({
        model: DEFAULT_NVIDIA_MODEL,
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 200, completion_tokens: 90 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    await withEnv(
      { NVIDIA_API_KEY: "nvapi-agents-suite", GEMINI_API_KEY: undefined },
      async () => {
        assert.equal(CORE_AGENTS.length, 15);
        await runWithOrgScope(ADMIN_USER.orgId, async () => {
          for (const agent of CORE_AGENTS) {
            const out = await executeAgentTask({
              agentId: agent.id as CoreAgentId,
              task: agent.quickPrompts[0],
              actorEmail: ADMIN_USER.email,
            });
            assert.equal(out.agent.id, agent.id);
            assert.equal(out.meta.model, DEFAULT_NVIDIA_MODEL);
            assert.ok(out.result.summary.length > 0);
            assert.ok(out.result.confidence >= 0.05 && out.result.confidence <= 1);
            if (agent.id === "orchestrator") {
              assert.ok(
                Array.isArray(out.result.delegations) && out.result.delegations.length > 0,
              );
            }
          }
        });
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("extractOrderFieldsFromText recognizes multi-carrier logistics tracking numbers (WPCargo, DHL, Maersk, CX, LG, DEMO)", () => {
  assert.equal(
    extractOrderFieldsFromText("Track shipment 0576420 please").shipmentReference,
    "0576420",
  );
  assert.equal(
    extractOrderFieldsFromText("Status of container MSKU1234567").shipmentReference,
    "MSKU1234567",
  );
  assert.equal(
    extractOrderFieldsFromText("Where is CX-9A1F2B right now?").shipmentReference,
    "CX-9A1F2B",
  );
  assert.equal(
    extractOrderFieldsFromText("Update on DEMO-001").shipmentReference,
    "DEMO-001",
  );
  assert.equal(
    extractOrderFieldsFromText("Check tracking number 1234567890").shipmentReference,
    "1234567890",
  );
  assert.equal(
    extractOrderFieldsFromText("Waybill WP-TRK-771234 delayed").shipmentReference,
    "WP-TRK-771234",
  );
  assert.equal(
    extractOrderFieldsFromText("Track 0666457").shipmentReference,
    "0666457",
  );
  assert.equal(
    extractOrderFieldsFromText("Where is 0666457?").shipmentReference,
    "0666457",
  );
  assert.equal(
    extractOrderFieldsFromText("Book 45 cartons of electronics (450 kg) from Lagos to Abuja").shipmentReference,
    undefined,
  );
});

test("dispatchToAutonomousAgent enqueues PENDING planning.plan & wpcargo.sync and merges replan without losing plan fields", async () => {
  await withEnv({ NVIDIA_API_KEY: undefined, GEMINI_API_KEY: undefined }, async () => {
    await runWithOrgScope(ADMIN_USER.orgId, async () => {
      const created = await dispatchToAutonomousAgent({
        sourceChannel: "WEB_FORM_ORDER",
        message: "Ship 25 cartons of routers (400 kg) from Lagos to Accra",
        orgId: ADMIN_USER.orgId,
        actorEmail: ADMIN_USER.email,
        structured: {
          originCity: "Lagos",
          destinationCity: "Accra",
          cargoDescription: "Network routers",
          weightKg: 400,
          quantity: 25,
        },
      });
      assert.ok(created.shipmentReference);
      assert.ok(created.shipmentId);

      const pendingItems = await query<{ kind: string; state: string; reference: string | null }>(
        `SELECT w.id, w.kind, w.state, s.reference
           FROM work_items w
           LEFT JOIN shipments s ON s.id = w.shipment_id
          WHERE w.state IN ('PENDING','RUNNING')`,
      );
      const forShipment = pendingItems.filter(
        (w) => w.reference === created.shipmentReference,
      );
      assert.ok(
        forShipment.some((w) => w.kind === "planning.plan" && w.state === "PENDING"),
        "New shipment must enqueue PENDING planning.plan for Python cuOpt worker",
      );
      assert.ok(
        forShipment.some((w) => w.kind === "wpcargo.sync" && w.state === "PENDING"),
        "New shipment must enqueue PENDING wpcargo.sync for WPCargo portal registration",
      );

      // Replan must merge plan JSONB, preserving lane_label/distance_km
      const replanned = await dispatchToAutonomousAgent({
        sourceChannel: "WEB_FORM_PLANNING",
        intentHint: "PLANNING_ROUTING",
        message: `Reroute ${created.shipmentReference} via expressway`,
        reference: created.shipmentReference,
        orgId: ADMIN_USER.orgId,
        actorEmail: ADMIN_USER.email,
        structured: { preferredMode: "ROAD", notes: "Avoid Apapa congestion" },
      });
      assert.equal(replanned.shipmentReference, created.shipmentReference);

      const rows = await query<{
        reference: string;
        plan: Record<string, unknown>;
      }>(`SELECT reference, state, origin, destination, plan, booking FROM shipments WHERE upper(reference) = $1 LIMIT 1`, [
        created.shipmentReference.toUpperCase(),
      ]);
      assert.equal(rows[0].plan.lane_label, "Lagos → Accra");
      assert.equal(rows[0].plan.reroute_requested, true);

      // Duplicate exception reports must deduplicate cleanly instead of failing
      await dispatchToAutonomousAgent({
        sourceChannel: "WEBSITE_CHAT",
        intentHint: "EXCEPTION_REPORT",
        message: `Damaged cartons reported on ${created.shipmentReference}`,
        reference: created.shipmentReference,
        orgId: ADMIN_USER.orgId,
        actorEmail: ADMIN_USER.email,
      });
      await dispatchToAutonomousAgent({
        sourceChannel: "WEBSITE_CHAT",
        intentHint: "EXCEPTION_REPORT",
        message: `Second follow-up on damage for ${created.shipmentReference}`,
        reference: created.shipmentReference,
        orgId: ADMIN_USER.orgId,
        actorEmail: ADMIN_USER.email,
      });
      const excs = (await openExceptions()).filter(
        (e) => e.reference === created.shipmentReference && e.kind === "CUSTOMER_REPORTED",
      );
      assert.equal(excs.length, 1, "Duplicate customer exception reports must upsert one open exception");

      const afterExcWork = await query<{ kind: string; state: string; reference: string | null }>(
        `SELECT w.id, w.kind, w.state, s.reference
           FROM work_items w
           LEFT JOIN shipments s ON s.id = w.shipment_id
          WHERE w.state IN ('PENDING','RUNNING')`,
      );
      assert.ok(
        afterExcWork.some(
          (w) =>
            w.reference === created.shipmentReference &&
            w.kind === "exception.investigate" &&
            w.state === "PENDING",
        ),
        "Exception report must enqueue PENDING exception.investigate for Python Exception Agent",
      );
    });
  });
});

test("processOmnichannelSupportTurn answers tracking safely offline without leaking internal error strings", async () => {
  await withEnv({ NVIDIA_API_KEY: undefined, GEMINI_API_KEY: undefined }, async () => {
    const created = await dispatchToAutonomousAgent({
      sourceChannel: "WEB_FORM_ORDER",
      message: "Seed shipment for offline tracking test",
      orgId: ADMIN_USER.orgId,
      structured: {
        customerName: "Chidi Logistics",
        originCity: "Lagos",
        destinationCity: "Abuja",
        cargoDescription: "Network switches",
        weightKg: 140,
      },
    });
    assert.ok(created.shipmentReference);

    const foundOut = await processOmnichannelSupportTurn({
      sourceChannel: "WHATSAPP",
      externalId: "+2348012345678",
      displayName: "Chidi Logistics",
      message: `Where is shipment ${created.shipmentReference}?`,
      orgId: ADMIN_USER.orgId,
    });
    assert.equal(foundOut.ok, true);
    assert.equal(foundOut.reference, created.shipmentReference);
    assert.ok(foundOut.reply && foundOut.reply.includes(created.shipmentReference!));
    assert.ok(foundOut.reply.includes("Lagos to Abuja"));
    assert.equal(foundOut.reply.includes("GEMINI_API_KEY"), false);
    assert.equal(foundOut.reply.includes("NVIDIA_API_KEY"), false);

    const missingOut = await processOmnichannelSupportTurn({
      sourceChannel: "WHATSAPP",
      externalId: "+2348012345678",
      displayName: "Chidi Logistics",
      message: "Where is shipment LG-82931?",
      orgId: ADMIN_USER.orgId,
    });
    assert.equal(missingOut.ok, true);
    assert.equal(missingOut.reference, null);
    assert.equal(missingOut.orderReference, null);
    assert.equal(missingOut.autonomous?.startedWork, false);
    assert.ok(missingOut.reply && missingOut.reply.includes("LG-82931"));
    assert.equal(missingOut.reply.includes("GEMINI_API_KEY"), false);
    assert.equal(missingOut.reply.includes("NVIDIA_API_KEY"), false);

    const missingWebOut = await processOmnichannelSupportTurn({
      sourceChannel: "WEBSITE_CHAT",
      externalId: "portal:track-unknown",
      displayName: "Portal User",
      message: "Where is my shipment 0666457?",
      orgId: ADMIN_USER.orgId,
    });
    assert.equal(missingWebOut.ok, true);
    assert.equal(missingWebOut.reference, null);
    assert.equal(missingWebOut.orderReference, null);
    assert.equal(missingWebOut.autonomous?.startedWork, false);
    assert.ok(missingWebOut.reply && missingWebOut.reply.includes("0666457"));

    // Unknown shipment with delay/exception wording must NOT start delegation work or lie
    const missingDelayedOut = await processOmnichannelSupportTurn({
      sourceChannel: "WEBSITE_CHAT",
      externalId: "portal:track-unknown-delay",
      displayName: "Portal User",
      message: "Why is shipment 0666457 delayed?",
      orgId: ADMIN_USER.orgId,
    });
    assert.equal(missingDelayedOut.ok, true);
    assert.equal(missingDelayedOut.reference, null);
    assert.equal(missingDelayedOut.orderReference, null);
    assert.equal(missingDelayedOut.autonomous?.startedWork, false);
    assert.ok(missingDelayedOut.reply && missingDelayedOut.reply.includes("0666457"));
    assert.equal(missingDelayedOut.reply.includes("has been logged"), false);

    // Explicit reference in message overrides sticky session reference
    const overrideStickyOut = await processOmnichannelSupportTurn({
      sourceChannel: "WEBSITE_CHAT",
      externalId: "portal:track-sticky",
      displayName: "Portal User",
      message: "Where is my shipment 0666457?",
      reference: created.shipmentReference,
      orgId: ADMIN_USER.orgId,
    });
    assert.equal(overrideStickyOut.ok, true);
    assert.equal(overrideStickyOut.reference, null);
    assert.equal(overrideStickyOut.orderReference, null);
    assert.equal(overrideStickyOut.autonomous?.startedWork, false);
    assert.ok(overrideStickyOut.reply && overrideStickyOut.reply.includes("0666457"));
  });
});

test("handleFrontendLogisticsAction enforces RBAC across intents and uses per-org work_items ON CONFLICT", async () => {
  // Unauthenticated -> 401
  const unauth = await handleFrontendLogisticsAction(
    {
      intent: "NEW_ORDER",
      payload: { originCity: "Lagos", destinationCity: "Abuja", cargoDescription: "Servers" },
    },
    { resolveUser: async () => null },
  );
  assert.equal(unauth.ok, false);
  assert.equal(unauth.status, 401);

  // VIEWER blocked from mutating NEW_ORDER -> 403
  const viewerOrder = await handleFrontendLogisticsAction(
    {
      intent: "NEW_ORDER",
      payload: { originCity: "Lagos", destinationCity: "Abuja", cargoDescription: "Servers" },
    },
    { resolveUser: async () => VIEWER_USER },
  );
  assert.equal(viewerOrder.ok, false);
  assert.equal(viewerOrder.status, 403);

  // VIEWER blocked from AUTO that classifies as mutating NEW_ORDER -> 403
  const viewerAuto = await handleFrontendLogisticsAction(
    {
      intent: "AUTO",
      payload: { message: "Book 10 pallets from Lagos to Kano" },
    },
    { resolveUser: async () => VIEWER_USER },
  );
  assert.equal(viewerAuto.ok, false);
  assert.equal(viewerAuto.status, 403);

  // DISPATCHER blocked from APPROVAL_DECISION -> 403
  const dispApprove = await handleFrontendLogisticsAction(
    {
      intent: "APPROVAL_DECISION",
      payload: { token: "tok-123", decision: "approve" },
    },
    { resolveUser: async () => DISPATCHER_USER },
  );
  assert.equal(dispApprove.ok, false);
  assert.equal(dispApprove.status, 403);

  // APPROVER blocked from arranging shipments (NEW_ORDER) -> 403
  const approverOrder = await handleFrontendLogisticsAction(
    {
      intent: "NEW_ORDER",
      payload: { originCity: "Lagos", destinationCity: "Abuja", cargoDescription: "Servers" },
    },
    { resolveUser: async () => APPROVER_USER },
  );
  assert.equal(approverOrder.ok, false);
  assert.equal(approverOrder.status, 403);

  // Regression guard: migration 019 requires ON CONFLICT (org_id, dedupe_key) everywhere
  const controllerSrc = readFileSync(
    path.join(process.cwd(), "lib", "controllers", "action-controller.ts"),
    "utf8",
  );
  assert.equal(
    /ON CONFLICT\s*\(\s*dedupe_key\s*\)/i.test(controllerSrc),
    false,
    "action-controller.ts must never use global ON CONFLICT (dedupe_key) after migration 019",
  );
});

test("runFleetOptimizationWithGemini never double-assigns vehicles or violates hazmat/reefer/capacity rules", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        model: DEFAULT_NVIDIA_MODEL,
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Fleet optimization evaluated.",
                findings: ["Checked capacities and compliance."],
                recommendedActions: [],
                delegations: [
                  {
                    agentId: "route-optimization",
                    agentName: "Route Optimization Agent",
                    task: "Optimize routes",
                    finding: "Routes checked",
                  },
                  {
                    agentId: "fleet-management",
                    agentName: "Fleet Management Agent",
                    task: "Check vehicles",
                    finding: "Compliance checked",
                  },
                ],
                shipmentUpdates: [],
                requiresHumanApproval: false,
                escalationReason: null,
                confidence: 0.9,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 60 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    await withEnv(
      { NVIDIA_API_KEY: "nvapi-fleet-test", GEMINI_API_KEY: undefined },
      async () => {
        const res = await runWithOrgScope(ADMIN_USER.orgId, () =>
          runFleetOptimizationWithGemini(),
        );
        assert.equal(res.meta.model, DEFAULT_NVIDIA_MODEL);
        assert.ok(res.result.summary.length > 0);
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("isHttpsRequest treats local http://localhost production servers as HTTP so session cookies persist", () => {
  withEnv({ NODE_ENV: "production", APP_URL: undefined }, () => {
    const localHeaders = new Headers({ host: "localhost:3002" });
    assert.equal(isHttpsRequest(localHeaders), false);

    const loopbackHeaders = new Headers({ host: "127.0.0.1:3002" });
    assert.equal(isHttpsRequest(loopbackHeaders), false);

    const httpsProxyHeaders = new Headers({
      host: "tower.example.com",
      "x-forwarded-proto": "https",
    });
    assert.equal(isHttpsRequest(httpsProxyHeaders), true);

    const cloudRunHeaders = new Headers({
      host: "logistics-abc.a.run.app",
    });
    assert.equal(isHttpsRequest(cloudRunHeaders), true);
  });
});

test("audit sanitizers reject non-UUID entity IDs (e.g. Gmail IDs) and invalid IPs, and error redaction strips nvapi keys", () => {
  assert.equal(sanitizeAuditEntityId("18e9c1b2a3d4e5f6"), null);
  assert.equal(
    sanitizeAuditEntityId("550e8400-e29b-41d4-a716-446655440000"),
    "550e8400-e29b-41d4-a716-446655440000",
  );
  assert.equal(sanitizeAuditIp("203.0.113.10, 10.0.0.1"), "203.0.113.10");
  assert.equal(sanitizeAuditIp("not-an-ip"), null);

  const errInfo = classifyGeminiError(
    new Error("Upstream failure with key nvapi-SecretValue1234567890"),
  );
  assert.equal(errInfo.message.includes("nvapi-SecretValue"), false);
  assert.ok(errInfo.message.includes("[REDACTED]"));
});
