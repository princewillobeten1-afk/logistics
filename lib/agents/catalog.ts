export type AgentDomainId =
  | "orchestration"
  | "shipment"
  | "route_fleet"
  | "exception_risk"
  | "carrier_vendor"
  | "order_warehouse"
  | "customer_experience"
  | "financial"
  | "analytics_bi"
  | "automation"
  | "security_compliance";

export interface AgentDomain {
  id: AgentDomainId;
  number: number;
  name: string;
  description: string;
  subRoles: string[];
}

export type CoreAgentId =
  | "orchestrator"
  | "shipment-management"
  | "shipment-tracking"
  | "route-optimization"
  | "fleet-management"
  | "carrier-management"
  | "order-management"
  | "warehouse-coordination"
  | "exception-resolution"
  | "ai-customer-support"
  | "customer-communication"
  | "financial-management"
  | "logistics-analytics"
  | "workflow-automation"
  | "human-escalation";

export interface CoreAgentDefinition {
  id: CoreAgentId;
  number: number;
  name: string;
  domainId: AgentDomainId;
  secondaryDomainIds?: AgentDomainId[];
  primaryRole: string;
  capabilities: string[];
  targetRoute: string;
  targetLabel: string;
  thinkingDepth: "LOW" | "MEDIUM" | "HIGH";
  quickPrompts: string[];
}

