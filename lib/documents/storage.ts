import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertVerifiedOrgId } from "@/lib/tenant-guard";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/csv",
  "text/plain",
  "application/json",
]);

function getStorageRoot(): string {
  return path.resolve(
    process.env.DOCUMENT_STORAGE_DIR?.trim() ||
      path.join(os.tmpdir(), "control-tower-documents"),
  );
}

function sanitizeOrgSegment(orgId: string): string {
  const verified = assertVerifiedOrgId(orgId, "documentStorage");
  const clean = verified.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!clean || clean !== verified) {
    throw new Error("Invalid workspace identifier for document storage.");
  }
  return clean;
}

export function sanitizeFilename(raw: string): string {
  const base = path.basename(raw || "document.pdf").replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim();
  const safe = base.replace(/^\.+/, "").slice(0, 140);
  return safe || "document.pdf";
}

/**
 * Resolves a tenant-scoped document path and guarantees the resulting path
 * stays strictly confined within `<STORAGE_ROOT>/<orgId>/`.
 */
export function resolveTenantDocumentPath(
  orgId: string,
  storageKey: string,
): string {
  const safeOrg = sanitizeOrgSegment(orgId);
  if (!storageKey || storageKey.includes("\0") || storageKey.includes("..")) {
    throw new Error("Invalid document storage key.");
  }

  // Storage keys must always be prefixed with `<orgId>/` and contain no traversal
  const normalizedKey = storageKey.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedKey.startsWith(`${safeOrg}/`)) {
    throw new Error("Cross-tenant document storage key rejected.");
  }

  const root = getStorageRoot();
  const tenantDir = path.resolve(root, safeOrg);
  const fullPath = path.resolve(root, normalizedKey);

  if (
    fullPath !== tenantDir &&
    !fullPath.startsWith(tenantDir + path.sep)
  ) {
    throw new Error("Path traversal attempt blocked.");
  }
  if (fullPath === tenantDir) {
    throw new Error("Storage key must reference a file inside the tenant directory.");
  }

  return fullPath;
}

export function saveTenantDocumentBlob(input: {
  orgId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}): {
  storageKey: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
} {
  const safeOrg = sanitizeOrgSegment(input.orgId);
  const cleanType = (input.contentType || "application/octet-stream")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (!ALLOWED_DOCUMENT_MIME_TYPES.has(cleanType)) {
    throw new Error(
      `Unsupported document type "${cleanType}". Allowed: PDF, PNG, JPEG, CSV, TXT, JSON.`,
    );
  }
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) {
    throw new Error("Document file cannot be empty.");
  }
  if (input.bytes.length > MAX_DOCUMENT_BYTES) {
    throw new Error("Document exceeds the 10 MB maximum file size.");
  }

  const safeName = sanitizeFilename(input.filename);
  const ext = path.extname(safeName).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
  const objectId = `${randomUUID()}${ext}`;
  const storageKey = `${safeOrg}/${objectId}`;
  const fullPath = resolveTenantDocumentPath(safeOrg, storageKey);

  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, input.bytes);

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");

  return {
    storageKey,
    filename: safeName,
    contentType: cleanType,
    byteSize: input.bytes.length,
    sha256,
  };
}

export function readTenantDocumentBlob(
  orgId: string,
  storageKey: string,
): Buffer | null {
  const fullPath = resolveTenantDocumentPath(orgId, storageKey);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath);
}
