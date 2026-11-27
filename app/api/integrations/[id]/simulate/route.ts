import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { currentUser, may } from "@/lib/auth";
import { processUniversalIngestion } from "@/lib/integrations/engine";
import { verifySameOriginRequest } from "@/lib/integrations/security";
import { getOrgConnector } from "@/lib/integrations/store";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;

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
      { error: "Your role is not permitted to ingest external payloads." },
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
      { error: "This connector is currently paused. Resume it before ingesting payloads." },
      { status: 409 },
    );
  }

  let body: {
    payload?: string | Record<string, unknown> | Record<string, unknown>[];
    contentType?: string;
    idempotencyKey?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  if (body.payload === undefined || body.payload === null || body.payload === "") {
    return NextResponse.json(
      { error: "Provide a JSON, SQL dump, CSV, NDJSON, or EDI X12 payload to ingest." },
      { status: 400 },
    );
  }

  const serializedSize =
    typeof body.payload === "string"
      ? Buffer.byteLength(body.payload, "utf8")
      : Buffer.byteLength(JSON.stringify(body.payload), "utf8");
  if (serializedSize > MAX_BYTES) {
    return NextResponse.json(
      { error: "Payload exceeds the 2 MB single-request limit." },
      { status: 413 },
    );
  }

  const result = await processUniversalIngestion({
    connector,
    rawPayload: body.payload,
    contentType: body.contentType ?? null,
    idempotencyKey: body.idempotencyKey?.trim() || null,
    actorEmail: user.email,
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

  return NextResponse.json(result, { status: result.processed > 0 ? 201 : 200 });
}