export const AGENT_DOMAINS: AgentDomain[] = [
  {
    id: "orchestration",
    number: 1,
    name: "Core Orchestration",
    description:
      "Central intelligence coordinating specialist agents, task decomposition, execution monitoring, decision support, SOP knowledge, and human escalation.",
    subRoles: [
      "Workflow Orchestration",
      "Task Decomposition",
      "Execution Monitoring",
      "Decision Evaluation",
      "Human Escalation Routing",
      "Policy & SOP Memory",
    ],
  },
  {
    id: "shipment",
    number: 2,
    name: "Shipment Management",
    description:
      "Creates, classifies, schedules, monitors, documents, and verifies delivery confirmations across the full shipment lifecycle.",
    subRoles: [
      "Order-to-Shipment Creation",
      "Handling & Priority Classification",
      "End-to-End Lifecycle Tracking",
      "Status Synchronization",
      "Pickup & Delivery Scheduling",
      "Shipping Document Generation",
      "POD & Evidence Verification",
    ],
  },
  {
    id: "route_fleet",
    number: 3,
    name: "Route & Fleet Optimization",
    description:
      "Calculates and dynamically recalculates routes, assigns vehicles and drivers, tracks compliance, fuel efficiency, and maintenance risks.",
    subRoles: [
      "Multi-Stop Route Calculation",
      "Dynamic Disruption Rerouting",
      "Fleet Utilization Monitoring",
      "Capacity & Handling Vehicle Match",
      "Driver Scheduling & Compliance",
      "Driver Performance Evaluation",
      "Fuel Efficiency Analysis",
      "Maintenance & Inspection Tracking",
    ],
  },
  {
    id: "exception_risk",
    number: 4,
    name: "Exception & Risk Management",
    description:
      "Detects anomalies, predicts weather/traffic delays, scores risk, resolves incomplete tracking, screens fraud, and coordinates incident response.",
    subRoles: [
      "Anomaly & SLA Breach Detection",
      "Predictive Delay Modeling",
      "Shipment Risk Scoring",
      "Cross-Agent Exception Resolution",
      "Missing Tracking Investigation",
      "Fraud & Suspicious Claim Screening",
      "Critical Incident Response",
    ],
  },
  {
    id: "carrier_vendor",
    number: 5,
    name: "Carrier & Vendor Management",
    description:
      "Manages carrier profiles, recommends selections by cost and service quality, automates carrier outreach, and audits invoices.",
    subRoles: [
      "Carrier Profile & Agreement Governance",
      "Multi-Factor Carrier Selection",
      "Reliability & OTIF Evaluation",
      "Automated Carrier Outreach",
      "3PL Vendor Coordination",
      "Carrier Invoice & Rate Auditing",
    ],
  },
  {
    id: "order_warehouse",
    number: 6,
    name: "Order & Warehouse Management",
    description:
      "Validates incoming orders, monitors SKU availability, forecasts demand, coordinates picking/packing/dispatch, and manages returns.",
    subRoles: [
      "Order Fulfillment Monitoring",
      "Address & Quantity Validation",
      "Inventory Shortage Detection",
      "Demand Forecasting",
      "Receiving, Picking & Dispatch",
      "Packlist Optimization",
      "Dock Handover Scheduling",
      "Reverse Logistics & Returns",
    ],
  },
  {
    id: "customer_experience",
    number: 7,
    name: "Customer Experience & Communication",
    description:
      "Resolves customer inquiries safely across channels, sends proactive status updates, triages complaints, and prevents churn.",
    subRoles: [
      "Omnichannel Customer Support",
      "Automated Milestone Notifications",
      "ETA & Tracking Q&A",
      "Complaint Classification & Resolution",
      "CSAT & Feedback Analysis",
      "Proactive Retention Outreach",
    ],
  },
  {
    id: "financial",
    number: 8,
    name: "Financial & Cost Management",
    description:
      "Analyzes transport and warehouse expenses, calculates shipping rates, reconciles invoices, tracks payments, and identifies cost savings.",
    subRoles: [
      "Transport & Fuel Expense Analysis",
      "Dynamic Freight Cost Rating",
      "Customer Invoice Generation",
      "Receivables & Overdue Tracking",
      "Cost Optimization Recommendations",
      "Carrier Charge Reconciliation",
    ],
  },
  {
    id: "analytics_bi",
    number: 9,
    name: "Analytics & Business Intelligence",
    description:
      "Synthesizes fleet, carrier, warehouse, and shipment telemetry into KPI tracking, demand forecasts, and executive summaries.",
    subRoles: [
      "Cross-Network Operational Analysis",
      "Periodic Performance Reporting",
      "OTIF & Fulfillment KPI Tracking",
      "Capacity & Demand Forecasting",
      "Operational Insight Generation",
      "Executive Summary Briefings",
    ],
  },
  {
    id: "automation",
    number: 10,
    name: "Automation & Integration",
    description:
      "Executes event-driven workflows, bridges external APIs, parses logistics emails/documents, and orchestrates multi-channel alerts.",
    subRoles: [
      "Trigger-Based Workflow Execution",
      "External System Data Exchange",
      "API & Webhook Orchestration",
      "Cross-Entity State Sync",
      "Inbound Logistics Email Parsing",
      "Document & Invoice Extraction",
      "Notification Dispatch",
    ],
  },
  {
    id: "security_compliance",
    number: 11,
    name: "Security & Compliance",
    description:
      "Enforces RBAC and policy gates, verifies regulatory/customs compliance, preserves audit trails, and detects anomalies or duplicates.",
    subRoles: [
      "Role-Based Access Enforcement",
      "Policy & Regulatory Compliance Checks",
      "Immutable Decision Audit Logging",
      "Data Quality & Duplicate Detection",
      "Access Anomaly & Security Monitoring",
    ],
  },
];

