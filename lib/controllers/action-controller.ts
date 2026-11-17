import {
  classifyAutonomousIntent,
  dispatchToAutonomousAgent,
  processOmnichannelSupportTurn,
  type AutonomousDispatchResult,
  type AutonomousIntent,
  type AutonomousStructuredInput,
  type IntakeSourceChannel,
  type OmnichannelSupportTurnResult,
} from "@/lib/agents/autonomous";
import { classifyGeminiError, type CoreAgentId } from "@/lib/agents/catalog";
import { getServerGeminiKey } from "@/lib/agents/gemini-client";
import {
  runFleetOptimizationWithGemini,
  runShipmentAssistantWithGemini,
} from "@/lib/agents/orchestrator";
import { recordAudit } from "@/lib/audit";
import {
  currentUser,
  may,
  type Permission,
  type Role,
  type SessionUser,
} from "@/lib/auth";
import { query, runWithOrgScope, transaction } from "@/lib/db";

export type FrontendActionIntent =
  | "NEW_ORDER"
  | "PLANNING_ROUTING"
  | "FLEET_OPTIMIZE"
  | "SUPPORT_MESSAGE"
  | "SHIPMENT_ASSIST"
  | "APPROVAL_DECISION"
  | "SHIPMENT_ACTION"
  | "EXCEPTION_REPORT"
  | "CUSTOMS_DOCS"
  | "BILLING_INVOICE"
  | "TRACKING_INQUIRY"
  | "AUTO";

export const SUPPORTED_FRONTEND_INTENTS: readonly FrontendActionIntent[] = [
  "NEW_ORDER",
  "PLANNING_ROUTING",
  "FLEET_OPTIMIZE",
  "SUPPORT_MESSAGE",
  "SHIPMENT_ASSIST",
  "APPROVAL_DECISION",
  "SHIPMENT_ACTION",
  "EXCEPTION_REPORT",
  "CUSTOMS_DOCS",
  "BILLING_INVOICE",
  "TRACKING_INQUIRY",
  "AUTO",
] as const;

export interface NewOrderPayload {
  customerName?: string;
  originCity: string;
  destinationCity: string;
  cargoDescription: string;
  weightKg?: number;
  quantity?: number;
  deadlineIso?: string;
  preferredMode?: string;
  hazmat?: boolean;
  reefer?: boolean;
  currency?: string;
  notes?: string;
}

export interface PlanningRoutingPayload {
  reference?: string;
  originCity?: string;
  destinationCity?: string;
  preferredMode?: string;
  deadlineIso?: string;
  notes?: string;
}

export interface FleetOptimizePayload {
  notes?: string;
}

export interface SupportMessagePayload {
  channel?: "WEBSITE_CHAT" | "WIDGET" | "WHATSAPP" | "TELEGRAM";
  message: string;
  reference?: string;
  sessionKey?: string;
}

export interface ShipmentAssistPayload {
  reference: string;
  question: string;
}

export interface ApprovalDecisionPayload {
  token: string;
  decision: "approve" | "reject";
  ip?: string | null;
  userAgent?: string | null;
}

export interface GenericLogisticsPayload {
  message: string;
  reference?: string;
  structured?: AutonomousStructuredInput;
}

export type FrontendLogisticsRequest =
  | {
      intent: "NEW_ORDER";
      sourceChannel?: IntakeSourceChannel;
      payload: NewOrderPayload;
    }
  | {
      intent: "PLANNING_ROUTING";
      sourceChannel?: IntakeSourceChannel;
      payload: PlanningRoutingPayload;
    }
  | {
      intent: "FLEET_OPTIMIZE";
      sourceChannel?: IntakeSourceChannel;
      payload?: FleetOptimizePayload;
    }
  | {
      intent: "SUPPORT_MESSAGE";
      sourceChannel?: IntakeSourceChannel;
      payload: SupportMessagePayload;
    }
  | {
      intent: "SHIPMENT_ASSIST";
      sourceChannel?: IntakeSourceChannel;
      payload: ShipmentAssistPayload;
    }
  | {
      intent: "APPROVAL_DECISION";
      sourceChannel?: IntakeSourceChannel;
      payload: ApprovalDecisionPayload;
    }
  | {
      intent:
        | "SHIPMENT_ACTION"
        | "EXCEPTION_REPORT"
        | "CUSTOMS_DOCS"
        | "BILLING_INVOICE"
        | "TRACKING_INQUIRY"
        | "AUTO";
      sourceChannel?: IntakeSourceChannel;
      payload: GenericLogisticsPayload;
    };

