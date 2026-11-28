import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { queryAs } from "@/lib/db";
import {
  readTenantDocumentBlob,
  sanitizeFilename,
} from "@/lib/documents/storage";
import { detectWorkspaceTampering } from "@/lib/tenant-guard";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  const { id } = await context.params;
  if (!id || id.length > 80) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  const rows = await queryAs<{
    id: string;
    filename: string | null;
    storage_key: string | null;
    content_type: string | null;
  }>(
    user.orgId,
    `SELECT id, filename, storage_key, content_type
       FROM documents
      WHERE id = $1
      LIMIT 1`,
    [id],
  );

  // Return 404 for missing or cross-tenant document IDs without leaking existence
  const doc = rows[0];
  if (!doc || !doc.storage_key) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  let bytes: Buffer | null = null;
  try {
    bytes = readTenantDocumentBlob(user.orgId, doc.storage_key);
  } catch {
    return NextResponse.json({ error: "Document access denied." }, { status: 403 });
  }

  if (!bytes) {
    return NextResponse.json({ error: "Document binary not found." }, { status: 404 });
  }

  const safeName = sanitizeFilename(doc.filename || "document.pdf");
  const contentType = doc.content_type || "application/octet-stream";

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