export const CORE_AGENTS: CoreAgentDefinition[] = [
  {
    id: "orchestrator",
    number: 1,
    name: "AI Orchestrator Agent",
    domainId: "orchestration",
    primaryRole:
      "Central intelligence that coordinates all 14 specialist agents, decomposes complex requests into executable subtasks, monitors progress, and escalates policy gates.",
    capabilities: [
      "Multi-agent task decomposition and delegation",
      "Cross-workflow state and queue monitoring",
      "Policy-aware decision synthesis across SOPs",
    ],
    targetRoute: "/",
    targetLabel: "Operations overview",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Audit all active exceptions, stalled work, and pending approvals and propose a coordinated recovery plan.",
      "Review shipments at risk of missing their 24h deadline and assign actions across routing, carrier, and customer comms.",
      "Run a full floor readiness briefing covering fleet constraints, warehouse bottlenecks, and approval gates.",
    ],
  },
  {
    id: "shipment-management",
    number: 2,
    name: "Shipment Management Agent",
    domainId: "shipment",
    primaryRole:
      "Creates and classifies shipments by priority, mode, and handling needs, coordinates schedules, validates paperwork, and verifies POD evidence.",
    capabilities: [
      "Order-to-shipment classification (hazmat, reefer, international)",
      "Pickup and delivery window coordination",
      "Waybill, customs, and POD completeness validation",
    ],
    targetRoute: "/shipments",
    targetLabel: "Shipments",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Audit active shipments for missing allocations, unscheduled legs, or incomplete international paperwork.",
      "Classify active shipments by urgency, special handling requirements, and next lifecycle transition.",
    ],
  },
  {
    id: "shipment-tracking",
    number: 3,
    name: "Shipment Tracking Agent",
    domainId: "shipment",
    primaryRole:
      "Monitors end-to-end delivery progress, reconciles carrier status updates and GPS pings, and updates arrival confidence.",
    capabilities: [
      "Continuous milestone & GPS telemetry reconciliation",
      "ETA drift and transit variance monitoring",
      "Missing tracking or silent carrier investigation",
    ],
    targetRoute: "/map",
    targetLabel: "Shipments map",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Identify shipments with stale telemetry, stalled transitions, or ETA drift across active corridors.",
      "Summarize live corridor progress and milestone readiness for active in-transit loads.",
    ],
  },
  {
    id: "route-optimization",
    number: 4,
    name: "Route Optimization Agent",
    domainId: "route_fleet",
    primaryRole:
      "Calculates efficient multimodal routes balancing cost, transit windows, vehicle capacity, and dynamic traffic or weather disruptions.",
    capabilities: [
      "Multimodal leg planning and waypoint sequencing",
      "Disruption-aware rerouting recommendations",
      "Distance, deadline, and CO2e intensity balancing",
    ],
    targetRoute: "/planning",
    targetLabel: "Planning",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Evaluate all ALLOCATED and PLANNED shipments for lane consolidation, border lead times, and vehicle assignment.",
      "Identify active corridors facing deadline pressure and propose faster multimodal reroute options.",
    ],
  },
  {
    id: "fleet-management",
    number: 5,
    name: "Fleet Management Agent",
    domainId: "route_fleet",
    primaryRole:
      "Monitors vehicle availability, driver schedules, licence compliance, fuel efficiency, and maintenance risk across fleet assets.",
    capabilities: [
      "Vehicle utilization and reefer/hazmat capacity matching",
      "Driver licence expiry and dispatch eligibility checks",
      "Idle capacity and fuel/maintenance risk flags",
    ],
    targetRoute: "/fleet",
    targetLabel: "Fleet",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Audit driver licence expirations, hazmat certifications, and idle vehicles ready for immediate dispatch.",
      "Check assigned trucks with stale GPS telemetry and recommend fleet rebalancing actions.",
    ],
  },
  {
    id: "carrier-management",
    number: 6,
    name: "Carrier Management Agent",
    domainId: "carrier_vendor",
    primaryRole:
      "Governs carrier profiles, recommends best-fit carriers using historical reliability and quotes, and audits carrier charges against agreed rates.",
    capabilities: [
      "OTIF, damage rate, and service quality benchmarking",
      "Unapproved carrier approval-gate screening",
      "Automated RFQ outreach & freight invoice variance check",
    ],
    targetRoute: "/carriers",
    targetLabel: "Carriers",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Rank carriers by quality score vs. risk for urgent fragile or temperature-controlled shipments.",
      "Identify unapproved or high-damage carriers and recommend lane allocation adjustments.",
    ],
  },
  {
    id: "order-management",
    number: 7,
    name: "Order Management Agent",
    domainId: "order_warehouse",
    primaryRole:
      "Processes incoming orders across API, email, CSV, and chat intake, checking address deliverability, quantities, and deadline plausibility.",
    capabilities: [
      "Intake channel completeness and deliverability verification",
      "DRAFT-to-VALIDATED readiness checks",
      "Feasibility validation against warehouse dispatch lead times",
    ],
    targetRoute: "/orders",
    targetLabel: "Orders",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Review pending orders and DRAFT shipments for missing consignee info or tight deadlines.",
      "Summarize intake channel volume and highlight orders at risk of validation hold.",
    ],
  },
  {
    id: "warehouse-coordination",
    number: 8,
    name: "Warehouse Coordination Agent",
    domainId: "order_warehouse",
    primaryRole:
      "Monitors warehouse stock levels, identifies SKU shortages, forecasts replenishment needs, and coordinates picking, packing, and dock handovers.",
    capabilities: [
      "Inventory shortage and high-utilization detection",
      "Dispatch lead-time vs. deadline allocation checks",
      "Picking, packing, and reverse-logistics coordination",
    ],
    targetRoute: "/warehouses",
    targetLabel: "Warehouses",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Identify SKUs above 75% reservation utilization or at risk of stockout across hubs.",
      "Compare warehouse dispatch lead times against open demand and recommend stock balancing.",
    ],
  },
  {
    id: "exception-resolution",
    number: 9,
    name: "Exception Detection & Resolution Agent",
    domainId: "exception_risk",
    primaryRole:
      "Diagnoses SLA breaches, allocation shortfalls, customs holds, and missing telemetry, scoring risk and coordinating corrective actions.",
    capabilities: [
      "Root-cause triage across events, legs, and quotes",
      "Predictive SLA & weather/corridor risk scoring",
      "Fraud/claim screening and corrective step drafting",
    ],
    targetRoute: "/exceptions",
    targetLabel: "Exceptions",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Triage every open exception by severity, financial impact, and concrete resolution steps.",
      "Check active shipments for hidden SLA breach risk or stalled work items before they escalate.",
    ],
  },
  {
    id: "ai-customer-support",
    number: 10,
    name: "AI Customer Support Agent",
    domainId: "customer_experience",
    primaryRole:
      "Handles inbound customer tracking and booking inquiries via web chat and messaging channels using strictly allowlisted shipment facts.",
    capabilities: [
      "Zero-leakage customer-safe status & ETA answers",
      "Guided conversational shipment booking intake",
      "Automatic escalation handoff on complaints or claims",
    ],
    targetRoute: "/support",
    targetLabel: "Support inbox",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Review open customer conversations and mid-booking drafts needing follow-up or clarification.",
      "Check escalated support threads and prepare safe, accurate customer resolution drafts.",
    ],
  },
  {
    id: "customer-communication",
    number: 11,
    name: "Customer Communication Agent",
    domainId: "customer_experience",
    primaryRole:
      "Orchestrates proactive delay advisories, delivery notifications, complaint resolution workflows, and retention outreach for at-risk accounts.",
    capabilities: [
      "Proactive SLA breach & delay notifications",
      "Customer sentiment & complaint risk detection",
      "Contractual SLA adherence monitoring per account",
    ],
    targetRoute: "/customers",
    targetLabel: "Customers",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Identify customers with late shipments or approaching SLAs and draft proactive update messages.",
      "Audit recent outbound communications for tone, completeness, and unresolved customer questions.",
    ],
  },
  {
    id: "financial-management",
    number: 12,
    name: "Financial Management Agent",
    domainId: "financial",
    primaryRole:
      "Analyzes transport spend, validates carrier quotes against FX rates and spending caps, reconciles invoices, and finds cost savings.",
    capabilities: [
      "Quote variance and FX conversion risk analysis",
      "Carrier cost vs. transit trade-off evaluation",
      "Spend-cap compliance and margin protection",
    ],
    targetRoute: "/analytics",
    targetLabel: "Analytics",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Audit current planned costs, carrier quotes, and FX exposure against active spending caps.",
      "Identify mode-shift or consolidation opportunities to lower cost per tonne-km.",
    ],
  },
  {
    id: "logistics-analytics",
    number: 13,
    name: "Logistics Analytics Agent",
    domainId: "analytics_bi",
    primaryRole:
      "Generates executive briefings, tracks OTIF, mode mix, CO2e intensity, and model efficiency, and forecasts upcoming operational demand.",
    capabilities: [
      "14-day throughput & bottleneck trend synthesis",
      "Mode mix & carbon intensity (g CO2e/km) analysis",
      "AI cost & latency efficiency reporting",
    ],
    targetRoute: "/analytics",
    targetLabel: "Analytics",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Produce an executive operations briefing covering throughput, OTIF risks, and emissions intensity.",
      "Analyze lane bottlenecks and recommend capacity adjustments for the next 7 days.",
    ],
  },
  {
    id: "workflow-automation",
    number: 14,
    name: "Workflow Automation Agent",
    domainId: "automation",
    secondaryDomainIds: ["security_compliance"],
    primaryRole:
      "Coordinates event-driven pipelines, unverified document/customs extraction checks, dead-letter recovery, and external channel synchronization.",
    capabilities: [
      "Dead-letter work queue diagnosis and retry triage",
      "Low-confidence document & customs clearance review",
      "Channel integration and audit log integrity checks",
    ],
    targetRoute: "/documents",
    targetLabel: "Documents",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Audit unverified documents, held customs declarations, and dead-letter queue items for recovery.",
      "Review channel connector readiness and highlight automation gaps across intake and POD.",
    ],
  },
  {
    id: "human-escalation",
    number: 15,
    name: "Human Escalation Agent",
    domainId: "orchestration",
    secondaryDomainIds: ["security_compliance"],
    primaryRole:
      "Evaluates high-stakes policy gates, pending spend approvals, unapproved carriers, hazmat/border risks, and critical incidents requiring human sign-off.",
    capabilities: [
      "Pre-approval risk and policy compliance brief",
      "Threshold checks against active spending rules",
      "Escalation routing for complaints, claims, and dead work",
    ],
    targetRoute: "/approvals",
    targetLabel: "Approvals",
    thinkingDepth: "LOW",
    quickPrompts: [
      "Evaluate every pending spending approval against policy thresholds, carrier quality, and deadline urgency.",
      "Surface any exceptions, expired approvals, or customer escalations requiring immediate human sign-off.",
    ],
  },
];

