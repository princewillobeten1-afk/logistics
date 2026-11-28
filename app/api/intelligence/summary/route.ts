import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { collectBiSnapshot, parseBiPeriod } from "@/lib/intelligence/collector";
import {
  detectWorkspaceTampering,
  hasDepartmentAccess,
} from "@/lib/tenant-guard";

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
  if (!hasDepartmentAccess(user, "BI")) {
    return NextResponse.json(
      { error: "Your department scope does not include Business Intelligence." },
      { status: 403 },
    );
  }

  const periodDays = parseBiPeriod(req.nextUrl.searchParams.get("period"));

  try {
    const snapshot = await collectBiSnapshot({
      orgId: user.orgId,
      orgName: user.orgName,
      role: user.role,
      periodDays,
      branchCodes: user.role === "ADMIN" ? [] : user.branchCodes,
    });
    return NextResponse.json(snapshot);
  } catch (err) {
    console.error("GET /api/intelligence/summary failed:", err);
    return NextResponse.json(
      { error: "Unable to compute Business Intelligence snapshot." },
      { status: 500 },
    );
  }
}
