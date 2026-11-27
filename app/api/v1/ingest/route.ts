import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { processUniversalIngestion } from "@/lib/integrations/engine";
import { authenticateConnectorApiKey } from "@/lib/integrations/store";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function extractApiKey(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  const headerKey = req.headers.get("x-api-key")?.trim();
  return headerKey || null;
}

export async function POST(req: NextRequest) {
  const apiKey = extractApiKey(req);
  const connector = await authenticateConnectorApiKey(apiKey);
  if (!connector) {
    return NextResponse.json(
      {
        error:
          "Unauthorized. Supply a valid connector API key via Authorization: Bearer <key> or X-API-Key header.",
      },
      { status: 401 },
    );
  }

  if (connector.status === "PAUSED") {
    return NextResponse.json(
      {
        error: `Connector '${connector.name}' is currently paused in Control Tower.`,
      },
      { status: 403 },
    );
  }

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "Payload exceeds the 2 MB request limit." },
      { status: 413 },
    );
  }

  const rawText = await req.text();
  if (!rawText.trim()) {
    return NextResponse.json(
      { error: "Request body is empty. Send JSON, SQL dump, CSV, NDJSON, or EDI X12 payload." },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(rawText, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "Payload exceeds the 2 MB request limit." },
      { status: 413 },
    );
  }

  const idempotencyKey =
    req.headers.get("idempotency-key")?.trim() ||
    req.headers.get("x-idempotency-key")?.trim() ||
    null;

  const result = await processUniversalIngestion({
    connector,
    rawPayload: rawText,
    contentType: req.headers.get("content-type"),
    idempotencyKey,
    actorEmail: `api@${connector.system_type}`,
    syncOrchestrate: true,
    maxRecords: 250,
  });

  for (const path of [
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
  ]) {
    revalidatePath(path);
  }

  return NextResponse.json(
    {
      ok: result.ok,
      connectorId: result.connectorId,
      connectorName: result.connectorName,
      autonomyMode: result.autonomyMode,
      format: result.format,
      totalReceived: result.totalReceived,
      processed: result.processed,
      duplicates: result.duplicates,
      failed: result.failed,
      entityCounts: result.entityCounts,
      takeoverSummary: result.takeoverSummary,
      results: result.outcomes.map((o) => ({
        index: o.index,
        status: o.status,
        entityType: o.entityType,
        mappedBy: o.mappedBy,
        externalRef: o.externalRef,
        orderReference: o.orderReference,
        shipmentReference: o.shipmentReference,
        delegatedAgents: o.delegatedAgents,
        summary: o.summary,
        orchestrationSummary: o.orchestrationSummary,
        outboundWebhookStatus: o.outboundWebhookStatus,
        error: o.error,
      })),
    },
    { status: result.processed > 0 ? 201 : result.failed > 0 ? 422 : 200 },
  );
}