export interface AgentRunStructuredResult {
  summary: string;
  findings: string[];
  recommendedActions: Array<{
    title: string;
    detail: string;
    priority: "HIGH" | "MEDIUM" | "LOW";
    ownerAgentId: string;
    targetRoute?: string;
    shipmentReference?: string;
  }>;
  delegations?: Array<{
    agentId: string;
    agentName: string;
    task: string;
    finding: string;
  }>;
  requiresHumanApproval: boolean;
  escalationReason: string | null;
  confidence: number;
}

export type BackendWorkflow =
  | "background.orchestrate"
  | "shipments.assistant"
  | "tracking.monitor"
  | "planning.optimize_routes"
  | "planning.fleet_dispatch"
  | "carriers.evaluate_quotes"
  | "orders.validate_intake"
  | "warehouses.inventory_balance"
  | "exceptions.triage"
  | "support.customer_reply"
  | "communications.proactive_outreach"
  | "finance.cost_audit"
  | "analytics.executive_digest"
  | "automation.email_document_sync"
  | "approvals.escalation_gate";

export const BACKEND_WORKFLOW_AGENT_MAP: Record<BackendWorkflow, CoreAgentId> = {
  "background.orchestrate": "orchestrator",
  "shipments.assistant": "shipment-management",
  "tracking.monitor": "shipment-tracking",
  "planning.optimize_routes": "route-optimization",
  "planning.fleet_dispatch": "fleet-management",
  "carriers.evaluate_quotes": "carrier-management",
  "orders.validate_intake": "order-management",
  "warehouses.inventory_balance": "warehouse-coordination",
  "exceptions.triage": "exception-resolution",
  "support.customer_reply": "ai-customer-support",
  "communications.proactive_outreach": "customer-communication",
  "finance.cost_audit": "financial-management",
  "analytics.executive_digest": "logistics-analytics",
  "automation.email_document_sync": "workflow-automation",
  "approvals.escalation_gate": "human-escalation",
};

