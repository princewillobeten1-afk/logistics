"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, RefreshCw, Shield, Webhook } from "lucide-react";
import type { WorkspaceSecurityProfile } from "@/lib/workspace-admin";

interface Props {
  initialSecurity: WorkspaceSecurityProfile;
  origin: string;
}

export function WorkspaceSecurityPanel({ initialSecurity, origin }: Props) {
  const [security, setSecurity] = useState<WorkspaceSecurityProfile>(initialSecurity);
  const [revealedIntakeKey, setRevealedIntakeKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [waPhoneId, setWaPhoneId] = useState(initialSecurity.whatsappPhoneNumberId ?? "");
  const [waVerifyToken, setWaVerifyToken] = useState("");
  const [waAppSecret, setWaAppSecret] = useState("");
  const [tgSecret, setTgSecret] = useState("");

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const base = origin.replace(/\/$/, "");
  const whatsappUrl = `${base}/api/webhooks/whatsapp?workspace=${security.webhookToken}`;
  const telegramUrl = `${base}/api/webhooks/telegram?workspace=${security.webhookToken}`;
  const intakeUrl = `${base}/api/intake/external`;

  async function copyText(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(id);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Ignore clipboard permission errors
    }
  }

  async function postSecurity(action: string, extra: Record<string, unknown> = {}) {
    setBusyAction(action);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/security", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        security?: WorkspaceSecurityProfile;
        intakeApiKey?: string;
      };
      if (!res.ok || !data.ok) {
        setNotice({ tone: "err", text: data.error ?? "Security update failed." });
        return;
      }
      if (data.security) setSecurity(data.security);
      if (data.intakeApiKey) {
        setRevealedIntakeKey(data.intakeApiKey);
        setNotice({
          tone: "ok",
          text: "New workspace Intake API key generated. Copy it now — it will not be shown again.",
        });
      } else if (action === "rotate_webhook_token") {
        setNotice({
          tone: "ok",
          text: "Workspace webhook routing token rotated. Update your WhatsApp and Telegram webhook URLs.",
        });
      } else {
        setWaVerifyToken("");
        setWaAppSecret("");
        setTgSecret("");
        setNotice({ tone: "ok", text: "Workspace webhook signing secrets saved." });
      }
    } catch {
      setNotice({ tone: "err", text: "Network error saving workspace security settings." });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSaveSecrets(e: React.FormEvent) {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      whatsappPhoneNumberId: waPhoneId.trim() || null,
    };
    if (waVerifyToken.trim()) payload.whatsappVerifyToken = waVerifyToken.trim();
    if (waAppSecret.trim()) payload.whatsappAppSecret = waAppSecret.trim();
    if (tgSecret.trim()) payload.telegramWebhookSecret = tgSecret.trim();
    await postSecurity("update_channel_secrets", payload);
  }

  return (
    <div className="space-y-5">
      {notice && (
        <div
          className={`rounded-md border px-3.5 py-2.5 text-sm ${
            notice.tone === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
          }`}
        >
          {notice.text}
        </div>
      )}

      {/* Per-workspace Webhook Endpoints */}
      <div className="rounded-md border border-[var(--border)] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Webhook className="h-4 w-4 text-[var(--accent)]" />
            Dedicated Workspace Webhook URLs
          </div>
          <button
            type="button"
            disabled={busyAction === "rotate_webhook_token"}
            onClick={() => postSecurity("rotate_webhook_token")}
            className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Rotate Routing Token
          </button>
        </div>

        <div className="space-y-2.5 text-xs">
          {[
            { id: "wa", label: "WhatsApp Cloud API Webhook (requires X-Hub-Signature-256)", value: whatsappUrl },
            { id: "tg", label: "Telegram Bot Webhook (requires X-Telegram-Bot-Api-Secret-Token)", value: telegramUrl },
            { id: "intake", label: "External Intake API (requires Bearer Intake Key or Connector Key)", value: intakeUrl },
          ].map((item) => (
            <div
              key={item.id}
              className="flex flex-col gap-1 rounded border border-[var(--border)] p-2.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="font-medium text-[var(--fg-muted)]">{item.label}</div>
                <code className="block truncate font-mono text-xs text-[var(--fg)]">
                  {item.value}
                </code>
              </div>
              <button
                type="button"
                onClick={() => copyText(item.id, item.value)}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--surface)]"
              >
                {copiedKey === item.id ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copiedKey === item.id ? "Copied" : "Copy"}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Per-workspace Intake API Key */}
      <div className="rounded-md border border-[var(--border)] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound className="h-4 w-4 text-[var(--accent)]" />
              Workspace External Intake API Key
            </div>
            <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
              {security.hasIntakeApiKey
                ? `Active key prefix: ${security.intakeApiKeyPrefix}… (stored as SHA-256 hash)`
                : "No intake key configured yet. External API intake rejects unauthenticated requests."}
            </p>
          </div>
          <button
            type="button"
            disabled={busyAction === "rotate_intake_key"}
            onClick={() => postSecurity("rotate_intake_key")}
            className="inline-flex items-center gap-1.5 rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            <KeyRound className="h-3.5 w-3.5" />
            {security.hasIntakeApiKey ? "Rotate Intake Key" : "Generate Intake Key"}
          </button>
        </div>

        {revealedIntakeKey && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold">
              <span>Copy this API key now — it cannot be retrieved again</span>
              <button
                type="button"
                onClick={() => copyText("intake_key", revealedIntakeKey)}
                className="inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-xs"
              >
                {copiedKey === "intake_key" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copiedKey === "intake_key" ? "Copied" : "Copy key"}
              </button>
            </div>
            <code className="block break-all font-mono text-xs">{revealedIntakeKey}</code>
          </div>
        )}
      </div>

      {/* Cryptographic Webhook Signing Secrets */}
      <form
        onSubmit={handleSaveSecrets}
        className="rounded-md border border-[var(--border)] p-4 space-y-3"
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Shield className="h-4 w-4 text-[var(--accent)]" />
          Webhook Signature Verification Secrets
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="block space-y-1 text-xs">
            <span className="font-medium text-[var(--fg-muted)]">
              WhatsApp Phone Number ID
            </span>
            <input
              type="text"
              value={waPhoneId}
              onChange={(e) => setWaPhoneId(e.target.value)}
              placeholder="Meta Cloud API phone_number_id"
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm font-mono"
            />
          </label>

          <label className="block space-y-1 text-xs">
            <span className="font-medium text-[var(--fg-muted)]">
              WhatsApp Verify Token{" "}
              {security.hasWhatsappVerifyToken ? "(configured — enter to replace)" : "(required for Meta handshake)"}
            </span>
            <input
              type="password"
              value={waVerifyToken}
              onChange={(e) => setWaVerifyToken(e.target.value)}
              placeholder="Leave blank to keep existing"
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
            />
          </label>

          <label className="block space-y-1 text-xs">
            <span className="font-medium text-[var(--fg-muted)]">
              WhatsApp App Secret (HMAC-SHA256){" "}
              {security.hasWhatsappAppSecret ? "(configured — enter to replace)" : "(required to verify POST signatures)"}
            </span>
            <input
              type="password"
              value={waAppSecret}
              onChange={(e) => setWaAppSecret(e.target.value)}
              placeholder="Meta App Secret"
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
            />
          </label>

          <label className="block space-y-1 text-xs">
            <span className="font-medium text-[var(--fg-muted)]">
              Telegram Webhook Secret Token{" "}
              {security.hasTelegramWebhookSecret ? "(configured — enter to replace)" : "(required for setWebhook secret_token)"}
            </span>
            <input
              type="password"
              value={tgSecret}
              onChange={(e) => setTgSecret(e.target.value)}
              placeholder="X-Telegram-Bot-Api-Secret-Token"
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm"
            />
          </label>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busyAction === "update_channel_secrets"}
            className="rounded bg-[var(--accent)] px-3.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {busyAction === "update_channel_secrets" ? "Saving..." : "Save Verification Secrets"}
          </button>
        </div>
      </form>
    </div>
  );
}
