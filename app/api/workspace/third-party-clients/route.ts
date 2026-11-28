import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { currentUser, may } from "@/lib/auth";
import { runWithOrgScope } from "@/lib/db";
import { listInventory, listShipments } from "@/lib/queries";
import { verifySameOriginMutation } from "@/lib/request-origin";
import {
  detectWorkspaceTampering,
  hasDepartmentAccess,
} from "@/lib/tenant-guard";
import {
  computeClientFulfillmentReports,
  type ThirdPartyClientInput,
} from "@/lib/verticals/freight-and-3pl";
import {
  deactivateThirdPartyClient,
  listThirdPartyClients,
  upsertThirdPartyClient,
} from "@/lib/verticals/store";

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

  const [clients, inventory, shipments] = await runWithOrgScope(user.orgId, async () =>
    Promise.all([
      listThirdPartyClients(user.orgId),
      listInventory(),
      listShipments(),
    ]),
  );

  const reports = computeClientFulfillmentReports(clients, inventory, shipments);
  return NextResponse.json({
    ok: true,
    clients,
    reports,
  });
}

export async function POST(req: NextRequest) {
  if (!verifySameOriginMutation(req)) {
    return NextResponse.json({ error: "Cross-origin mutation blocked." }, { status: 403 });
  }

  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (!may(user.role, "EDIT_SHIPMENT") && !may(user.role, "ADMINISTER")) {
    return NextResponse.json(
      { error: "Your role is not permitted to manage 3PL client accounts." },
      { status: 403 },
    );
  }
  if (!hasDepartmentAccess(user, "WAREHOUSE") && !hasDepartmentAccess(user, "CUSTOMERS")) {
    return NextResponse.json(
      { error: "Your department scope does not permit 3PL client account changes." },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const tamper = detectWorkspaceTampering(req, user.orgId, body);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const payload: ThirdPartyClientInput = {
    clientCode: String(body.clientCode ?? ""),
    clientName: String(body.clientName ?? ""),
    contactEmail: body.contactEmail ? String(body.contactEmail) : null,
    slaHours: body.slaHours !== undefined ? Number(body.slaHours) : undefined,
    billingModel: body.billingModel as ThirdPartyClientInput["billingModel"],
    dedicatedWarehouses: Array.isArray(body.dedicatedWarehouses)
      ? body.dedicatedWarehouses.map(String)
      : typeof body.dedicatedWarehouses === "string"
        ? body.dedicatedWarehouses.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
    skuPrefixes: Array.isArray(body.skuPrefixes)
      ? body.skuPrefixes.map(String)
      : typeof body.skuPrefixes === "string"
        ? body.skuPrefixes.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
    monthlyStorageRateUsd:
      body.monthlyStorageRateUsd !== undefined ? Number(body.monthlyStorageRateUsd) : undefined,
    perOrderPickFeeUsd:
      body.perOrderPickFeeUsd !== undefined ? Number(body.perOrderPickFeeUsd) : undefined,
    active: body.active !== false,
    notes: body.notes ? String(body.notes) : null,
  };

  const saved = await upsertThirdPartyClient(user.orgId, payload);
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: 400 });
  }

  await runWithOrgScope(user.orgId, async () => {
    await recordAudit({
      orgId: user.orgId,
      actor: user.email,
      action: "3PL_CLIENT_SAVED",
      entityType: "third_party_client",
      entityId: saved.client.id,
      after: {
        clientCode: saved.client.clientCode,
        clientName: saved.client.clientName,
        billingModel: saved.client.billingModel,
      },
    });
  });

  const [clients, inventory, shipments] = await runWithOrgScope(user.orgId, async () =>
    Promise.all([
      listThirdPartyClients(user.orgId),
      listInventory(),
      listShipments(),
    ]),
  );

  revalidatePath("/warehouses");
  return NextResponse.json(
    {
      ok: true,
      client: saved.client,
      clients,
      reports: computeClientFulfillmentReports(clients, inventory, shipments),
    },
    { status: 201 },
  );
}

export async function DELETE(req: NextRequest) {
  if (!verifySameOriginMutation(req)) {
    return NextResponse.json({ error: "Cross-origin mutation blocked." }, { status: 403 });
  }

  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (!may(user.role, "EDIT_SHIPMENT") && !may(user.role, "ADMINISTER")) {
    return NextResponse.json(
      { error: "Your role is not permitted to deactivate 3PL client accounts." },
      { status: 403 },
    );
  }
  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const clientCode = req.nextUrl.searchParams.get("clientCode")?.trim();
  if (!clientCode) {
    return NextResponse.json({ error: "clientCode query parameter is required." }, { status: 400 });
  }

  const deactivated = await deactivateThirdPartyClient(user.orgId, clientCode);
  if (!deactivated) {
    return NextResponse.json({ error: "3PL client account not found." }, { status: 404 });
  }

  revalidatePath("/warehouses");
  return NextResponse.json({ ok: true, clientCode: clientCode.toUpperCase() });
}
