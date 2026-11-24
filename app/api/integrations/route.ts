import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { currentUser, may } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import {
  SYSTEM_CONNECTOR_TEMPLATES,
  type AutonomyMode,
} from "@/lib/integrations/catalog";
import {
  createOrgConnector,
  listOrgConnectors,
  listOrgIntegrationEvents,
} from "@/lib/integrations/store";
import { verifySameOriginRequest } from "@/lib/integrations/security";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const [connectors, events] = await Promise.all([
    listOrgConnectors(user.orgId),
    listOrgIntegrationEvents(user.orgId, 60),
  ]);

  return NextResponse.json({
    ok: true,
    connectors,
    events,
    templates: SYSTEM_CONNECTOR_TEMPLATES,
  });
}

const VALID_AUTONOMY = new Set<AutonomyMode>([
  "FULL_AUTONOMOUS",
  "ASSISTED_APPROVAL",
  "SYNC_ONLY",
]);

export async function POST(req: NextRequest) {
  if (!verifySameOriginRequest(req.headers)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (!may(user.role, "ADMINISTER") && !may(user.role, "EDIT_SHIPMENT")) {
    return NextResponse.json(
      { error: "Your role is not permitted to create system integrations." },
      { status: 403 },
    );
  }

  let body: {
    name?: string;
    systemType?: string;
    autonomyMode?: AutonomyMode;
    outboundWebhookUrl?: string | null;
    outboundEvents?: string[];
    fieldMapping?: Record<string, string>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 100) {
    return NextResponse.json(
      { error: "Connector name must be between 2 and 100 characters." },
      { status: 400 },
    );
  }

  const autonomyMode: AutonomyMode =
    body.autonomyMode && VALID_AUTONOMY.has(body.autonomyMode)
      ? body.autonomyMode
      : "FULL_AUTONOMOUS";

  const cleanFieldMapping: Record<string, string> = {};
  if (body.fieldMapping && typeof body.fieldMapping === "object") {
    for (const [k, v] of Object.entries(body.fieldMapping)) {
      if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) {
        cleanFieldMapping[k.trim().slice(0, 64)] = v.trim().slice(0, 160);
      }
    }
  }

  try {
    const created = await createOrgConnector({
      orgId: user.orgId,
      name,
      systemType:
        typeof body.systemType === "string" && body.systemType.trim()
          ? body.systemType.trim()
          : "custom_rest_webhook",
      autonomyMode,
      outboundWebhookUrl:
        typeof body.outboundWebhookUrl === "string"
          ? body.outboundWebhookUrl.trim() || null
          : null,
      outboundEvents: Array.isArray(body.outboundEvents)
        ? body.outboundEvents.filter((x): x is string => typeof x === "string").slice(0, 12)
        : undefined,
      fieldMapping: cleanFieldMapping,
      createdBy: user.email,
    });

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      orgId: user.orgId,
      action: "INTEGRATION_CONNECTOR_CREATED",
      entityType: created.connector.name,
      after: {
        connectorId: created.connector.id,
        systemType: created.connector.systemType,
        autonomyMode: created.connector.autonomyMode,
      },
    });

    revalidatePath("/integrations");
    revalidatePath("/settings");

    return NextResponse.json({ ok: true, ...created }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not create connector." },
      { status: 400 },
    );
  }
}
