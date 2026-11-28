import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  detectAndParseRawPayload,
  normalizeExternalRecord,
  normalizeRecordDeterministically,
} from "@/lib/integrations/mapper";
import { verifySameOriginRequest } from "@/lib/integrations/security";
import { getOrgConnector } from "@/lib/integrations/store";
import { detectWorkspaceTampering } from "@/lib/tenant-guard";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;

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
      { error: "Paste any JSON, SQL dump, CSV, NDJSON, or EDI X12 payload to preview mapping." },
      { status: 400 },
    );
  }

  const size =
    typeof body.payload === "string"
      ? Buffer.byteLength(body.payload, "utf8")
      : Buffer.byteLength(JSON.stringify(body.payload), "utf8");
  if (size > MAX_BYTES) {
    return NextResponse.json(
      { error: "Preview payload exceeds 2 MB limit." },
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

  const entityBreakdown: Record<string, number> = {};
  for (const rec of parsed.records.slice(0, 500)) {
    const { normalized } = normalizeRecordDeterministically(rec, mapping);
    entityBreakdown[normalized.entityType] =
      (entityBreakdown[normalized.entityType] ?? 0) + 1;
  }

  const sampleRecords = parsed.records.slice(0, 8);
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
    entityBreakdown,
    records: normalizedRecords,
    suggestedFieldMapping: mergedSuggestedMappings,
  });
}
