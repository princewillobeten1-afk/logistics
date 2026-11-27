import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { currentUser, may } from "@/lib/auth";
import { processUniversalIngestion } from "@/lib/integrations/engine";
import {
  pullExternalPostgresRecords,
  testAndFetchExternalApi,
} from "@/lib/integrations/pull-sync";
import { verifySameOriginRequest } from "@/lib/integrations/security";
import { getOrgConnector, unsealConnectorSecrets } from "@/lib/integrations/store";

export const dynamic = "force-dynamic";

const ALL_REVALIDATE_PATHS = [
  "/",
  "/integrations",
  "/orders",
  "/shipments",
  "/planning",
  "/carriers",
  "/fleet",
  "/warehouses",
  "/customers",
  "/approvals",
  "/exceptions",
  "/map",
  "/analytics",
  "/queue",
  "/activity",
];

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!verifySameOriginRequest(req.headers)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (!may(user.role, "EDIT_SHIPMENT") && !may(user.role, "ADMINISTER")) {
    return NextResponse.json(
      { error: "Your role is not permitted to trigger live syncs." },
      { status: 403 },
    );
  }

  const { id } = await context.params;
  const connector = await getOrgConnector(id, user.orgId);
  if (!connector) {
    return NextResponse.json({ error: "Connector not found." }, { status: 404 });
  }
  if (connector.status === "PAUSED") {
    return NextResponse.json(
      { error: "Connector is paused. Resume it before running a live sync." },
      { status: 409 },
    );
  }

  const { sourceAuthHeader, databaseUrl } = unsealConnectorSecrets(connector);
  let pulledRecords: Record<string, unknown>[] = [];
  let tablesSynced: string[] = [];
  let sourceKind: "POSTGRES_DB" | "PULL_API" = "PULL_API";

  if (databaseUrl) {
    sourceKind = "POSTGRES_DB";
    const dbRes = await pullExternalPostgresRecords(
      databaseUrl,
      connector.db_tables && connector.db_tables.length > 0
        ? connector.db_tables
        : undefined,
    );
    if (!dbRes.ok) {
      return NextResponse.json(
        { error: dbRes.error ?? "Database sync failed." },
        { status: 400 },
      );
    }
    pulledRecords = dbRes.records;
    tablesSynced = dbRes.tablesSynced;
  } else if (connector.source_url) {
    sourceKind = "PULL_API";
    const apiRes = await testAndFetchExternalApi({
      sourceUrl: connector.source_url,
      authHeader: sourceAuthHeader,
    });
    if (!apiRes.ok) {
      return NextResponse.json(
        { error: apiRes.error ?? "External API sync failed." },
        { status: 400 },
      );
    }
    pulledRecords = apiRes.records;
  } else {
    return NextResponse.json(
      {
        error:
          "This connector does not have a live Pull API URL or PostgreSQL database URI configured. Configure one or push data via webhook/import.",
      },
      { status: 400 },
    );
  }

  if (pulledRecords.length === 0) {
    return NextResponse.json({
      ok: true,
      sourceKind,
      tablesSynced,
      connectorId: connector.id,
      connectorName: connector.name,
      totalReceived: 0,
      processed: 0,
      duplicates: 0,
      failed: 0,
      entityCounts: {},
      takeoverSummary: { booked: 0, awaitingApproval: 0 },
      outcomes: [],
      events: [],
    });
  }

  const result = await processUniversalIngestion({
    connector,
    rawPayload: pulledRecords,
    contentType: "application/json",
    actorEmail: user.email,
    syncOrchestrate: true,
    maxRecords: 250,
  });

  for (const path of ALL_REVALIDATE_PATHS) {
    revalidatePath(path);
  }

  return NextResponse.json(
    {
      ...result,
      sourceKind,
      tablesSynced,
    },
    { status: result.processed > 0 ? 201 : 200 },
  );
}