export function getAgentForBackendWorkflow(workflow: BackendWorkflow): CoreAgentDefinition {
  const id = BACKEND_WORKFLOW_AGENT_MAP[workflow];
  return getAgentById(id)!;
}

export function getAgentById(id: string): CoreAgentDefinition | undefined {
  return CORE_AGENTS.find((a) => a.id === id);
}

export function getDomainById(id: string): AgentDomain | undefined {
  return AGENT_DOMAINS.find((d) => d.id === id);
}

export function filterAgentsByDomain(domainId?: string): CoreAgentDefinition[] {
  if (!domainId || domainId === "all") return CORE_AGENTS;
  return CORE_AGENTS.filter(
    (a) => a.domainId === domainId || a.secondaryDomainIds?.includes(domainId as AgentDomainId),
  );
}

export function getAgentsForRoute(pathname: string): CoreAgentDefinition[] {
  const clean = pathname.split("?")[0] || "/";
  return CORE_AGENTS.filter((a) => a.targetRoute === clean);
}

const ORCHESTRATOR_KEYWORD_RULES: Array<{
  agentId: CoreAgentId;
  pattern: RegExp;
  defaultSubtask: string;
}> = [
  {
    agentId: "exception-resolution",
    pattern: /exception|delay|sla|drift|incident|risk|breach|missing|stalled/i,
    defaultSubtask: "Audit active exceptions, stalled work items, and SLA risks.",
  },
  {
    agentId: "human-escalation",
    pattern: /approv|policy|escalat|hazmat|customs|border|spend|cap|sign[- ]off/i,
    defaultSubtask: "Review pending spending approvals and policy compliance gates.",
  },
  {
    agentId: "route-optimization",
    pattern: /route|reroute|corridor|lane|transit|planning|deadline|schedule/i,
    defaultSubtask: "Evaluate corridor routes, transit deadlines, and reroute options.",
  },
  {
    agentId: "fleet-management",
    pattern: /fleet|truck|vehicle|driver|licen[cs]e|fuel|maintenance|gps/i,
    defaultSubtask: "Check vehicle availability, driver compliance, and fleet telemetry.",
  },
  {
    agentId: "carrier-management",
    pattern: /carrier|quote|vendor|rfq|otif|freight rate/i,
    defaultSubtask: "Assess carrier performance, quotes, and approval status.",
  },
  {
    agentId: "warehouse-coordination",
    pattern: /warehouse|inventory|stock|sku|pick|pack|dispatch|hub/i,
    defaultSubtask: "Inspect hub inventory reservations, shortages, and dispatch readiness.",
  },
  {
    agentId: "order-management",
    pattern: /order|intake|draft|consignee|address|validation/i,
    defaultSubtask: "Check incoming orders and draft shipments for missing validation fields.",
  },
  {
    agentId: "customer-communication",
    pattern: /customer|comms|notify|notification|update|proactive|message/i,
    defaultSubtask: "Draft proactive customer updates for shipments facing timeline changes.",
  },
  {
    agentId: "ai-customer-support",
    pattern: /support|chat|thread|ticket|complaint|inquiry/i,
    defaultSubtask: "Review open customer support conversations and escalated threads.",
  },
  {
    agentId: "financial-management",
    pattern: /financ|cost|budget|fx|currency|invoice|spend|margin/i,
    defaultSubtask: "Evaluate transport costs, FX exposure, and spend caps.",
  },
  {
    agentId: "logistics-analytics",
    pattern: /analytic|kpi|metric|throughput|co2|emission|forecast|briefing|readiness/i,
    defaultSubtask: "Synthesize throughput, OTIF, and capacity metrics across the network.",
  },
  {
    agentId: "workflow-automation",
    pattern: /workflow|document|pod|waybill|customs|queue|dead[- ]letter|automation/i,
    defaultSubtask: "Audit unverified documents, customs declarations, and queue health.",
  },
  {
    agentId: "shipment-management",
    pattern: /shipment|cargo|booking|manifest|classification/i,
    defaultSubtask: "Review shipment lifecycle states, cargo handling, and bookings.",
  },
  {
    agentId: "shipment-tracking",
    pattern: /track|milestone|telemetry|eta|in[- ]transit/i,
    defaultSubtask: "Monitor active shipment tracking milestones and ETA confidence.",
  },
];