export interface VerifiedControllerUser {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  name: string | null;
  role: Role;
}

export interface FrontendActionResult {
  ok: boolean;
  status: number;
  intent: AutonomousIntent | "SUPPORT_MESSAGE" | "SHIPMENT_ASSIST";
  message: string;
  verifiedUser?: VerifiedControllerUser;
  startedWork?: boolean;
  orderReference?: string | null;
  shipmentReference?: string | null;
  shipmentId?: string | null;
  delegatedAgents?: CoreAgentId[];
  orchestrationSummary?: string | null;
  aiWarning?: string | null;
  reply?: string;
  shouldEscalate?: boolean;
  updatedCount?: number;
  decided?: boolean;
  error?: string;
}

export interface ActionControllerDeps {
  resolveUser?: () => Promise<SessionUser | null>;
  dispatchAutonomous?: typeof dispatchToAutonomousAgent;
  processSupportTurn?: typeof processOmnichannelSupportTurn;
  optimizeFleet?: typeof runFleetOptimizationWithGemini;
  assistShipment?: typeof runShipmentAssistantWithGemini;
}

const BASE_PERMISSION_BY_INTENT: Record<FrontendActionIntent, Permission> = {
  NEW_ORDER: "EDIT_SHIPMENT",
  PLANNING_ROUTING: "EDIT_SHIPMENT",
  FLEET_OPTIMIZE: "EDIT_SHIPMENT",
  SHIPMENT_ACTION: "EDIT_SHIPMENT",
  EXCEPTION_REPORT: "EDIT_SHIPMENT",
  CUSTOMS_DOCS: "EDIT_SHIPMENT",
  BILLING_INVOICE: "EDIT_SHIPMENT",
  APPROVAL_DECISION: "APPROVE",
  SUPPORT_MESSAGE: "READ",
  SHIPMENT_ASSIST: "READ",
  TRACKING_INQUIRY: "READ",
  AUTO: "READ",
};

const MUTATING_AUTONOMOUS_INTENTS = new Set<AutonomousIntent>([
  "NEW_ORDER",
  "PLANNING_ROUTING",
  "FLEET_OPTIMIZE",
  "APPROVAL_DECISION",
  "SHIPMENT_ACTION",
  "EXCEPTION_REPORT",
  "CUSTOMS_DOCS",
  "BILLING_INVOICE",
]);

export function requiredPermissionForIntent(
  intent: FrontendActionIntent | AutonomousIntent,
): Permission {
  return BASE_PERMISSION_BY_INTENT[intent as FrontendActionIntent] ?? "EDIT_SHIPMENT";
}

export async function verifyFrontendIdentity(
  requiredPermission: Permission,
  resolveUser: () => Promise<SessionUser | null> = currentUser,
): Promise<
  | { ok: true; user: SessionUser }
  | { ok: false; status: 401 | 403; error: string }
> {
  const user = await resolveUser();
  if (!user) {
    return {
      ok: false,
      status: 401,
      error: "Authentication required. Sign in before submitting logistics requests.",
    };
  }
  if (!may(user.role, requiredPermission)) {
    return {
      ok: false,
      status: 403,
      error: `Your role (${user.role}) is not permitted to perform this action.`,
    };
  }
  return { ok: true, user };
}

