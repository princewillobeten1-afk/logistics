import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { currentUser, may } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import type { AutonomyMode } from "@/lib/integrations/catalog";
import { verifySameOriginRequest } from "@/lib/integrations/security";
import { deleteOrgConnector, updateOrgConnector } from "@/lib/integrations/store";

export const dynamic = "force-dynamic";

const VALID_AUTONOMY = new Set<AutonomyMode>([
  "FULL_AUTONOMOUS",
  "ASSISTED_APPROVAL",
  "SYNC_ONLY",
]);

export async function PATCH(
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
  if (!may(user.role, "ADMINISTER") && !may(user.role, "EDIT_SHIPMENT")) {
    return NextResponse.json(
      { error: "Your role is not permitted to modify integrations." },
      { status: 403 },
    );
  }

  const { id } = await context.params;
  let body: {
    name?: string;
    status?: "ACTIVE" | "PAUSED";
    autonomyMode?: AutonomyMode;
    outboundWebhookUrl?: string | null;
    outboundEvents?: string[];
    fieldMapping?: Record<string, string>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const cleanFieldMapping =
    body.fieldMapping && typeof body.fieldMapping === "object"
      ? Object.fromEntries(
          Object.entries(body.fieldMapping)
            .filter(
              ([k, v]) =>
                typeof k === "string" &&
                typeof v === "string" &&
                k.trim().length > 0 &&
                v.trim().length > 0,
            )
            .map(([k, v]) => [k.trim().slice(0, 64), v.trim().slice(0, 160)]),
        )
      : undefined;

  try {
    const updated = await updateOrgConnector(id, user.orgId, {
      name: typeof body.name === "string" ? body.name.trim() : undefined,
      status:
        body.status === "ACTIVE" || body.status === "PAUSED"
          ? body.status
          : undefined,
      autonomyMode:
        body.autonomyMode && VALID_AUTONOMY.has(body.autonomyMode)
          ? body.autonomyMode
          : undefined,
      outboundWebhookUrl:
        body.outboundWebhookUrl !== undefined
          ? typeof body.outboundWebhookUrl === "string"
            ? body.outboundWebhookUrl.trim() || null
            : null
          : undefined,
      outboundEvents: Array.isArray(body.outboundEvents)
        ? body.outboundEvents.filter((x): x is string => typeof x === "string").slice(0, 12)
        : undefined,
      fieldMapping: cleanFieldMapping,
    });

    if (!updated) {
      return NextResponse.json({ error: "Connector not found." }, { status: 404 });
    }

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      orgId: user.orgId,
      action: "INTEGRATION_CONNECTOR_UPDATED",
      entityType: updated.name,
      after: {
        connectorId: updated.id,
        status: updated.status,
        autonomyMode: updated.autonomyMode,
      },
    });

    revalidatePath("/integrations");
    revalidatePath("/settings");
    return NextResponse.json({ ok: true, connector: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not update connector." },
      { status: 400 },
    );
  }
}

export async function DELETE(
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
  if (!may(user.role, "ADMINISTER")) {
    return NextResponse.json(
      { error: "Administrator permission is required to revoke integrations." },
      { status: 403 },
    );
  }

  const { id } = await context.params;
  const deleted = await deleteOrgConnector(id, user.orgId);
  if (!deleted) {
    return NextResponse.json({ error: "Connector not found." }, { status: 404 });
  }

  await recordAudit({
    actor: user.email,
    actorType: "USER",
    orgId: user.orgId,
    action: "INTEGRATION_CONNECTOR_REVOKED",
    entityType: id,
  });

  revalidatePath("/integrations");
  revalidatePath("/settings");
  return NextResponse.json({ ok: true });
}
