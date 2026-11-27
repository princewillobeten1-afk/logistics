import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { collectBiSnapshot, parseBiPeriod } from "@/lib/intelligence/collector";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const periodDays = parseBiPeriod(req.nextUrl.searchParams.get("period"));

  try {
    const snapshot = await collectBiSnapshot({
      orgId: user.orgId,
      orgName: user.orgName,
      role: user.role,
      periodDays,
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