export function selectOrchestratorSpecialists(
  task: string,
  hints?: {
    openExceptions?: number;
    pendingApprovals?: number;
    stalledWork?: number;
  },
  maxSpecialists = 4,
): Array<{ agentId: CoreAgentId; subtask: string }> {
  const cap = Math.max(1, Math.min(6, Math.round(maxSpecialists)));
  const minFallback = Math.min(2, cap);
  const picked: Array<{ agentId: CoreAgentId; subtask: string }> = [];
  const seen = new Set<CoreAgentId>();

  for (const rule of ORCHESTRATOR_KEYWORD_RULES) {
    if (rule.pattern.test(task) && !seen.has(rule.agentId)) {
      seen.add(rule.agentId);
      picked.push({ agentId: rule.agentId, subtask: rule.defaultSubtask });
    }
    if (picked.length >= cap) return picked;
  }

  if (picked.length < minFallback && (hints?.openExceptions ?? 0) > 0 && !seen.has("exception-resolution")) {
    seen.add("exception-resolution");
    picked.push({
      agentId: "exception-resolution",
      subtask: "Triage active operational exceptions and SLA risks.",
    });
  }
  if (picked.length < minFallback && (hints?.pendingApprovals ?? 0) > 0 && !seen.has("human-escalation")) {
    seen.add("human-escalation");
    picked.push({
      agentId: "human-escalation",
      subtask: "Assess pending spending approvals and policy compliance gates.",
    });
  }
  if (picked.length < minFallback && !seen.has("shipment-management")) {
    seen.add("shipment-management");
    picked.push({
      agentId: "shipment-management",
      subtask: "Audit active shipment states, deadlines, and lifecycle blockers.",
    });
  }
  if (picked.length < minFallback && !seen.has("route-optimization")) {
    seen.add("route-optimization");
    picked.push({
      agentId: "route-optimization",
      subtask: "Review corridor plans and vehicle capacity readiness.",
    });
  }

  return picked.slice(0, cap);
}