function toVerifiedSummary(user: SessionUser): VerifiedControllerUser {
  return {
    id: user.id,
    orgId: user.orgId,
    orgName: user.orgName,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

/**
 * Single server-side action controller entry point for all incoming frontend
 * logistics requests. Every request passes through:
 *   1. Session identity & RBAC verification
 *   2. Intent & payload validation / normalization
 *   3. Forwarding to the Autonomous Agent for specialist task delegation
 */
export async function handleFrontendLogisticsAction(
  request: FrontendLogisticsRequest,
  deps: ActionControllerDeps = {},
): Promise<FrontendActionResult> {
  const resolveUser = deps.resolveUser ?? currentUser;
  const dispatchAutonomous = deps.dispatchAutonomous ?? dispatchToAutonomousAgent;
  const processSupportTurn =
    deps.processSupportTurn ?? processOmnichannelSupportTurn;
  const optimizeFleet = deps.optimizeFleet ?? runFleetOptimizationWithGemini;
  const assistShipment = deps.assistShipment ?? runShipmentAssistantWithGemini;

  const basePerm = requiredPermissionForIntent(request.intent);
  const authCheck = await verifyFrontendIdentity(basePerm, resolveUser);
  if (!authCheck.ok) {
    return {
      ok: false,
      status: authCheck.status,
      intent:
        request.intent === "AUTO" ? "TRACKING_INQUIRY" : request.intent,
      message: authCheck.error,
      error: authCheck.error,
    };
  }

  const user = authCheck.user;
  const verifiedUser = toVerifiedSummary(user);

  // 1. Omnichannel AI Customer Support requests -> Customer Support + Autonomous Agent
  if (request.intent === "SUPPORT_MESSAGE") {
    const channel = request.payload?.channel ?? "WEBSITE_CHAT";
    const allowedChannels = new Set([
      "WEBSITE_CHAT",
      "WIDGET",
      "WHATSAPP",
      "TELEGRAM",
    ]);
    const sourceChannel = allowedChannels.has(channel)
      ? channel
      : "WEBSITE_CHAT";
    const message = String(request.payload?.message ?? "").trim();
    if (!message) {
      return {
        ok: false,
        status: 400,
        intent: "SUPPORT_MESSAGE",
        verifiedUser,
        message: "Type a message first.",
        error: "Type a message first.",
      };
    }

    const extId =
      request.payload?.sessionKey?.trim() || `portal:${user.id}`;

    const out: OmnichannelSupportTurnResult = await processSupportTurn({
      sourceChannel,
      externalId: extId,
      displayName: user.name || user.email,
      message,
      reference: request.payload?.reference?.trim() || null,
      orgId: user.orgId,
      actorEmail: user.email,
    });

    if (!out.ok) {
      return {
        ok: false,
        status: 400,
        intent: "SUPPORT_MESSAGE",
        verifiedUser,
        message: out.error ?? "Support agent request failed.",
        error: out.error ?? "Support agent request failed.",
      };
    }

    return {
      ok: true,
      status: 200,
      intent: out.autonomous?.intent ?? "SUPPORT_MESSAGE",
      verifiedUser,
      reply: out.reply,
      reference: out.reference,
      shipmentReference: out.reference ?? null,
      orderReference: out.orderReference ?? null,
      shouldEscalate: out.shouldEscalate,
      startedWork: Boolean(out.autonomous?.startedWork),
      delegatedAgents: out.autonomous?.delegatedAgents,
      message: out.reply ?? "Support message processed.",
    } as FrontendActionResult & { reference?: string | null };
  }

  // 2. Shipment-scoped internal assistant -> verified user + shipment context + orchestrator delegation
  if (request.intent === "SHIPMENT_ASSIST") {
    const reference = String(request.payload?.reference ?? "").trim();
    const text = String(request.payload?.question ?? "").trim();
    if (!reference) {
      return {
        ok: false,
        status: 400,
        intent: "SHIPMENT_ASSIST",
        verifiedUser,
        message: "Shipment reference is required.",
        error: "Shipment reference is required.",
      };
    }
    if (!text) {
      return {
        ok: false,
        status: 400,
        intent: "SHIPMENT_ASSIST",
        verifiedUser,
        message: "Type a question first.",
        error: "Type a question first.",
      };
    }
    if (text.length > 1000) {
      return {
        ok: false,
        status: 400,
        intent: "SHIPMENT_ASSIST",
        verifiedUser,
        message: "That question is too long.",
        error: "That question is too long.",
      };
    }

    const hasGeminiKey = Boolean(getServerGeminiKey());

    return runWithOrgScope(user.orgId, async () => {
      try {
        const setup = await transaction(async (client) => {
          const found = await client.query(
            `SELECT id FROM shipments WHERE upper(reference) = upper($1)`,
            [reference],
          );
          if (found.rowCount === 0) {
            return { ok: false as const, error: "No such shipment." };
          }
          const shipmentId = found.rows[0].id as string;

          await client.query(
            `INSERT INTO assistant_messages (shipment_id, user_id, role, body, state)
             VALUES ($1, $2, 'user', $3, 'DONE')`,
            [shipmentId, user.id, text],
          );

          const pending = await client.query(
            `INSERT INTO assistant_messages (shipment_id, user_id, role, state)
             VALUES ($1, $2, 'assistant', 'PENDING')
             RETURNING id`,
            [shipmentId, user.id],
          );
          const pendingId = pending.rows[0].id as string;

          if (!hasGeminiKey) {
            await client.query(
              `INSERT INTO work_items (shipment_id, kind, payload, priority, dedupe_key)
               VALUES ($1, 'shipment.assist', $2, 1, $3)
               ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
              [
                shipmentId,
                JSON.stringify({ message_id: pendingId }),
                `assist:${pendingId}`,
              ],
            );
          }

          return { ok: true as const, shipmentId, pendingId };
        });

        if (!setup.ok) {
          return {
            ok: false,
            status: 404,
            intent: "SHIPMENT_ASSIST",
            verifiedUser,
            message: setup.error,
            error: setup.error,
          };
        }

        if (hasGeminiKey) {
          try {
            const result = await assistShipment({
              reference,
              shipmentId: setup.shipmentId,
              question: text,
            });

            await query(
              `UPDATE assistant_messages
                  SET body = $1, state = $2, confidence = $3, next_step = $4
                WHERE id = $5`,
              [
                result.answer,
                "DONE",
                result.confidence.toFixed(3),
                result.nextStep,
                setup.pendingId,
              ],
            );

            await query(
              `INSERT INTO work_items (shipment_id, kind, state, payload, priority, dedupe_key)
               VALUES ($1, 'shipment.assist', 'DONE', $2, 1, $3)
               ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
              [
                setup.shipmentId,
                JSON.stringify({ message_id: setup.pendingId, engine: "gemini" }),
                `assist:${setup.pendingId}`,
              ],
            );

            return {
              ok: true,
              status: 200,
              intent: "SHIPMENT_ASSIST",
              verifiedUser,
              shipmentReference: reference.toUpperCase(),
              shipmentId: setup.shipmentId,
              reply: result.answer,
              message: result.answer,
            };
          } catch (geminiErr) {
            const mapped = classifyGeminiError(geminiErr);
            await query(
              `UPDATE assistant_messages
                  SET body = $1, state = $2, confidence = $3, next_step = $4
                WHERE id = $5`,
              [mapped.message, "FAILED", null, null, setup.pendingId],
            );
            return {
              ok: false,
              status: mapped.status,
              intent: "SHIPMENT_ASSIST",
              verifiedUser,
              shipmentReference: reference.toUpperCase(),
              message: mapped.message,
              error: mapped.message,
            };
          }
        }

        return {
          ok: true,
          status: 202,
          intent: "SHIPMENT_ASSIST",
          verifiedUser,
          shipmentReference: reference.toUpperCase(),
          shipmentId: setup.shipmentId,
          message: "Assistant question queued.",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Something went wrong.";
        return {
          ok: false,
          status: 500,
          intent: "SHIPMENT_ASSIST",
          verifiedUser,
          message: msg,
          error: msg,
        };
      }
    });
  }

  // 3. Approval decision -> atomic spend gate + forward APPROVAL_DECISION payload to Autonomous Agent
  if (request.intent === "APPROVAL_DECISION") {
    const token = String(request.payload?.token ?? "").trim();
    const approved = request.payload?.decision === "approve";
    if (!token) {
      return {
        ok: false,
        status: 400,
        intent: "APPROVAL_DECISION",
        verifiedUser,
        decided: false,
        message: "Approval token is required.",
        error: "Approval token is required.",
      };
    }

    return runWithOrgScope(user.orgId, async () => {
      const decided = await transaction(async (client) => {
        const result = await client.query(
          `UPDATE approvals
              SET state = $1, decided_by = $2, decided_at = now()
            WHERE token = $3 AND state = 'PENDING' AND expires_at > now()
          RETURNING id, shipment_id, proposed_action_id`,
          [approved ? "APPROVED" : "REJECTED", user.email, token],
        );

        if (result.rowCount === 0) {
          return null;
        }

        const row = result.rows[0];

        await client.query(
          `UPDATE proposed_actions SET state = $1, decided_at = now()
            WHERE id = $2 AND state = 'PROPOSED'`,
          [approved ? "APPROVED" : "REJECTED", row.proposed_action_id],
        );

        const params = await client.query(
          `SELECT params FROM proposed_actions WHERE id = $1`,
          [row.proposed_action_id],
        );
        const round = params.rows[0]?.params?.round ?? 1;

        await client.query(
          `INSERT INTO work_items (shipment_id, kind, payload, priority, dedupe_key)
           VALUES ($1, $2, $3, 10, $4)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [
            row.shipment_id,
            approved ? "approval.granted" : "approval.refused",
            JSON.stringify({
              approval_id: row.id,
              proposed_action_id: row.proposed_action_id,
              decided_by: user.email,
              round,
            }),
            `decision:${row.id}`,
          ],
        );

        return row;
      });

      if (!decided) {
        return {
          ok: true,
          status: 200,
          intent: "APPROVAL_DECISION",
          verifiedUser,
          decided: false,
          startedWork: false,
          message: "Approval token already decided or expired.",
        };
      }

      await recordAudit({
        actor: user.email,
        orgId: user.orgId,
        action: approved ? "APPROVAL_GRANTED" : "APPROVAL_DENIED",
        entityType: "approval",
        entityId: decided.id,
        after: {
          shipment_id: decided.shipment_id,
          proposed_action_id: decided.proposed_action_id,
          role: user.role,
        },
        ip: request.payload?.ip ?? null,
        userAgent: request.payload?.userAgent ?? null,
      });

      const shipmentRefRow = await query<{ reference: string }>(
        `SELECT reference FROM shipments WHERE id = $1`,
        [decided.shipment_id],
      ).catch(() => []);
      const ref = shipmentRefRow[0]?.reference ?? null;

      const autonomousOut = await dispatchAutonomous({
        sourceChannel: request.sourceChannel ?? "WEB_FORM_PLANNING",
        intentHint: "APPROVAL_DECISION",
        message: approved
          ? `Approval granted by ${user.email} (${user.role}). Validate carrier dispatch readiness, rate alignment, and post-decision compliance gates.`
          : `Approval denied by ${user.email} (${user.role}). Re-evaluate alternative carrier quotes, cost options, and escalation gates.`,
        reference: ref,
        orgId: user.orgId,
        actorEmail: user.email,
        mode: "background_orchestrate",
        skipEntityCreation: true,
      });

      return {
        ok: true,
        status: 200,
        intent: "APPROVAL_DECISION",
        verifiedUser,
        decided: true,
        startedWork: autonomousOut.startedWork,
        shipmentReference: ref,
        shipmentId: decided.shipment_id,
        delegatedAgents: autonomousOut.delegatedAgents,
        aiWarning: autonomousOut.aiWarning,
        message: approved
          ? `Approval granted and delegated for shipment ${ref ?? decided.shipment_id}.`
          : `Approval rejected and delegated for re-evaluation on ${ref ?? decided.shipment_id}.`,
      };
    });
  }

  // 4. Fleet optimization -> execute route optimization + forward FLEET_OPTIMIZE payload to Autonomous Agent
  if (request.intent === "FLEET_OPTIMIZE") {
    return runWithOrgScope(user.orgId, async () => {
      if (getServerGeminiKey()) {
        try {
          const { updatedCount, updatedReferences } = await optimizeFleet();
          await query(
            `INSERT INTO work_items (kind, state, payload, priority, dedupe_key)
             VALUES ('planning.optimize_fleet', 'DONE', '{"source": "action_controller"}'::jsonb, 10, $1)
             ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
            [`fleet-opt:${Math.floor(Date.now() / 5000)}`],
          );

          const autonomousOut = await dispatchAutonomous({
            sourceChannel: request.sourceChannel ?? "WEB_FORM_PLANNING",
            intentHint: "FLEET_OPTIMIZE",
            message: [
              `Fleet route optimization completed across ${updatedCount} shipments (${updatedReferences.join(", ") || "no reassignments"}).`,
              "Verify transit ETAs, corridor milestones, updated route cost estimates against policy caps, and active FX rates.",
              request.payload?.notes?.trim() || "",
            ]
              .filter(Boolean)
              .join(" "),
            reference: updatedReferences[0] ?? null,
            orgId: user.orgId,
            actorEmail: user.email,
            mode: "background_orchestrate",
            skipEntityCreation: true,
          });

          return {
            ok: true,
            status: 200,
            intent: "FLEET_OPTIMIZE",
            verifiedUser,
            updatedCount,
            startedWork: autonomousOut.startedWork,
            delegatedAgents: autonomousOut.delegatedAgents,
            aiWarning: autonomousOut.aiWarning,
            message:
              updatedCount > 0
                ? `Fleet routes and vehicle assignments updated across ${updatedCount} shipment${updatedCount === 1 ? "" : "s"}.`
                : "Fleet routes reviewed; no active shipments required reassignment.",
          };
        } catch (error) {
          const mapped = classifyGeminiError(error);
          return {
            ok: false,
            status: mapped.status,
            intent: "FLEET_OPTIMIZE",
            verifiedUser,
            message: mapped.message,
            error: mapped.message,
          };
        }
      }

      try {
        await query(
          `INSERT INTO work_items (kind, payload, priority, dedupe_key)
           VALUES ('planning.optimize_fleet', '{"source": "action_controller"}'::jsonb, 10, $1)
           ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
          [`cuopt-fleet:${Math.floor(Date.now() / 10000)}`],
        );

        const autonomousOut = await dispatchAutonomous({
          sourceChannel: request.sourceChannel ?? "WEB_FORM_PLANNING",
          intentHint: "FLEET_OPTIMIZE",
          message:
            request.payload?.notes?.trim() ||
            "Fleet optimization queued from planning controller.",
          orgId: user.orgId,
          actorEmail: user.email,
          mode: "background_orchestrate",
          skipEntityCreation: true,
        });

        return {
          ok: true,
          status: 202,
          intent: "FLEET_OPTIMIZE",
          verifiedUser,
          startedWork: autonomousOut.startedWork,
          delegatedAgents: autonomousOut.delegatedAgents,
          message: "Fleet route optimization job queued.",
        };
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Could not queue optimization.";
        return {
          ok: false,
          status: 500,
          intent: "FLEET_OPTIMIZE",
          verifiedUser,
          message: msg,
          error: msg,
        };
      }
    });
  }

  // 5. Website Order intake -> forward NEW_ORDER payload to Autonomous Agent
  if (request.intent === "NEW_ORDER") {
    const p = request.payload;
    const originCity = p?.originCity?.trim() ?? "";
    const destinationCity = p?.destinationCity?.trim() ?? "";
    const cargoDescription = p?.cargoDescription?.trim() ?? "";
    if (!originCity || !destinationCity || !cargoDescription) {
      return {
        ok: false,
        status: 400,
        intent: "NEW_ORDER",
        verifiedUser,
        message: "Origin city, destination city, and cargo description are required.",
        error: "Origin city, destination city, and cargo description are required.",
      };
    }

    const weightKg = Number(p.weightKg) > 0 ? Number(p.weightKg) : 100;
    const quantity = Number(p.quantity) > 0 ? Math.round(Number(p.quantity)) : 1;
    const customerName = p.customerName?.trim() || user.name || user.email;

    const summaryMessage = [
      `Website order request for ${customerName}:`,
      `${quantity} units (${weightKg} kg) of ${cargoDescription}`,
      `from ${originCity} to ${destinationCity}.`,
      p.hazmat ? "Hazmat handling required." : "",
      p.reefer ? "Temperature-controlled reefer required." : "",
      p.notes?.trim() ? `Notes: ${p.notes.trim()}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const out: AutonomousDispatchResult = await dispatchAutonomous({
      sourceChannel: request.sourceChannel ?? "WEB_FORM_ORDER",
      intentHint: "NEW_ORDER",
      message: summaryMessage,
      displayName: customerName,
      orgId: user.orgId,
      actorEmail: user.email,
      mode: "sync_orchestrate",
      structured: {
        customerName,
        originCity,
        destinationCity,
        cargoDescription,
        weightKg,
        quantity,
        deadlineIso: p.deadlineIso?.trim() || null,
        preferredMode: p.preferredMode?.trim() || "ROAD",
        hazmat: Boolean(p.hazmat),
        reefer: Boolean(p.reefer),
        currency: p.currency?.trim() || "NGN",
        notes: p.notes?.trim() || null,
      },
    });

    return {
      ok: true,
      status: out.orderReference || out.shipmentReference ? 201 : 200,
      intent: out.intent,
      verifiedUser,
      startedWork: out.startedWork,
      orderReference: out.orderReference,
      shipmentReference: out.shipmentReference,
      shipmentId: out.shipmentId,
      delegatedAgents: out.delegatedAgents,
      orchestrationSummary: out.orchestrationSummary,
      aiWarning: out.aiWarning,
      message: out.shipmentReference
        ? `Order ${out.orderReference ?? ""} accepted and queued as shipment ${out.shipmentReference}.`
        : "Order intake recorded and processing started.",
    };
  }

  // 6. Website Planning & Routing intake -> forward PLANNING_ROUTING payload to Autonomous Agent
  if (request.intent === "PLANNING_ROUTING") {
    const p = request.payload ?? {};
    const ref = p.reference?.trim().toUpperCase() || null;
    const originCity = p.originCity?.trim() || null;
    const destinationCity = p.destinationCity?.trim() || null;
    const notes = p.notes?.trim() || "";

    if (!ref && (!originCity || !destinationCity) && !notes) {
      return {
        ok: false,
        status: 400,
        intent: "PLANNING_ROUTING",
        verifiedUser,
        message:
          "Provide a shipment reference, origin & destination cities, or routing instructions.",
        error:
          "Provide a shipment reference, origin & destination cities, or routing instructions.",
      };
    }

    const msg = [
      "Website routing & planning request:",
      ref ? `Shipment ${ref}.` : "",
      originCity && destinationCity ? `Lane ${originCity} -> ${destinationCity}.` : "",
      p.preferredMode ? `Preferred mode: ${p.preferredMode}.` : "",
      notes,
    ]
      .filter(Boolean)
      .join(" ");

    const out = await dispatchAutonomous({
      sourceChannel: request.sourceChannel ?? "WEB_FORM_PLANNING",
      intentHint: "PLANNING_ROUTING",
      message: msg,
      reference: ref,
      displayName: user.name || user.email,
      orgId: user.orgId,
      actorEmail: user.email,
      mode: "sync_orchestrate",
      structured: {
        originCity,
        destinationCity,
        preferredMode: p.preferredMode?.trim() || "ROAD",
        deadlineIso: p.deadlineIso?.trim() || null,
        notes: notes || null,
      },
    });

    return {
      ok: true,
      status: out.orderReference || out.shipmentReference ? 201 : 200,
      intent: out.intent,
      verifiedUser,
      startedWork: out.startedWork,
      orderReference: out.orderReference,
      shipmentReference: out.shipmentReference,
      shipmentId: out.shipmentId,
      delegatedAgents: out.delegatedAgents,
      orchestrationSummary: out.orchestrationSummary,
      aiWarning: out.aiWarning,
      message: out.shipmentReference
        ? `Routing & planning request initiated for ${out.shipmentReference}.`
        : "Corridor planning request initiated and dispatched.",
    };
  }

  // 7. Generic / Auto-classified intent-based frontend requests
  const genericMessage = String(request.payload?.message ?? "").trim();
  if (!genericMessage) {
    return {
      ok: false,
      status: 400,
      intent:
        request.intent === "AUTO" ? "TRACKING_INQUIRY" : request.intent,
      verifiedUser,
      message: "Message or request instructions are required.",
      error: "Message or request instructions are required.",
    };
  }
  if (genericMessage.length > 2000) {
    return {
      ok: false,
      status: 400,
      intent:
        request.intent === "AUTO" ? "TRACKING_INQUIRY" : request.intent,
      verifiedUser,
      message: "Request message exceeds 2000 characters.",
      error: "Request message exceeds 2000 characters.",
    };
  }

  const resolvedIntent: AutonomousIntent =
    request.intent === "AUTO"
      ? classifyAutonomousIntent(
          genericMessage,
          undefined,
          request.payload?.structured,
        )
      : request.intent;

  // Enforce write permission when AUTO resolves to a mutating intent
  if (
    request.intent === "AUTO" &&
    MUTATING_AUTONOMOUS_INTENTS.has(resolvedIntent) &&
    !may(user.role, "EDIT_SHIPMENT")
  ) {
    return {
      ok: false,
      status: 403,
      intent: resolvedIntent,
      verifiedUser,
      message: `Your role (${user.role}) is not permitted to perform ${resolvedIntent}.`,
      error: `Your role (${user.role}) is not permitted to perform ${resolvedIntent}.`,
    };
  }

  const out = await dispatchAutonomous({
    sourceChannel: request.sourceChannel ?? "WEB_FORM_ORDER",
    intentHint: resolvedIntent,
    message: genericMessage,
    reference: request.payload?.reference?.trim() || null,
    displayName: user.name || user.email,
    orgId: user.orgId,
    actorEmail: user.email,
    mode: "sync_orchestrate",
    structured: request.payload?.structured,
  });

  return {
    ok: true,
    status: out.orderReference || out.shipmentReference ? 201 : 200,
    intent: out.intent,
    verifiedUser,
    startedWork: out.startedWork,
    orderReference: out.orderReference,
    shipmentReference: out.shipmentReference,
    shipmentId: out.shipmentId,
    delegatedAgents: out.delegatedAgents,
    orchestrationSummary: out.orchestrationSummary,
    aiWarning: out.aiWarning,
    message: out.shipmentReference
      ? `Logistics request (${out.intent}) delegated for ${out.shipmentReference}.`
      : `Logistics request (${out.intent}) forwarded to autonomous agent.`,
  };
}
