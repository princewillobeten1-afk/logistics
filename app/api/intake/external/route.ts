import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  dispatchToAutonomousAgent,
  type AutonomousIntent,
} from "@/lib/agents/autonomous";
import { currentUser, may } from "@/lib/auth";
import { authenticateConnectorApiKey } from "@/lib/integrations/store";
import {
  checkDistributedTenantRateLimit,
  claimDistributedWebhookReplay,
} from "@/lib/distributed-guard";
import {
  detectWorkspaceTampering,
  hasDepartmentAccess,
} from "@/lib/tenant-guard";
import { resolveOrgByIntakeApiKey } from "@/lib/workspace-admin";

export const dynamic = "force-dynamic";

const TYPE_TO_INTENT: Record<string, AutonomousIntent> = {
  order: "NEW_ORDER",
  new_order: "NEW_ORDER",
  shipment: "NEW_ORDER",
  booking: "NEW_ORDER",
  planning: "PLANNING_ROUTING",
  routing: "PLANNING_ROUTING",
  reroute: "PLANNING_ROUTING",
  route: "PLANNING_ROUTING",
  action: "SHIPMENT_ACTION",
  update: "SHIPMENT_ACTION",
  exception: "EXCEPTION_REPORT",
  delay: "EXCEPTION_REPORT",
  incident: "EXCEPTION_REPORT",
  customs: "CUSTOMS_DOCS",
  document: "CUSTOMS_DOCS",
  billing: "BILLING_INVOICE",
  invoice: "BILLING_INVOICE",
  info: "SHIPMENT_ACTION",
  tracking: "TRACKING_INQUIRY",
};

export async function POST(req: NextRequest) {
  let orgId: string | null = null;
  let actorEmail = "api@external-intake";

  const user = await currentUser();
  if (user) {
    if (!may(user.role, "EDIT_SHIPMENT") || !hasDepartmentAccess(user, "ORDERS")) {
      return NextResponse.json(
        { error: "Your role or department does not permit external order intake." },
        { status: 403 },
      );
    }
    orgId = user.orgId;
    actorEmail = user.email;
  } else {
    const bearer = req.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim();
    const headerToken =
      req.headers.get("x-intake-token")?.trim() ||
      req.headers.get("x-api-key")?.trim() ||
      bearer ||
      null;

    if (headerToken) {
      const wsOrg = await resolveOrgByIntakeApiKey(headerToken);
      if (wsOrg) {
        orgId = wsOrg.id;
        actorEmail = `intake:${wsOrg.intake_api_key_prefix ?? "key"}`;
      } else {
        const connector = await authenticateConnectorApiKey(headerToken);
        if (connector && connector.status === "ACTIVE") {
          orgId = connector.org_id;
          actorEmail = `connector:${connector.id}`;
        }
      }
    }
  }

  if (!orgId) {
    return NextResponse.json(
      {
        error:
          "Authentication required. Sign in or supply a valid per-workspace Intake API key or Connector API key.",
      },
      { status: 401 },
    );
  }

  const rate = await checkDistributedTenantRateLimit(orgId, "intake:external", 90, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Workspace intake rate limit exceeded." },
      { status: 429 },
    );
  }

  const deliveryId =
    req.headers.get("idempotency-key")?.trim() ||
    req.headers.get("x-delivery-id")?.trim() ||
    req.headers.get("x-webhook-id")?.trim() ||
    null;
  if (deliveryId) {
    const replay = await claimDistributedWebhookReplay(
      orgId,
      "EXTERNAL_INTAKE",
      deliveryId,
    );
    if (!replay.fresh) {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        message: "Duplicate intake delivery ignored.",
      });
    }
  }

  let body: {
    type?: string;
    intent?: AutonomousIntent;
    source?: string;
    message?: string;
    reference?: string;
    customerName?: string;
    customerEmail?: string;
    origin?: string;
    originCity?: string;
    destination?: string;
    destinationCity?: string;
    cargo?: string;
    cargoDescription?: string;
    weightKg?: number;
    quantity?: number;
    deadline?: string;
    deadlineIso?: string;
    requiredBy?: string;
    preferredMode?: string;
    hazmat?: boolean;
    reefer?: boolean;
    currency?: string;
    notes?: string;
  } & Record<string, unknown>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const tamper = detectWorkspaceTampering(req, orgId, body);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const originCity = (body.originCity ?? body.origin)?.trim() || null;
  const destinationCity = (body.destinationCity ?? body.destination)?.trim() || null;
  const cargoDescription = (body.cargoDescription ?? body.cargo)?.trim() || null;
  const deadlineIso = (body.deadlineIso ?? body.deadline ?? body.requiredBy)?.trim() || null;
  const rawMessage =
    body.message?.trim() ||
    [
      body.type ? `External ${body.type} intake` : "External logistics intake",
      originCity && destinationCity ? `from ${originCity} to ${destinationCity}` : "",
      cargoDescription ? `cargo: ${cargoDescription}` : "",
      body.reference ? `ref: ${body.reference}` : "",
      body.notes ? `notes: ${body.notes}` : "",
    ]
      .filter(Boolean)
      .join(" · ");

  if (!rawMessage) {
    return NextResponse.json(
      { error: "Provide a message or structured order/planning details." },
      { status: 400 },
    );
  }

  const mappedIntent =
    body.intent ??
    (body.type ? TYPE_TO_INTENT[body.type.trim().toLowerCase()] : undefined);

  const out = await dispatchToAutonomousAgent({
    sourceChannel: "EXTERNAL_API",
    intentHint: mappedIntent,
    message: rawMessage,
    reference: body.reference ?? null,
    externalId: body.source?.trim() || "external-api",
    displayName: body.customerName ?? body.source ?? "External Partner",
    orgId,
    actorEmail: user?.email ?? body.customerEmail ?? actorEmail,
    mode: "sync_orchestrate",
    structured: {
      originCity,
      destinationCity,
      cargoDescription,
      weightKg:
        typeof body.weightKg === "number" && Number.isFinite(body.weightKg)
          ? body.weightKg
          : null,
      quantity:
        typeof body.quantity === "number" && Number.isFinite(body.quantity)
          ? Math.round(body.quantity)
          : null,
      deadlineIso,
      preferredMode: body.preferredMode ?? null,
      customerName: body.customerName ?? null,
      customerEmail: body.customerEmail ?? null,
      hazmat: Boolean(body.hazmat),
      reefer: Boolean(body.reefer),
      currency: body.currency ?? "NGN",
      notes: body.notes ?? null,
    },
  });

  revalidatePath("/orders");
  revalidatePath("/shipments");
  revalidatePath("/planning");
  revalidatePath("/exceptions");
  revalidatePath("/queue");
  revalidatePath("/activity");

  return NextResponse.json(
    {
      ok: true,
      ...out,
    },
    { status: out.orderReference || out.shipmentReference ? 201 : 200 },
  );
}
