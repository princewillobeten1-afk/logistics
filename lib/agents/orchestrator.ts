import { Type, type Schema } from "@google/genai";
import { query } from "@/lib/db";
import {
  AGENT_DOMAINS,
  CORE_AGENTS,
  getAgentById,
  getDomainById,
  normalizeAgentRunOutput,
  selectOrchestratorSpecialists,
  type AgentRunStructuredResult,
  type CoreAgentDefinition,
  type CoreAgentId,
} from "./catalog";
import { gatherOperationalContext } from "./context";
import {
  AGENT_GEMINI_MODEL,
  generateAgentJson,
  type GeminiGenerationMeta,
} from "./gemini-client";

const AGENT_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: "Concise 2-3 sentence executive summary grounded in the provided operational snapshot.",
    },
    findings: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "3 to 6 concrete factual findings citing shipment references, carrier codes, SKUs, vehicles, or metrics.",
    },
    recommendedActions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          detail: { type: Type.STRING },
          priority: {
            type: Type.STRING,
            enum: ["HIGH", "MEDIUM", "LOW"],
          },
          ownerAgentId: { type: Type.STRING },
          targetRoute: { type: Type.STRING },
          shipmentReference: { type: Type.STRING },
        },
        required: ["title", "detail", "priority", "ownerAgentId"],
      },
    },
    requiresHumanApproval: { type: Type.BOOLEAN },
    escalationReason: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER },
  },
  required: ["summary", "findings", "recommendedActions", "requiresHumanApproval", "confidence"],
};

const ORCHESTRATED_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    ...AGENT_RESPONSE_SCHEMA.properties,
    delegations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          agentId: { type: Type.STRING },
          agentName: { type: Type.STRING },
          task: { type: Type.STRING },
          finding: { type: Type.STRING },
        },
        required: ["agentId", "agentName", "task", "finding"],
      },
      description: "Specialist agent reports synthesized into the orchestrator plan.",
    },
  },
  required: [
    "summary",
    "findings",
    "recommendedActions",
    "delegations",
    "requiresHumanApproval",
    "confidence",
  ],
};

const FLEET_OPTIMIZATION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    ...ORCHESTRATED_RESPONSE_SCHEMA.properties,
    shipmentUpdates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          reference: { type: Type.STRING },
          assignedVehicle: { type: Type.STRING, nullable: true },
          transitHours: { type: Type.NUMBER, nullable: true },
          meetsDeadline: { type: Type.BOOLEAN, nullable: true },
        },
        required: ["reference"],
      },
      description: "Validated route and vehicle assignment updates for active ALLOCATED, PLANNED, or SOURCING shipments.",
    },
  },
  required: [
    "summary",
    "findings",
    "recommendedActions",
    "delegations",
    "requiresHumanApproval",
    "confidence",
  ],
};

const SHIPMENT_ASSISTANT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    answer: {
      type: Type.STRING,
      description: "Clear, factual operator answer referencing shipment state, events, legs, quotes, or policy gates.",
    },
    nextStep: {
      type: Type.STRING,
      nullable: true,
      description: "One concrete recommended next operational step, if applicable.",
    },
    confidence: { type: Type.NUMBER },
  },
  required: ["answer", "confidence"],
};

