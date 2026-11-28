import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { currentUser, may } from "@/lib/auth";
import { runWithOrgScope } from "@/lib/db";
import { verifySameOriginMutation } from "@/lib/request-origin";
import {
  detectWorkspaceTampering,
  hasDepartmentAccess,
} from "@/lib/tenant-guard";
import {
  ALLOWED_CUSTOMS_STATUSES,
  summarizeInternationalFreight,
  type CustomsClearanceStatus,
  type InternationalFreightInput,
} from "@/lib/verticals/freight-and-3pl";
import {
  listInternationalFreightRecords,
  transitionCustomsClearanceStatus,
  upsertInternationalFreightRecord,
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

  const records = await listInternationalFreightRecords(user.orgId);
  return NextResponse.json({
    ok: true,
    records,
    summary: summarizeInternationalFreight(records),
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
      { error: "Your role is not permitted to file international customs records." },
      { status: 403 },
    );
  }
  if (
    !hasDepartmentAccess(user, "SHIPMENTS") &&
    !hasDepartmentAccess(user, "COMPLIANCE") &&
    !hasDepartmentAccess(user, "CUSTOMS") &&
    !hasDepartmentAccess(user, "FREIGHT")
  ) {
    return NextResponse.json(
      { error: "Your department scope does not permit customs filings." },
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

  const payload: InternationalFreightInput = {
    shipmentReference: String(body.shipmentReference ?? ""),
    direction: body.direction as InternationalFreightInput["direction"],
    transportMode: body.transportMode as InternationalFreightInput["transportMode"],
    incoterm: body.incoterm as InternationalFreightInput["incoterm"],
    containerOrWaybill: String(body.containerOrWaybill ?? ""),
    originCountry: String(body.originCountry ?? ""),
    destinationCountry: String(body.destinationCountry ?? ""),
    portOfLoading: body.portOfLoading ? String(body.portOfLoading) : null,
    portOfDischarge: body.portOfDischarge ? String(body.portOfDischarge) : null,
    hsCodes: Array.isArray(body.hsCodes)
      ? body.hsCodes.map(String)
      : String(body.hsCodes ?? ""),
    declaredValueUsd:
      body.declaredValueUsd !== undefined ? Number(body.declaredValueUsd) : undefined,
    estimatedDutyUsd:
      body.estimatedDutyUsd !== undefined && body.estimatedDutyUsd !== ""
        ? Number(body.estimatedDutyUsd)
        : undefined,
    customsBroker: body.customsBroker ? String(body.customsBroker) : null,
    clearanceStatus: body.clearanceStatus as InternationalFreightInput["clearanceStatus"],
    commercialInvoiceReady: Boolean(body.commercialInvoiceReady),
    packingListReady: Boolean(body.packingListReady),
    certificateOfOriginReady: Boolean(body.certificateOfOriginReady),
    milestoneNote: body.milestoneNote ? String(body.milestoneNote) : null,
  };

  const saved = await upsertInternationalFreightRecord(user.orgId, payload, user.email);
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: 400 });
  }

  await runWithOrgScope(user.orgId, async () => {
    await recordAudit({
      orgId: user.orgId,
      actor: user.email,
      action: "INTERNATIONAL_FREIGHT_SAVED",
      entityType: "international_freight",
      entityId: saved.record.id,
      after: {
        shipmentReference: saved.record.shipmentReference,
        transportMode: saved.record.transportMode,
        incoterm: saved.record.incoterm,
        clearanceStatus: saved.record.clearanceStatus,
        hsCodes: saved.record.hsCodes,
      },
    });
  });

  const records = await listInternationalFreightRecords(user.orgId);
  revalidatePath("/shipments");
  revalidatePath("/documents");

  return NextResponse.json(
    {
      ok: true,
      record: saved.record,
      records,
      summary: summarizeInternationalFreight(records),
    },
    { status: 201 },
  );
}

export async function PATCH(req: NextRequest) {
  if (!verifySameOriginMutation(req)) {
    return NextResponse.json({ error: "Cross-origin mutation blocked." }, { status: 403 });
  }

  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  if (!may(user.role, "EDIT_SHIPMENT") && !may(user.role, "ADMINISTER")) {
    return NextResponse.json(
      { error: "Your role is not permitted to update customs clearance status." },
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

  const shipmentReference = String(body.shipmentReference ?? "").trim();
  const nextStatus = String(body.clearanceStatus ?? "").trim().toUpperCase();
  if (
    !shipmentReference ||
    !ALLOWED_CUSTOMS_STATUSES.includes(nextStatus as CustomsClearanceStatus)
  ) {
    return NextResponse.json(
      { error: "Valid shipmentReference and clearanceStatus are required." },
      { status: 400 },
    );
  }

  const updated = await transitionCustomsClearanceStatus(
    user.orgId,
    shipmentReference,
    nextStatus as CustomsClearanceStatus,
    body.milestoneNote ? String(body.milestoneNote) : null,
    user.email,
  );
  if (!updated.ok) {
    return NextResponse.json({ error: updated.error }, { status: 400 });
  }

  const records = await listInternationalFreightRecords(user.orgId);
  revalidatePath("/shipments");
  revalidatePath("/documents");

  return NextResponse.json({
    ok: true,
    record: updated.record,
    records,
    summary: summarizeInternationalFreight(records),
  });
}
