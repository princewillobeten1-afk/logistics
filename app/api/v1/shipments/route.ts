import { NextRequest, NextResponse } from "next/server";
import { query, runWithOrgScope } from "@/lib/db";
import { authenticateConnectorApiKey } from "@/lib/integrations/store";

export const dynamic = "force-dynamic";

function extractApiKey(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  const headerKey = req.headers.get("x-api-key")?.trim();
  return headerKey || null;
}

export async function GET(req: NextRequest) {
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
      { error: `Connector '${connector.name}' is currently paused.` },
      { status: 403 },
    );
  }

  const stateParam = req.nextUrl.searchParams.get("state")?.trim().toUpperCase() || null;
  const refParam = req.nextUrl.searchParams.get("reference")?.trim().toUpperCase() || null;

  const data = await runWithOrgScope(connector.org_id, async () => {
    if (refParam) {
      const rows = await query<{
        id: string;
        reference: string;
        state: string;
        customer_ref: string | null;
        origin: Record<string, unknown>;
        destination: Record<string, unknown>;
        cargo: Record<string, unknown>;
        deadline: Date | null;
        plan: Record<string, unknown> | null;
        updated_at: Date;
      }>(`SELECT * FROM shipments WHERE reference = $1 LIMIT 1`, [refParam]);
      return rows;
    }

    if (stateParam) {
      return query(
        `SELECT * FROM shipments WHERE state = $1 ORDER BY updated_at DESC LIMIT 100`,
        [stateParam],
      );
    }

    return query(`SELECT * FROM shipments ORDER BY updated_at DESC LIMIT 100`);
  });

  return NextResponse.json({
    ok: true,
    connectorId: connector.id,
    count: data.length,
    shipments: data,
  });
}
