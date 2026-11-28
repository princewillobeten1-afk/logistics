import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { currentUser, may } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { verifySameOriginRequest } from "@/lib/integrations/security";
import { rotateOrgConnectorKey } from "@/lib/integrations/store";
import { detectWorkspaceTampering } from "@/lib/tenant-guard";

export const dynamic = "force-dynamic";

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
  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }
  if (!may(user.role, "ADMINISTER") && !may(user.role, "EDIT_SHIPMENT")) {
    return NextResponse.json(
      { error: "Your role is not permitted to rotate integration credentials." },
      { status: 403 },
    );
  }

  const { id } = await context.params;
  const rotated = await rotateOrgConnectorKey(id, user.orgId);
  if (!rotated) {
    return NextResponse.json({ error: "Connector not found." }, { status: 404 });
  }

  await recordAudit({
    actor: user.email,
    actorType: "USER",
    orgId: user.orgId,
    action: "INTEGRATION_KEY_ROTATED",
    entityType: rotated.connector.name,
    after: {
      connectorId: rotated.connector.id,
      apiKeyPrefix: rotated.connector.apiKeyPrefix,
    },
  });

  revalidatePath("/integrations");
  return NextResponse.json({ ok: true, ...rotated });
}
