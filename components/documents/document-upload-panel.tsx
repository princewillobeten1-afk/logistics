"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";

const KINDS = [
  "BOL",
  "AWB",
  "SEA_WAYBILL",
  "PACKING_LIST",
  "COMMERCIAL_INVOICE",
  "CUSTOMS_DECLARATION",
  "POD",
  "OTHER",
] as const;

export function DocumentUploadPanel({
  shipmentReferences,
}: {
  shipmentReferences: string[];
}) {
  const router = useRouter();
  const [shipmentRef, setShipmentRef] = useState(shipmentReferences[0] ?? "");
  const [kind, setKind] = useState<string>("BOL");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (!file) {
      setMessage({ tone: "err", text: "Choose a file (PDF, PNG, JPEG, CSV, TXT, or JSON)." });
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", kind);
      form.set("direction", "INBOUND");
      if (shipmentRef.trim()) {
        form.set("shipmentRef", shipmentRef.trim());
      }

      const res = await fetch("/api/documents", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setMessage({ tone: "err", text: data.error ?? "Upload failed." });
        return;
      }
      setFile(null);
      setMessage({
        tone: "ok",
        text: "Document uploaded into your workspace's private storage vault.",
      });
      router.refresh();
    } catch {
      setMessage({ tone: "err", text: "Network error uploading document." });
    } finally {
      setUploading(false);
    }
  }

  return (
    <form onSubmit={handleUpload} className="space-y-3">
      {message && (
        <div
          className={`rounded-md border px-3 py-2 text-xs ${
            message.tone === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <label className="block space-y-1 text-xs">
          <span className="font-medium text-[var(--fg-muted)]">Document type</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1 text-xs">
          <span className="font-medium text-[var(--fg-muted)]">Shipment reference (optional)</span>
          <input
            type="text"
            list="workspace-shipment-refs"
            value={shipmentRef}
            onChange={(e) => setShipmentRef(e.target.value)}
            placeholder="e.g. LG-10421"
            className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm font-mono"
          />
          <datalist id="workspace-shipment-refs">
            {shipmentReferences.map((ref) => (
              <option key={ref} value={ref} />
            ))}
          </datalist>
        </label>

        <label className="block space-y-1 text-xs">
          <span className="font-medium text-[var(--fg-muted)]">File (max 10 MB)</span>
          <input
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.csv,.txt,.json"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs"
          />
        </label>

        <div className="flex items-end">
          <button
            type="submit"
            disabled={uploading}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            {uploading ? "Uploading..." : "Upload to Vault"}
          </button>
        </div>
      </div>
    </form>
  );
}
