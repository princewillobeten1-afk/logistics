import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_DOMAINS,
  BACKEND_WORKFLOW_AGENT_MAP,
  CORE_AGENTS,
  classifyGeminiError,
  filterAgentsByDomain,
  getAgentById,
  getAgentForBackendWorkflow,
  getAgentsForRoute,
  normalizeAgentRunOutput,
  selectOrchestratorSpecialists,
  type BackendWorkflow,
} from "./catalog";

test("catalog defines all 11 operational domains and all 15 core agents", () => {
  assert.equal(AGENT_DOMAINS.length, 11);
  assert.equal(CORE_AGENTS.length, 15);
  assert.equal(CORE_AGENTS[0].id, "orchestrator");
  assert.equal(CORE_AGENTS[14].id, "human-escalation");

  const uniqueIds = new Set(CORE_AGENTS.map((a) => a.id));
  assert.equal(uniqueIds.size, 15);
});

test("filterAgentsByDomain covers primary and secondary domains cleanly", () => {
  const all = filterAgentsByDomain("all");
  assert.equal(all.length, 15);

  const security = filterAgentsByDomain("security_compliance");
  assert.ok(security.some((a) => a.id === "workflow-automation"));
  assert.ok(security.some((a) => a.id === "human-escalation"));

  const orchestration = filterAgentsByDomain("orchestration");
  assert.equal(orchestration.length, 2);
});

test("all 15 core agents route to backend workflows and zero expose /agents frontend UI", () => {
  assert.equal(getAgentsForRoute("/exceptions").map((a) => a.id)[0], "exception-resolution");
  assert.equal(getAgentsForRoute("/approvals").map((a) => a.id)[0], "human-escalation");
  assert.equal(getAgentsForRoute("/analytics").length, 2);
  assert.ok(getAgentById("route-optimization"));
  assert.equal(CORE_AGENTS.some((a) => a.targetRoute === "/agents"), false);

  const workflows = Object.keys(BACKEND_WORKFLOW_AGENT_MAP) as BackendWorkflow[];
  assert.equal(workflows.length, 15);
  const mappedAgents = new Set(workflows.map((wf) => getAgentForBackendWorkflow(wf).id));
  assert.equal(mappedAgents.size, 15);
});

test("selectOrchestratorSpecialists delegates cleanly to matching domain specialists", () => {
  const picked = selectOrchestratorSpecialists(
    "Audit active exceptions and pending approvals across corridors",
  );
  assert.equal(picked.length, 2);
  assert.equal(picked[0].agentId, "exception-resolution");
  assert.equal(picked[1].agentId, "human-escalation");

  const fallback = selectOrchestratorSpecialists("General floor check", {
    openExceptions: 1,
    pendingApprovals: 1,
  });
  assert.equal(fallback.length, 2);
  assert.ok(fallback.every((item) => item.agentId !== "orchestrator"));
});

test("normalizeAgentRunOutput sanitizes partial or malformed payloads safely", () => {
  const normalized = normalizeAgentRunOutput(
    {
      summary: "  LG-82931 needs urgent re-allocation. ",
      findings: ["Stock tight at LOS", "", null],
      recommendedActions: [
        {
          title: "Approve carrier quote",
          detail: "Review pending approval ap-1",
          priority: "high",
          shipmentReference: "lg-82931",
          targetRoute: "/approvals",
        },
        {
          title: "",
          detail: "",
        },
      ],
      requiresHumanApproval: 1,
      escalationReason: "Exceeds auto-approve spend limit",
      confidence: 92,
    },
    "exception-resolution",
  );

  assert.equal(normalized.summary, "LG-82931 needs urgent re-allocation.");
  assert.deepEqual(normalized.findings, ["Stock tight at LOS"]);
  assert.equal(normalized.recommendedActions.length, 1);
  assert.equal(normalized.recommendedActions[0].priority, "HIGH");
  assert.equal(normalized.recommendedActions[0].shipmentReference, "LG-82931");
  assert.equal(normalized.requiresHumanApproval, true);
  assert.equal(normalized.confidence, 0.92);
});

test("classifyGeminiError identifies quota and auth errors accurately", () => {
  const quota = classifyGeminiError(Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429 }));
  assert.equal(quota.status, 429);
  assert.equal(quota.quotaExceeded, true);

  const auth = classifyGeminiError(Object.assign(new Error("API_KEY_INVALID"), { status: 400 }));
  assert.equal(auth.status, 400);
  assert.equal(auth.quotaExceeded, false);
});
