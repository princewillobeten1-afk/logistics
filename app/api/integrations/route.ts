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
import { detectWorkspaceTampering } from "@/lib/tenant-guard";
import type { IntegrationConnectionMode } from "@/lib/local-store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
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

const VALID_CONNECTION_MODES = new Set<IntegrationConnectionMode>([
  "PUSH_WEBHOOK",
  "PULL_API",
  "POSTGRES_DB",
  "WEBSITE_EMBED",
  "FILE_IMPORT",
]);

export async function POST(req: NextRequest) {
  if (!verifySameOriginRequest(req.headers)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
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
    connectionMode?: IntegrationConnectionMode;
    autoTakeover?: boolean;
    sourceUrl?: string | null;
    sourceAuthHeader?: string | null;
    databaseUrl?: string | null;
    dbTables?: string[];
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

  const connectionMode =
    body.connectionMode && VALID_CONNECTION_MODES.has(body.connectionMode)
      ? body.connectionMode
      : undefined;

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
      connectionMode,
      autoTakeover: body.autoTakeover !== false,
      sourceUrl:
        typeof body.sourceUrl === "string" ? body.sourceUrl.trim() || null : null,
      sourceAuthHeader:
        typeof body.sourceAuthHeader === "string"
          ? body.sourceAuthHeader.trim() || null
          : null,
      databaseUrl:
        typeof body.databaseUrl === "string" ? body.databaseUrl.trim() || null : null,
      dbTables: Array.isArray(body.dbTables)
        ? body.dbTables.filter((x): x is string => typeof x === "string").slice(0, 60)
        : undefined,
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
        connectionMode: created.connector.connectionMode,
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
