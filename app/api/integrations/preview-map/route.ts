import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  detectAndParseRawPayload,
  normalizeExternalRecord,
} from "@/lib/integrations/mapper";
import { getOrgConnector } from "@/lib/integrations/store";

export const dynamic = "force-dynamic";

const MAX_BYTES = 256 * 1024;

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  let body: {
    payload?: string | Record<string, unknown> | Record<string, unknown>[];
    connectorId?: string;
    fieldMapping?: Record<string, string>;
    forceAi?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.payload === undefined || body.payload === null || body.payload === "") {
    return NextResponse.json(
      { error: "Paste any JSON, CSV, or EDI X12 payload to preview mapping." },
      { status: 400 },
    );
  }

  const size =
    typeof body.payload === "string"
      ? Buffer.byteLength(body.payload, "utf8")
      : Buffer.byteLength(JSON.stringify(body.payload), "utf8");
  if (size > MAX_BYTES) {
    return NextResponse.json(
      { error: "Preview payload exceeds 256 KB limit." },
      { status: 413 },
    );
  }

  let mapping = body.fieldMapping ?? {};
  let systemName = "External System";
  if (body.connectorId) {
    const conn = await getOrgConnector(body.connectorId, user.orgId);
    if (conn) {
      mapping = { ...conn.field_mapping, ...mapping };
      systemName = conn.name;
    }
  }

  const parsed = detectAndParseRawPayload(body.payload);
  if (parsed.records.length === 0) {
    return NextResponse.json(
      { error: "Could not parse any records from the provided payload." },
      { status: 400 },
    );
  }

  const sampleRecords = parsed.records.slice(0, 5);
  const normalizedRecords = await Promise.all(
    sampleRecords.map((rec) =>
      normalizeExternalRecord(rec, {
        fieldMapping: mapping,
        systemName,
        forceAi: Boolean(body.forceAi),
      }),
    ),
  );

  const mergedSuggestedMappings: Record<string, string> = {};
  for (const nr of normalizedRecords) {
    if (nr.suggestedFieldMapping) {
      Object.assign(mergedSuggestedMappings, nr.suggestedFieldMapping);
    }
  }

  return NextResponse.json({
    ok: true,
    format: parsed.format,
    totalRecordsDetected: parsed.records.length,
    previewedCount: normalizedRecords.length,
    records: normalizedRecords,
    suggestedFieldMapping: mergedSuggestedMappings,
  });
}