export function normalizeAgentRunOutput(raw: unknown, fallbackAgentId: string): AgentRunStructuredResult {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const summary =
    typeof obj.summary === "string" && obj.summary.trim()
      ? obj.summary.trim()
      : "Completed operational analysis.";

  const findings = Array.isArray(obj.findings)
    ? obj.findings.map((f) => String(f ?? "").trim()).filter(Boolean).slice(0, 8)
    : [];

  const recommendedActions = Array.isArray(obj.recommendedActions)
    ? obj.recommendedActions
        .map((item) => {
          const rec = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          const title = typeof rec.title === "string" ? rec.title.trim() : "";
          const detail = typeof rec.detail === "string" ? rec.detail.trim() : "";
          if (!title && !detail) return null;
          const rawPrio = String(rec.priority ?? "MEDIUM").toUpperCase();
          const priority: "HIGH" | "MEDIUM" | "LOW" =
            rawPrio === "HIGH" || rawPrio === "LOW" ? rawPrio : "MEDIUM";
          return {
            title: title || "Recommended action",
            detail: detail || title,
            priority,
            ownerAgentId:
              typeof rec.ownerAgentId === "string" && rec.ownerAgentId.trim()
                ? rec.ownerAgentId.trim()
                : fallbackAgentId,
            targetRoute:
              typeof rec.targetRoute === "string" && rec.targetRoute.startsWith("/")
                ? rec.targetRoute
                : undefined,
            shipmentReference:
              typeof rec.shipmentReference === "string" && rec.shipmentReference.trim()
                ? rec.shipmentReference.trim().toUpperCase()
                : undefined,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .slice(0, 8)
    : [];

  const delegations = Array.isArray(obj.delegations)
    ? obj.delegations
        .map((item) => {
          const rec = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          const agentId = typeof rec.agentId === "string" ? rec.agentId.trim() : "";
          const finding = typeof rec.finding === "string" ? rec.finding.trim() : "";
          if (!agentId || !finding) return null;
          const def = getAgentById(agentId);
          return {
            agentId,
            agentName:
              typeof rec.agentName === "string" && rec.agentName.trim()
                ? rec.agentName.trim()
                : def?.name ?? agentId,
            task:
              typeof rec.task === "string" && rec.task.trim()
                ? rec.task.trim()
                : def?.primaryRole ?? "Specialist analysis",
            finding,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .slice(0, 6)
    : undefined;

  const rawConfidence = Number(obj.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.max(0.05, Math.min(1, rawConfidence > 1 ? rawConfidence / 100 : rawConfidence))
    : 0.85;

  return {
    summary,
    findings,
    recommendedActions,
    ...(delegations && delegations.length > 0 ? { delegations } : {}),
    requiresHumanApproval: Boolean(obj.requiresHumanApproval),
    escalationReason:
      typeof obj.escalationReason === "string" && obj.escalationReason.trim()
        ? obj.escalationReason.trim()
        : null,
    confidence,
  };
}

export function classifyGeminiError(err: unknown): {
  status: number;
  message: string;
  quotaExceeded: boolean;
} {
  const message = err instanceof Error ? err.message : String(err ?? "Gemini request failed.");
  const statusNum =
    typeof (err as { status?: unknown })?.status === "number"
      ? (err as { status: number }).status
      : undefined;

  if (
    statusNum === 429 ||
    /RESOURCE_EXHAUSTED|quota|rate limit|429/i.test(message)
  ) {
    return {
      status: 429,
      message:
        "AI model quota or rate limit reached. Retry shortly or verify your NVIDIA_API_KEY / GEMINI_API_KEY.",
      quotaExceeded: true,
    };
  }

  if (
    statusNum === 401 ||
    statusNum === 403 ||
    /API_KEY_INVALID|PERMISSION_DENIED|unregistered callers/i.test(message)
  ) {
    return {
      status: statusNum === 403 ? 403 : 400,
      message:
        "AI provider API key is invalid or unauthorized. Verify NVIDIA_API_KEY or GEMINI_API_KEY.",
      quotaExceeded: false,
    };
  }

  if (statusNum === 404 || /NOT_FOUND|not found for API version/i.test(message)) {
    return {
      status: 502,
      message: "Configured AI model endpoint returned not found. Please retry.",
      quotaExceeded: false,
    };
  }

  if (statusNum === 400 || /INVALID_ARGUMENT/i.test(message)) {
    return {
      status: 400,
      message: "AI provider rejected the structured request parameters (400 INVALID_ARGUMENT).",
      quotaExceeded: false,
    };
  }

  if (
    statusNum === 503 ||
    statusNum === 504 ||
    statusNum === 500 ||
    /UNAVAILABLE|overloaded|DEADLINE_EXCEEDED|ETIMEDOUT|TimeoutError|AbortError|timed out|aborted|fetch failed/i.test(message)
  ) {
    return {
      status: statusNum === 504 || /TimeoutError|AbortError|timed out|aborted/i.test(message) ? 504 : 503,
      message: `AI model service is temporarily unreachable (${statusNum ?? "timeout"}). Please retry shortly.`,
      quotaExceeded: false,
    };
  }

  if (/non-JSON|Unexpected token|JSON/i.test(message)) {
    return {
      status: 502,
      message: "AI provider returned an incomplete structured JSON response. Please retry.",
      quotaExceeded: false,
    };
  }

  const safeSnippet = message
    .replace(/AIza[0-9A-Za-z_-]+/g, "[REDACTED]")
    .replace(/nvapi-[0-9A-Za-z_-]+/g, "[REDACTED]")
    .replace(/https?:\/\/\S+/g, "[URL]")
    .slice(0, 140);

  return {
    status: 502,
    message: safeSnippet
      ? `Unable to complete AI agent execution (${safeSnippet}).`
      : "Unable to complete AI agent execution right now.",
    quotaExceeded: false,
  };
}