const SUPPORT_REPLY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    reply: {
      type: Type.STRING,
      description:
        "Polite, accurate customer-facing response using strictly allowlisted facts (never internal buy rates, margins, or internal agent names).",
    },
    shouldEscalate: {
      type: Type.BOOLEAN,
      description:
        "True if customer reports damage/complaint/refund/lost cargo or asks for a human specialist.",
    },
    escalationReason: {
      type: Type.STRING,
      nullable: true,
    },
    confidence: { type: Type.NUMBER },
    autonomousHandoff: {
      type: Type.OBJECT,
      description:
        "Structured handoff instructions for the central Autonomous Agent to route and start work immediately.",
      properties: {
        shouldDispatch: {
          type: Type.BOOLEAN,
          description:
            "True whenever the message involves ordering/booking a shipment, changing a route/plan/deadline, reporting a delay/exception, customs/documents, billing/invoice, or shipment follow-up work.",
        },
        intent: {
          type: Type.STRING,
          enum: [
            "NEW_ORDER",
            "SHIPMENT_ACTION",
            "PLANNING_ROUTING",
            "EXCEPTION_REPORT",
            "CUSTOMS_DOCS",
            "BILLING_INVOICE",
            "TRACKING_INQUIRY",
          ],
        },
        taskSummary: {
          type: Type.STRING,
          description: "Concise operational summary for the AI Orchestrator Agent.",
        },
        shipmentReference: { type: Type.STRING, nullable: true },
        originCity: { type: Type.STRING, nullable: true },
        destinationCity: { type: Type.STRING, nullable: true },
        cargoDescription: { type: Type.STRING, nullable: true },
        weightKg: { type: Type.NUMBER, nullable: true },
        quantity: { type: Type.NUMBER, nullable: true },
        deadlineIso: { type: Type.STRING, nullable: true },
        customerName: { type: Type.STRING, nullable: true },
        hazmat: { type: Type.BOOLEAN, nullable: true },
        reefer: { type: Type.BOOLEAN, nullable: true },
        missingFields: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
      },
      required: ["shouldDispatch", "intent", "taskSummary"],
    },
  },
  required: ["reply", "shouldEscalate", "confidence", "autonomousHandoff"],
};

