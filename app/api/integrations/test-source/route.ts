import { NextRequest, NextResponse } from "next/server";
import { currentUser, may } from "@/lib/auth";
import {
  discoverExternalPostgresTables,
  testAndFetchExternalApi,
} from "@/lib/integrations/pull-sync";
import { verifySameOriginRequest } from "@/lib/integrations/security";
import { detectWorkspaceTampering } from "@/lib/tenant-guard";

export const dynamic = "force-dynamic";

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
      { error: "Your role is not permitted to test external system connections." },
      { status: 403 },
    );
  }

  let body: {
    mode?: "POSTGRES" | "API";
    databaseUrl?: string;
    sourceUrl?: string;
    sourceAuthHeader?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.mode === "POSTGRES") {
    const dbUrl = typeof body.databaseUrl === "string" ? body.databaseUrl.trim() : "";
    if (!dbUrl) {
      return NextResponse.json(
        { error: "Enter a read-only PostgreSQL connection URI." },
        { status: 400 },
      );
    }
    const result = await discoverExternalPostgresTables(dbUrl);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json(result);
  }

  if (body.mode === "API") {
    const srcUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
    if (!srcUrl) {
      return NextResponse.json(
        { error: "Enter a public HTTPS API or feed URL to test." },
        { status: 400 },
      );
    }
    const result = await testAndFetchExternalApi({
      sourceUrl: srcUrl,
      authHeader:
        typeof body.sourceAuthHeader === "string" ? body.sourceAuthHeader : null,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      statusCode: result.statusCode,
      format: result.format,
      totalRecords: result.totalRecords,
      entityBreakdown: result.entityBreakdown,
    });
  }

  return NextResponse.json(
    { error: "Specify mode: 'POSTGRES' or 'API'." },
    { status: 400 },
  );
}
