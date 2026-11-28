import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { currentUser, may } from "@/lib/auth";
import { queryAs, runWithOrgScope } from "@/lib/db";
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  saveTenantDocumentBlob,
} from "@/lib/documents/storage";
import { isSameOriginMutation } from "@/lib/intelligence/access";
import { listDocuments } from "@/lib/queries";
import {
  detectWorkspaceTampering,
  hasDepartmentAccess,
} from "@/lib/tenant-guard";

export const dynamic = "force-dynamic";

const ALLOWED_KINDS = new Set([
  "BOL",
  "AWB",
  "SEA_WAYBILL",
  "PACKING_LIST",
  "COMMERCIAL_INVOICE",
  "CUSTOMS_DECLARATION",
  "POD",
  "OTHER",
]);

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const documents = await runWithOrgScope(user.orgId, () => listDocuments());
  return NextResponse.json({ ok: true, documents });
}

export async function POST(req: NextRequest) {
  if (!isSameOriginMutation(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const canUpload =
    may(user.role, "EDIT_SHIPMENT") &&
    (hasDepartmentAccess(user, "CUSTOMS") ||
      hasDepartmentAccess(user, "SHIPMENTS") ||
      hasDepartmentAccess(user, "ORDERS") ||
      hasDepartmentAccess(user, "WAREHOUSE"));
  if (!canUpload) {
    return NextResponse.json(
      { error: "Your role or department does not permit uploading workspace documents." },
      { status: 403 },
    );
  }

  let shipmentRef = "";
  let shipmentIdInput = "";
  let kind = "OTHER";
  let direction = "INBOUND";
  let filename = "document.pdf";
  let contentType = "application/pdf";
  let bytes: Buffer | null = null;
  let bodyForTamperCheck: Record<string, unknown> | undefined;

  const reqType = (req.headers.get("content-type") || "").toLowerCase();
  if (reqType.includes("multipart/form-data")) {
    const form = await req.formData();
    const formRecord: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") formRecord[k] = v;
    }
    bodyForTamperCheck = formRecord;

    shipmentRef = String(form.get("shipmentRef") ?? "").trim();
    shipmentIdInput = String(form.get("shipmentId") ?? "").trim();
    kind = String(form.get("kind") ?? "OTHER").trim().toUpperCase();
    direction = String(form.get("direction") ?? "INBOUND").trim().toUpperCase();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Select a file to upload." }, { status: 400 });
    }
    filename = file.name || "document.pdf";
    contentType = file.type || "application/octet-stream";
    if (file.size > MAX_DOCUMENT_BYTES) {
      return NextResponse.json(
        { error: "File exceeds the 10 MB size limit." },
        { status: 400 },
      );
    }
    bytes = Buffer.from(await file.arrayBuffer());
  } else {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
    }
    bodyForTamperCheck = body;
    shipmentRef = typeof body.shipmentRef === "string" ? body.shipmentRef.trim() : "";
    shipmentIdInput = typeof body.shipmentId === "string" ? body.shipmentId.trim() : "";
    kind = typeof body.kind === "string" ? body.kind.trim().toUpperCase() : "OTHER";
    direction =
      typeof body.direction === "string"
        ? body.direction.trim().toUpperCase()
        : "INBOUND";
    filename = typeof body.filename === "string" ? body.filename.trim() : "document.pdf";
    contentType =
      typeof body.contentType === "string"
        ? body.contentType.trim().toLowerCase()
        : "application/pdf";
    const base64 = typeof body.contentBase64 === "string" ? body.contentBase64.trim() : "";
    if (!base64) {
      return NextResponse.json({ error: "Document content is required." }, { status: 400 });
    }
    bytes = Buffer.from(base64, "base64");
  }

  const tamper = detectWorkspaceTampering(req, user.orgId, bodyForTamperCheck);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  if (!ALLOWED_KINDS.has(kind)) kind = "OTHER";
  if (direction !== "INBOUND" && direction !== "OUTBOUND") direction = "INBOUND";

  if (!ALLOWED_DOCUMENT_MIME_TYPES.has(contentType.split(";")[0].trim().toLowerCase())) {
    return NextResponse.json(
      { error: "Unsupported file format. Upload PDF, PNG, JPEG, CSV, TXT, or JSON." },
      { status: 400 },
    );
  }

  // Verify the referenced shipment belongs strictly to the caller's workspace
  let resolvedShipmentId = "";
  let resolvedShipmentRef: string | null = null;
  if (shipmentIdInput || shipmentRef) {
    const ships = shipmentIdInput
      ? await queryAs<{ id: string; reference: string }>(
          user.orgId,
          `SELECT id, reference FROM shipments WHERE id = $1 LIMIT 1`,
          [shipmentIdInput],
        )
      : await queryAs<{ id: string; reference: string }>(
          user.orgId,
          `SELECT id, reference FROM shipments WHERE upper(reference) = upper($1) LIMIT 1`,
          [shipmentRef],
        );
    if (ships.length === 0) {
      return NextResponse.json(
        { error: "Shipment not found in your workspace." },
        { status: 404 },
      );
    }
    resolvedShipmentId = ships[0].id;
    resolvedShipmentRef = ships[0].reference;
  }

  let saved;
  try {
    saved = saveTenantDocumentBlob({
      orgId: user.orgId,
      filename,
      contentType,
      bytes,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to store document." },
      { status: 400 },
    );
  }

  const inserted = await queryAs<{
    id: string;
    shipment_id: string;
    kind: string;
    direction: string;
    filename: string;
    storage_key: string | null;
    content_type: string | null;
    byte_size: number | null;
    sha256: string | null;
    uploaded_by: string | null;
    created_at: Date | string;
  }>(
    user.orgId,
    `INSERT INTO documents
       (shipment_id, kind, direction, filename, storage_key, content_type, byte_size, sha256, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, shipment_id, kind, direction, filename, storage_key, content_type, byte_size, sha256, uploaded_by, created_at`,
    [
      resolvedShipmentId || null,
      kind,
      direction,
      saved.filename,
      saved.storageKey,
      saved.contentType,
      saved.byteSize,
      saved.sha256,
      user.email,
    ],
  );

  const doc = inserted[0];
  await recordAudit({
    actor: user.email,
    actorType: "USER",
    action: "DOCUMENT_UPLOADED",
    orgId: user.orgId,
    entityType: `document:${doc.id}`,
    after: {
      kind,
      filename: saved.filename,
      shipmentRef: resolvedShipmentRef,
      byteSize: saved.byteSize,
    },
    userAgent: req.headers.get("user-agent"),
  });

  revalidatePath("/documents");

  return NextResponse.json(
    {
      ok: true,
      document: {
        ...doc,
        reference: resolvedShipmentRef,
      },
    },
    { status: 201 },
  );
}