async function recordAgentRun({
  shipmentId,
  agent,
  job,
  model,
  status,
  latencyMs,
  promptTokens,
  completionTokens,
  reasoning,
  text,
}: {
  shipmentId: string | null;
  agent: string;
  job: string;
  model: string;
  status: "OK" | "ERROR";
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoning: string | null;
  text: string | null;
}) {
  try {
    await query(
      `INSERT INTO agent_runs
         (shipment_id, agent, job, model, status, latency_ms, prompt_tokens, completion_tokens, response)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        shipmentId,
        agent,
        job,
        model,
        status,
        latencyMs,
        promptTokens,
        completionTokens,
        JSON.stringify({ reasoning, text }),
      ],
    );
  } catch (err) {
    console.warn("[Agents] Failed to record agent_runs entry:", err);
  }
}

function buildSpecialistSystemInstruction(agent: CoreAgentDefinition): string {
  const domain = getDomainById(agent.domainId);
  const subRoles = domain ? domain.subRoles.join(", ") : "";
  return [
    `You are the "${agent.name}" (agent id: "${agent.id}") in an AI Logistics Control Tower Operations Platform.`,
    domain ? `Domain: #${domain.number} ${domain.name} (${subRoles}).` : "",
    `Primary Role: ${agent.primaryRole}`,
    `Core Capabilities: ${agent.capabilities.join("; ")}.`,
    `Target Frontend Workspace: ${agent.targetRoute} (${agent.targetLabel}).`,
    "Instructions:",
    "- Base every finding and recommendation strictly on the live operational JSON snapshot provided.",
    "- Be concise: write 1-2 short sentences for summary, 2-4 crisp bullet findings, and 2-4 prioritized recommendedActions.",
    "- Never invent shipment references, carrier codes, or dollar/NGN figures not present in the snapshot.",
    "- When customer experience or communication is involved, never expose internal buy rates, margins, or internal operator-only policy rationales.",
    "- If spending limits, unapproved carriers, hazmat/customs holds, expired driver licences, or critical SLA exceptions are present, set requiresHumanApproval=true and explain escalationReason.",
    "- Set targetRoute on each recommendedAction to a valid app route (e.g. /shipments, /planning, /exceptions, /approvals, /carriers, /fleet, /warehouses, /orders, /customers, /documents, /analytics, /support, /map).",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface ExecuteAgentTaskOutput {
  agent: CoreAgentDefinition;
  result: AgentRunStructuredResult;
  meta: GeminiGenerationMeta;
  resolvedReference: string | null;
}

export async function executeAgentTask({
  agentId,
  task,
  reference,
  actorEmail,
}: {
  agentId: CoreAgentId;
  task: string;
  reference?: string;
  actorEmail?: string | null;
}): Promise<ExecuteAgentTaskOutput> {
  const agent = getAgentById(agentId);
  if (!agent) {
    throw new Error(`Unknown agent id: ${agentId}`);
  }

  const trimmedTask = task.trim() || agent.quickPrompts[0];
  const { snapshot, shipmentId, resolvedReference } = await gatherOperationalContext(
    agentId,
    reference,
  );

  // Orchestrator performs deterministic specialist delegation + multi-domain Gemini synthesis
  if (agent.id === "orchestrator") {
    const startedAt = Date.now();
    const openExc = Array.isArray(snapshot.openExceptions) ? snapshot.openExceptions.length : 0;
    const pendingApp = Array.isArray(snapshot.pendingApprovals) ? snapshot.pendingApprovals.length : 0;
    const stalled = Array.isArray(snapshot.stalledDeadWork) ? snapshot.stalledDeadWork.length : 0;

    const plannedSpecialists = selectOrchestratorSpecialists(trimmedTask, {
      openExceptions: openExc,
      pendingApprovals: pendingApp,
      stalledWork: stalled,
    });

    const uniqueSpecialists = plannedSpecialists
      .map((item) => ({
        def: getAgentById(item.agentId),
        subtask: item.subtask,
      }))
      .filter(
        (item): item is { def: CoreAgentDefinition; subtask: string } =>
          Boolean(item.def) && item.def!.id !== "orchestrator",
      );

    const specialistContexts = await Promise.all(
      uniqueSpecialists.map(async ({ def, subtask }) => {
        const sharesOrchestratorScope =
          def.id === "exception-resolution" || def.id === "human-escalation";
        const subCtx = sharesOrchestratorScope
          ? { snapshot: null, shipmentId, resolvedReference }
          : await gatherOperationalContext(def.id, reference);
        return { def, subtask, subCtx };
      }),
    );

    const orchestrationRes = await generateAgentJson<Record<string, unknown>>({
      thinkingDepth: "LOW",
      systemInstruction: [
        buildSpecialistSystemInstruction(agent),
        "In the delegations array, include one structured report for every assigned specialist agent using their exact agentId, agentName, and task, grounded strictly in the operational snapshot.",
      ].join("\n"),
      prompt: JSON.stringify({
        operatorRequest: trimmedTask,
        focusReference: resolvedReference,
        assignedSpecialists: specialistContexts.map(({ def, subtask, subCtx }) => ({
          agentId: def.id,
          agentName: def.name,
          primaryRole: def.primaryRole,
          assignedSubtask: subtask,
          ...(subCtx.snapshot ? { domainSnapshot: subCtx.snapshot } : {}),
        })),
        operationalSnapshot: snapshot,
      }),
      responseSchema: ORCHESTRATED_RESPONSE_SCHEMA,
    });

    const finalResult = normalizeAgentRunOutput(orchestrationRes.data, agent.id);
    if (!finalResult.delegations || finalResult.delegations.length === 0) {
      finalResult.delegations = specialistContexts.map(({ def, subtask }) => ({
        agentId: def.id,
        agentName: def.name,
        task: subtask,
        finding: finalResult.summary,
      }));
    }

    const totalLatency = Math.max(1, Date.now() - startedAt);
    const totalPromptTokens = orchestrationRes.meta.promptTokens ?? null;
    const totalCompletionTokens = orchestrationRes.meta.completionTokens ?? null;

    await Promise.all([
      ...finalResult.delegations.map((del) => {
        const match = specialistContexts.find((s) => s.def.id === del.agentId);
        return recordAgentRun({
          shipmentId: match?.subCtx.shipmentId ?? shipmentId,
          agent: del.agentId,
          job: `Delegated: ${del.task.slice(0, 72)}`,
          model: AGENT_GEMINI_MODEL,
          status: "OK",
          latencyMs: totalLatency,
          promptTokens: null,
          completionTokens: null,
          reasoning: del.finding,
          text: del.finding,
        });
      }),
      recordAgentRun({
        shipmentId,
        agent: agent.id,
        job: trimmedTask.slice(0, 96),
        model: AGENT_GEMINI_MODEL,
        status: "OK",
        latencyMs: totalLatency,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        reasoning: finalResult.summary,
        text: JSON.stringify(finalResult.delegations),
      }),
    ]);

    if (actorEmail) {
      try {
        await query(
          `INSERT INTO audit_logs (actor, actor_type, action, entity_type)
           VALUES ($1, 'USER', 'AGENT_ORCHESTRATED', $2)`,
          [actorEmail, resolvedReference ?? "control_tower"],
        );
      } catch {
        // Non-fatal audit logging
      }
    }

    return {
      agent,
      result: finalResult,
      meta: {
        model: AGENT_GEMINI_MODEL,
        latencyMs: totalLatency,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
      },
      resolvedReference,
    };
  }

  // Single specialist agent execution
  const res = await generateAgentJson<Record<string, unknown>>({
    thinkingDepth: agent.thinkingDepth,
    systemInstruction: buildSpecialistSystemInstruction(agent),
    prompt: JSON.stringify({
      task: trimmedTask,
      focusReference: resolvedReference,
      domainsCovered: AGENT_DOMAINS.length,
      operationalData: snapshot,
    }),
    responseSchema: AGENT_RESPONSE_SCHEMA,
  });

  const normalized = normalizeAgentRunOutput(res.data, agent.id);

  await recordAgentRun({
    shipmentId,
    agent: agent.id,
    job: trimmedTask.slice(0, 96),
    model: res.meta.model,
    status: "OK",
    latencyMs: res.meta.latencyMs,
    promptTokens: res.meta.promptTokens,
    completionTokens: res.meta.completionTokens,
    reasoning: normalized.summary,
    text: normalized.findings.join(" | "),
  });

  return {
    agent,
    result: normalized,
    meta: res.meta,
    resolvedReference,
  };
}

export async function runShipmentAssistantWithGemini({
  reference,
  shipmentId,
  question,
}: {
  reference: string;
  shipmentId: string;
  question: string;
}): Promise<{
  answer: string;
  nextStep: string | null;
  confidence: number;
  meta: GeminiGenerationMeta;
}> {
  const { snapshot } = await gatherOperationalContext("shipment-management", reference);
  const compactContext = {
    focusShipment: snapshot.focusShipment ?? null,
    openExceptions: Array.isArray(snapshot.openExceptions)
      ? snapshot.openExceptions.filter(
          (e: Record<string, unknown>) =>
            String(e.reference ?? "").toUpperCase() === reference.toUpperCase(),
        )
      : [],
  };

  const res = await generateAgentJson<{
    answer: string;
    nextStep?: string | null;
    confidence: number;
  }>({
    thinkingDepth: "LOW",
    systemInstruction: [
      "You are the Shipment Management & Exception Copilot inside the Control Tower shipment detail view.",
      "Answer operator questions concisely and accurately using the shipment record, state events, legs, carrier quotes, and open exceptions.",
      "You are read-only: explain clearly and suggest the single best next operational step.",
      "Never fabricate quotes, events, or carrier names.",
    ].join("\n"),
    prompt: JSON.stringify({
      shipmentReference: reference,
      operatorQuestion: question,
      shipmentContext: compactContext,
    }),
    responseSchema: SHIPMENT_ASSISTANT_SCHEMA,
  });

  const confidence = Number.isFinite(Number(res.data.confidence))
    ? Math.max(0.05, Math.min(1, Number(res.data.confidence) > 1 ? Number(res.data.confidence) / 100 : Number(res.data.confidence)))
    : 0.88;
  const nextStep = res.data.nextStep?.trim() || null;

  await recordAgentRun({
    shipmentId,
    agent: "shipment-management",
    job: "Explain shipment state",
    model: res.meta.model,
    status: "OK",
    latencyMs: res.meta.latencyMs,
    promptTokens: res.meta.promptTokens,
    completionTokens: res.meta.completionTokens,
    reasoning: nextStep ?? res.data.answer.slice(0, 140),
    text: res.data.answer,
  });

  return {
    answer: res.data.answer.trim(),
    nextStep,
    confidence,
    meta: res.meta,
  };
}

export interface SupportAutonomousHandoff {
  shouldDispatch: boolean;
  intent:
    | "NEW_ORDER"
    | "SHIPMENT_ACTION"
    | "PLANNING_ROUTING"
    | "EXCEPTION_REPORT"
    | "CUSTOMS_DOCS"
    | "BILLING_INVOICE"
    | "TRACKING_INQUIRY";
  taskSummary: string;
  shipmentReference: string | null;
  originCity: string | null;
  destinationCity: string | null;
  cargoDescription: string | null;
  weightKg: number | null;
  quantity: number | null;
  deadlineIso: string | null;
  customerName: string | null;
  hazmat: boolean;
  reefer: boolean;
  missingFields: string[];
}

export async function runCustomerSupportWithGemini({
  reference,
  shipmentId,
  question,
  history,
  sourceChannel = "WEBSITE_CHAT",
  draftContext,
}: {
  reference?: string | null;
  shipmentId: string | null;
  question: string;
  history: Array<{ role: string; text: string }>;
  sourceChannel?: string;
  draftContext?: Record<string, unknown> | null;
}): Promise<{
  reply: string;
  shouldEscalate: boolean;
  escalationReason: string | null;
  confidence: number;
  autonomousHandoff: SupportAutonomousHandoff;
  meta: GeminiGenerationMeta;
}> {
  const { snapshot } = await gatherOperationalContext(
    "ai-customer-support",
    reference ?? undefined,
  );
  const safeFocus = snapshot.focusShipment
    ? {
        shipment: (snapshot.focusShipment as Record<string, unknown>).shipment,
      }
    : null;
  const compactCustomerContext = {
    sourceChannel,
    inProgressBookingDraft: draftContext ?? null,
    focusShipment: safeFocus,
    customerSafeShipments: Array.isArray(snapshot.customerSafeShipments)
      ? snapshot.customerSafeShipments.slice(0, 8)
      : [],
  };

  const res = await generateAgentJson<{
    reply: string;
    shouldEscalate: boolean;
    escalationReason?: string | null;
    confidence: number;
    autonomousHandoff?: Partial<SupportAutonomousHandoff>;
  }>({
    thinkingDepth: "LOW",
    systemInstruction: [
      "You are the AI Customer Support Agent for a logistics operations platform, operating across Website Chat, WhatsApp, Telegram, and Email.",
      "SECURITY ALLOWLIST RULE: You may only share shipment status, route cities, promised deadline, projected arrival, carrier name/code, and cargo summary.",
      "NEVER disclose carrier buy rates, quotes, scoring weights, profit margins, internal policy rationales, or internal specialist agent names.",
      "If the customer is lodging a complaint, reporting damaged/lost cargo, requesting a refund/claim, or asking for a human agent, set shouldEscalate=true with a clear escalationReason.",
      "If the customer wants to book a new shipment or order cargo, extract originCity, destinationCity, cargoDescription, weightKg, quantity, deadlineIso, customerName, hazmat, reefer into autonomousHandoff. If both originCity and destinationCity are known, confirm in reply that the operations team has started processing their order/shipment immediately. If origin or destination is still missing, list missingFields and politely ask for them.",
      "For ALL operational requests (booking/order, route/planning change, reschedule, delay/exception report, customs/documents, billing/invoice, or status follow-up), populate autonomousHandoff accurately with shouldDispatch=true so our backend Autonomous Agent initiates work immediately.",
    ].join("\n"),
    prompt: JSON.stringify({
      sourceChannel,
      customerMessage: question,
      shipmentReference: reference ?? null,
      recentTurns: history.slice(-6),
      customerSafeContext: compactCustomerContext,
    }),
    responseSchema: SUPPORT_REPLY_SCHEMA,
  });

  const rawHandoff = res.data.autonomousHandoff ?? {};
  const validIntents = new Set([
    "NEW_ORDER",
    "SHIPMENT_ACTION",
    "PLANNING_ROUTING",
    "EXCEPTION_REPORT",
    "CUSTOMS_DOCS",
    "BILLING_INVOICE",
    "TRACKING_INQUIRY",
  ]);
  const intent = (
    typeof rawHandoff.intent === "string" && validIntents.has(rawHandoff.intent)
      ? rawHandoff.intent
      : res.data.shouldEscalate
        ? "EXCEPTION_REPORT"
        : "TRACKING_INQUIRY"
  ) as SupportAutonomousHandoff["intent"];

  const autonomousHandoff: SupportAutonomousHandoff = {
    shouldDispatch:
      typeof rawHandoff.shouldDispatch === "boolean"
        ? rawHandoff.shouldDispatch
        : intent !== "TRACKING_INQUIRY" || Boolean(res.data.shouldEscalate),
    intent,
    taskSummary:
      typeof rawHandoff.taskSummary === "string" && rawHandoff.taskSummary.trim()
        ? rawHandoff.taskSummary.trim()
        : question.slice(0, 220),
    shipmentReference:
      typeof rawHandoff.shipmentReference === "string" && rawHandoff.shipmentReference.trim()
        ? rawHandoff.shipmentReference.trim().toUpperCase()
        : reference?.trim().toUpperCase() || null,
    originCity:
      typeof rawHandoff.originCity === "string" && rawHandoff.originCity.trim()
        ? rawHandoff.originCity.trim()
        : null,
    destinationCity:
      typeof rawHandoff.destinationCity === "string" && rawHandoff.destinationCity.trim()
        ? rawHandoff.destinationCity.trim()
        : null,
    cargoDescription:
      typeof rawHandoff.cargoDescription === "string" && rawHandoff.cargoDescription.trim()
        ? rawHandoff.cargoDescription.trim()
        : null,
    weightKg:
      typeof rawHandoff.weightKg === "number" && Number.isFinite(rawHandoff.weightKg) && rawHandoff.weightKg > 0
        ? rawHandoff.weightKg
        : null,
    quantity:
      typeof rawHandoff.quantity === "number" && Number.isFinite(rawHandoff.quantity) && rawHandoff.quantity > 0
        ? Math.round(rawHandoff.quantity)
        : null,
    deadlineIso:
      typeof rawHandoff.deadlineIso === "string" && rawHandoff.deadlineIso.trim()
        ? rawHandoff.deadlineIso.trim()
        : null,
    customerName:
      typeof rawHandoff.customerName === "string" && rawHandoff.customerName.trim()
        ? rawHandoff.customerName.trim()
        : null,
    hazmat: Boolean(rawHandoff.hazmat),
    reefer: Boolean(rawHandoff.reefer),
    missingFields: Array.isArray(rawHandoff.missingFields)
      ? rawHandoff.missingFields.map((x) => String(x)).filter(Boolean)
      : [],
  };

  await recordAgentRun({
    shipmentId,
    agent: "ai-customer-support",
    job: `Support (${sourceChannel}): ${autonomousHandoff.intent}`,
    model: res.meta.model,
    status: "OK",
    latencyMs: res.meta.latencyMs,
    promptTokens: res.meta.promptTokens,
    completionTokens: res.meta.completionTokens,
    reasoning: res.data.shouldEscalate
      ? `Escalated: ${res.data.escalationReason ?? "Customer request"}`
      : `Intent ${autonomousHandoff.intent} -> Autonomous Orchestrator`,
    text: res.data.reply,
  });

  if (res.data.shouldEscalate) {
    await recordAgentRun({
      shipmentId,
      agent: "human-escalation",
      job: "Support escalation triage",
      model: res.meta.model,
      status: "OK",
      latencyMs: 1,
      promptTokens: null,
      completionTokens: null,
      reasoning: res.data.escalationReason ?? "Escalated by AI Customer Support Agent",
      text: question,
    });
  }

  return {
    reply: res.data.reply.trim(),
    shouldEscalate: Boolean(res.data.shouldEscalate),
    escalationReason: res.data.escalationReason?.trim() || null,
    confidence: Number.isFinite(Number(res.data.confidence))
      ? Math.max(0.05, Math.min(1, Number(res.data.confidence)))
      : 0.9,
    autonomousHandoff,
    meta: res.meta,
  };
}

export async function runFleetOptimizationWithGemini(): Promise<{
  result: AgentRunStructuredResult;
  meta: GeminiGenerationMeta;
  updatedCount: number;
  updatedReferences: string[];
}> {
  const startedAt = Date.now();
  const { listShipments, listConveyances, listDrivers } = await import("@/lib/queries");
  const [allShipments, conveyances, drivers] = await Promise.all([
    listShipments(),
    listConveyances(),
    listDrivers(),
  ]);
  const eligible = allShipments.filter((s) =>
    ["ALLOCATED", "PLANNED", "SOURCING"].includes(s.state),
  );

  const compactFleetData = {
    eligibleShipments: eligible.map((s) => ({
      reference: s.reference,
      state: s.state,
      origin: s.origin?.city ?? null,
      destination: s.destination?.city ?? null,
      deadline:
        s.deadline && !Number.isNaN(new Date(s.deadline).getTime())
          ? new Date(s.deadline).toISOString()
          : null,
      cargo: s.cargo,
      currentPlan: s.plan,
    })),
    conveyances: conveyances.map((c) => ({
      registration: c.registration,
      mode: c.mode,
      capacity_kg: c.capacity_kg,
      reefer: c.reefer,
      hazmat_certified: c.hazmat_certified,
      assigned_to: c.assigned_to,
      active: c.active,
    })),
    driversSummary: drivers.map((d) => ({
      name: d.name,
      hazmat_certified: d.hazmat_certified,
      days_to_expiry: d.days_to_expiry,
      assigned_to: d.assigned_to,
    })),
  };

  const routeDef = getAgentById("route-optimization")!;
  const fleetDef = getAgentById("fleet-management")!;

  const res = await generateAgentJson<Record<string, unknown>>({
    thinkingDepth: "LOW",
    systemInstruction: [
      buildSpecialistSystemInstruction(routeDef),
      `Collaborate with "${fleetDef.name}" (agent id: "${fleetDef.id}") covering vehicle capacity, reefer/hazmat matching, and driver licence compliance.`,
      "Return two entries in delegations: one for route-optimization and one for fleet-management.",
      "In shipmentUpdates, only reference exact shipment references from eligibleShipments and only assign exact vehicle registration strings from conveyances.",
    ].join("\n"),
    prompt: JSON.stringify({
      task: "Optimize active fleet routes across ALLOCATED, PLANNED, and SOURCING shipments balancing delivery deadlines, vehicle capacities, and compliance.",
      operationalData: compactFleetData,
    }),
    responseSchema: FLEET_OPTIMIZATION_SCHEMA,
  });

  const normalized = normalizeAgentRunOutput(res.data, "route-optimization");
  if (!normalized.delegations || normalized.delegations.length === 0) {
    normalized.delegations = [
      {
        agentId: "route-optimization",
        agentName: routeDef.name,
        task: "Corridor & time-window route optimization",
        finding: normalized.summary,
      },
      {
        agentId: "fleet-management",
        agentName: fleetDef.name,
        task: "Vehicle capacity & driver compliance check",
        finding: normalized.findings[0] ?? normalized.summary,
      },
    ];
  }

  // Persist verified vehicle & route plan updates into shipments.plan (never invent IDs/vehicles)
  const shipByRef = new Map(eligible.map((s) => [s.reference.toUpperCase(), s]));
  const validRegistrations = new Set(
    conveyances
      .filter((c) => c.active && c.registration)
      .map((c) => c.registration!.trim().toUpperCase()),
  );
  const registrationLookup = new Map(
    conveyances
      .filter((c) => c.active && c.registration)
      .map((c) => [c.registration!.trim().toUpperCase(), c.registration!.trim()]),
  );

  const rawUpdates = Array.isArray(res.data.shipmentUpdates)
    ? (res.data.shipmentUpdates as Array<Record<string, unknown>>)
    : [];
  const plannedWrites = new Map<string, Record<string, unknown>>();

  for (const upd of rawUpdates) {
    const ref = typeof upd.reference === "string" ? upd.reference.trim().toUpperCase() : "";
    const ship = shipByRef.get(ref);
    if (!ship) continue;

    const candidateReg =
      typeof upd.assignedVehicle === "string"
        ? upd.assignedVehicle.trim().toUpperCase()
        : "";
    const matchedReg = validRegistrations.has(candidateReg)
      ? registrationLookup.get(candidateReg)
      : undefined;
    const transitHours =
      typeof upd.transitHours === "number" && Number.isFinite(upd.transitHours) && upd.transitHours > 0
        ? Math.round(upd.transitHours * 10) / 10
        : undefined;
    const meetsDeadline =
      typeof upd.meetsDeadline === "boolean" ? upd.meetsDeadline : undefined;

    plannedWrites.set(ship.id, {
      ...(ship.plan ?? {}),
      ...(matchedReg ? { assigned_vehicle: matchedReg } : {}),
      ...(transitHours !== undefined ? { transit_hours: transitHours } : {}),
      ...(meetsDeadline !== undefined ? { meets_deadline: meetsDeadline } : {}),
      routing_solver: "route-fleet-optimizer",
      optimized_at: new Date().toISOString(),
    });
  }

  // Deterministically match idle compliant vehicles for any eligible shipment still missing a vehicle
  const idleVehicles = conveyances.filter((c) => c.active && !c.assigned_to && c.registration);
  let idleIdx = 0;
  for (const ship of eligible) {
    const existingPlan = plannedWrites.get(ship.id) ?? ship.plan ?? {};
    const hasVehicle = Boolean(
      existingPlan.assigned_vehicle || existingPlan.recommended_vehicle || existingPlan.vehicle,
    );
    if (!hasVehicle && idleIdx < idleVehicles.length) {
      const needsHazmat = Boolean(ship.cargo?.hazmat);
      const needsReefer = Boolean(ship.cargo?.reefer || ship.cargo?.temperature_c);
      const match =
        idleVehicles.find(
          (v, idx) =>
            idx >= idleIdx &&
            (!needsHazmat || v.hazmat_certified) &&
            (!needsReefer || v.reefer),
        ) ?? idleVehicles[idleIdx];
      if (match?.registration) {
        idleIdx += 1;
        plannedWrites.set(ship.id, {
          ...existingPlan,
          assigned_vehicle: match.registration,
          routing_solver: "route-fleet-optimizer",
          optimized_at: new Date().toISOString(),
        });
      }
    } else if (!plannedWrites.has(ship.id)) {
      plannedWrites.set(ship.id, {
        ...existingPlan,
        routing_solver: (existingPlan.routing_solver as string) || "route-fleet-optimizer",
        optimized_at: new Date().toISOString(),
      });
    }
  }

  const updatedReferences: string[] = [];
  await Promise.all(
    Array.from(plannedWrites.entries()).map(async ([shipmentId, nextPlan]) => {
      const ship = eligible.find((s) => s.id === shipmentId);
      if (ship) updatedReferences.push(ship.reference);
      try {
        await query(
          `UPDATE shipments SET plan = $1::jsonb, updated_at = now() WHERE id = $2`,
          [JSON.stringify(nextPlan), shipmentId],
        );
      } catch (err) {
        console.warn("[Planning] Failed updating shipment plan:", err);
      }
    }),
  );

  const totalLatency = Math.max(1, Date.now() - startedAt);
  await Promise.all([
    recordAgentRun({
      shipmentId: null,
      agent: "route-optimization",
      job: "Optimize fleet routes",
      model: res.meta.model,
      status: "OK",
      latencyMs: totalLatency,
      promptTokens: res.meta.promptTokens,
      completionTokens: res.meta.completionTokens,
      reasoning: normalized.summary,
      text: normalized.findings.join(" | "),
    }),
    recordAgentRun({
      shipmentId: null,
      agent: "fleet-management",
      job: "Fleet capacity & driver compliance",
      model: res.meta.model,
      status: "OK",
      latencyMs: totalLatency,
      promptTokens: null,
      completionTokens: null,
      reasoning: normalized.delegations[1]?.finding ?? normalized.summary,
      text: normalized.findings.join(" | "),
    }),
  ]);

  return {
    result: normalized,
    meta: {
      model: AGENT_GEMINI_MODEL,
      latencyMs: totalLatency,
      promptTokens: res.meta.promptTokens,
      completionTokens: res.meta.completionTokens,
    },
    updatedCount: updatedReferences.length,
    updatedReferences,
  };
}
