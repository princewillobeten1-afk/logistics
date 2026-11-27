import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { currentUser, may } from "@/lib/auth";
import type { AutonomyMode } from "@/lib/integrations/catalog";
import { verifySameOriginRequest } from "@/lib/integrations/security";
import { runOrgAutonomousTakeoverSweep } from "@/lib/integrations/takeover";

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

export async function POST(req: NextRequest) {
  if (!verifySameOriginRequest(req.headers)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (!may(user.role, "EDIT_SHIPMENT") && !may(user.role, "ADMINISTER")) {
    return NextResponse.json(
      { error: "Your role is not permitted to run autonomous takeover." },
      { status: 403 },
    );
  }

  let autonomyMode: AutonomyMode = "FULL_AUTONOMOUS";
  try {
    const body = (await req.json()) as { autonomyMode?: AutonomyMode };
    if (body?.autonomyMode === "ASSISTED_APPROVAL") {
      autonomyMode = "ASSISTED_APPROVAL";
    }
  } catch {
    // Empty body defaults cleanly to FULL_AUTONOMOUS
  }

  const result = await runOrgAutonomousTakeoverSweep(
    user.orgId,
    user.email,
    autonomyMode,
  );

  for (const path of ALL_REVALIDATE_PATHS) {
    revalidatePath(path);
  }

  return NextResponse.json({
    ok: true,
    ...result,
  });
}
