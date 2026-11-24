"use client";

import Link from "next/link";
import { Fragment, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Code2,
  Copy,
  KeyRound,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Send,
  Sliders,
  Sparkles,
  Trash2,
  Upload,
  Webhook,
  X,
} from "lucide-react";
import {
  AUTONOMY_MODE_META,
  type AutonomyMode,
  type SystemConnectorTemplate,
} from "@/lib/integrations/catalog";
import type {
  PublicConnector,
  PublicIntegrationEvent,
} from "@/lib/integrations/store";
import type { NormalizedLogisticsEvent } from "@/lib/integrations/mapper";

type TabId = "connectors" | "playground" | "logs" | "reference";

interface IssuedCredential {
  connectorName: string;
  apiKey: string;
  webhookSecret: string;
}

interface PreviewResponse {
  format: string;
  totalRecordsDetected: number;
  previewedCount: number;
  records: NormalizedLogisticsEvent[];
  suggestedFieldMapping: Record<string, string>;
}

interface LiveIngestResponse {
  ok: boolean;
  connectorName: string;
  format: string;
  totalReceived: number;
  processed: number;
  duplicates: number;
  failed: number;
  outcomes: {
    index: number;
    status: string;
    entityType: string;
    mappedBy: string;
    externalRef: string | null;
    orderReference: string | null;
    shipmentReference: string | null;
    delegatedAgents: string[];
    summary: string;
    orchestrationSummary: string | null;
    outboundWebhookStatus: string | null;
    error: string | null;
  }[];
  events: PublicIntegrationEvent[];
}

function formatShortTime(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function categoryLabel(cat: string): string {
  const map: Record<string, string> = {
    ERP: "ERP",
    TMS: "TMS",
    WMS: "WMS",
    ECOMMERCE: "E-Commerce",
    TELEMATICS: "Fleet GPS",
    EDI: "EDI X12",
    BATCH: "CSV Batch",
    CUSTOM: "Custom API",
  };
  return map[cat] ?? cat;
}

export function IntegrationsHub({
  initialConnectors,
  initialEvents,
  templates,
  origin,
  userRole,
}: {
  initialConnectors: PublicConnector[];
  initialEvents: PublicIntegrationEvent[];
  templates: SystemConnectorTemplate[];
  origin: string;
  userRole: string;
}) {
  const canManage = userRole === "ADMIN" || userRole === "DISPATCHER";
  const canDelete = userRole === "ADMIN";

  const [tab, setTab] = useState<TabId>("connectors");
  const [connectors, setConnectors] = useState<PublicConnector[]>(initialConnectors);
  const [events, setEvents] = useState<PublicIntegrationEvent[]>(initialEvents);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);
  const [issuedCred, setIssuedCred] = useState<IssuedCredential | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Create connector state
  const [showCreator, setShowCreator] = useState(initialConnectors.length === 0);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    templates[0]?.id ?? "custom_rest_webhook",
  );
  const [newName, setNewName] = useState<string>(templates[0]?.name ?? "");
  const [newAutonomy, setNewAutonomy] = useState<AutonomyMode>("FULL_AUTONOMOUS");
  const [newOutboundUrl, setNewOutboundUrl] = useState<string>("");
  const [creating, setCreating] = useState(false);

  // Edit connector modal/panel
  const [editingConnector, setEditingConnector] = useState<PublicConnector | null>(null);
  const [editName, setEditName] = useState("");
  const [editAutonomy, setEditAutonomy] = useState<AutonomyMode>("FULL_AUTONOMOUS");
  const [editOutboundUrl, setEditOutboundUrl] = useState("");
  const [editMappingText, setEditMappingText] = useState("{}");
  const [savingEdit, setSavingEdit] = useState(false);

  // Playground / AI Schema Mapper state
  const [activeConnectorId, setActiveConnectorId] = useState<string>(
    initialConnectors[0]?.id ?? "",
  );
  const [presetId, setPresetId] = useState<string>(templates[0]?.id ?? "sap_s4hana_tm");
  const [payloadText, setPayloadText] = useState<string>(
    templates[0]?.samplePayload ?? "",
  );
  const [forceAiMap, setForceAiMap] = useState<boolean>(false);
  const [previewing, setPreviewing] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [previewResult, setPreviewResult] = useState<PreviewResponse | null>(null);
  const [ingestResult, setIngestResult] = useState<LiveIngestResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Logs filter & inspection
  const [logSearch, setLogSearch] = useState("");
  const [logFilterStatus, setLogFilterStatus] = useState<string>("ALL");
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [busyConnectorId, setBusyConnectorId] = useState<string | null>(null);
  const [snippetLang, setSnippetLang] = useState<"curl" | "node" | "python">("curl");

  const kpis = useMemo(() => {
    const activeCount = connectors.filter((c) => c.status === "ACTIVE").length;
    const totalProcessed = connectors.reduce((acc, c) => acc + c.eventsProcessed, 0);
    const totalErrors = connectors.reduce((acc, c) => acc + c.errorsCount, 0);
    const autonomousCount = connectors.filter(
      (c) => c.status === "ACTIVE" && c.autonomyMode === "FULL_AUTONOMOUS",
    ).length;
    const totalAttempts = totalProcessed + totalErrors;
    const successRate =
      totalAttempts > 0 ? Math.round((totalProcessed / totalAttempts) * 100) : 100;
    return {
      activeCount,
      totalConnectors: connectors.length,
      totalProcessed,
      autonomousCount,
      successRate,
    };
  }, [connectors]);

  const filteredEvents = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return events.filter((ev) => {
      if (logFilterStatus !== "ALL" && ev.status !== logFilterStatus) return false;
      if (!q) return true;
      return (
        ev.connectorName.toLowerCase().includes(q) ||
        ev.entityType.toLowerCase().includes(q) ||
        (ev.externalRef ?? "").toLowerCase().includes(q) ||
        (ev.shipmentRef ?? "").toLowerCase().includes(q) ||
        (ev.orderRef ?? "").toLowerCase().includes(q) ||
        ev.summary.toLowerCase().includes(q)
      );
    });
  }, [events, logSearch, logFilterStatus]);

  function copyText(id: string, value: string) {
    navigator.clipboard?.writeText(value).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1800);
  }

  function selectTemplate(tpl: SystemConnectorTemplate) {
    setSelectedTemplateId(tpl.id);
    setNewName(tpl.name);
    setNewAutonomy(tpl.defaultAutonomy);
  }

  async function refreshAll() {
    const res = await fetch("/api/integrations", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      setConnectors(data.connectors ?? []);
      setEvents(data.events ?? []);
      if (!activeConnectorId && data.connectors?.[0]?.id) {
        setActiveConnectorId(data.connectors[0].id);
      }
    }
  }

  async function handleCreateConnector(e: React.FormEvent) {
    e.preventDefault();
    setBannerError(null);
    setBannerSuccess(null);
    setCreating(true);
    try {
      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          systemType: selectedTemplateId,
          autonomyMode: newAutonomy,
          outboundWebhookUrl: newOutboundUrl.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBannerError(data.error ?? "Failed to create connector.");
        return;
      }
      setConnectors((prev) => [data.connector, ...prev]);
      setActiveConnectorId(data.connector.id);
      setIssuedCred({
        connectorName: data.connector.name,
        apiKey: data.apiKey,
        webhookSecret: data.webhookSecret,
      });
      setNewOutboundUrl("");
      setShowCreator(false);
      setBannerSuccess(
        `Connected "${data.connector.name}". Copy the API key below — it is shown only once.`,
      );
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Network error");
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleStatus(conn: PublicConnector) {
    setBannerError(null);
    setBusyConnectorId(conn.id);
    const nextStatus = conn.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    try {
      const res = await fetch(`/api/integrations/${conn.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBannerError(data.error ?? "Could not update connector status.");
        return;
      }
      setConnectors((prev) =>
        prev.map((c) => (c.id === conn.id ? data.connector : c)),
      );
    } finally {
      setBusyConnectorId(null);
    }
  }

  async function handleRotateKey(conn: PublicConnector) {
    setBannerError(null);
    setBannerSuccess(null);
    setBusyConnectorId(conn.id);
    try {
      const res = await fetch(`/api/integrations/${conn.id}/rotate-key`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setBannerError(data.error ?? "Could not rotate API key.");
        return;
      }
      setConnectors((prev) =>
        prev.map((c) => (c.id === conn.id ? data.connector : c)),
      );
      setIssuedCred({
        connectorName: conn.name,
        apiKey: data.apiKey,
        webhookSecret: data.webhookSecret,
      });
      setBannerSuccess(`Rotated API key for "${conn.name}". Update your external system now.`);
    } finally {
      setBusyConnectorId(null);
    }
  }

  async function handleDelete(conn: PublicConnector) {
    setBannerError(null);
    setBusyConnectorId(conn.id);
    try {
      const res = await fetch(`/api/integrations/${conn.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        setBannerError(data.error ?? "Could not revoke connector.");
        return;
      }
      setConnectors((prev) => prev.filter((c) => c.id !== conn.id));
      if (activeConnectorId === conn.id) {
        setActiveConnectorId(
          connectors.find((c) => c.id !== conn.id)?.id ?? "",
        );
      }
      setBannerSuccess(`Revoked connector "${conn.name}".`);
    } finally {
      setBusyConnectorId(null);
    }
  }

  function openEdit(conn: PublicConnector) {
    setEditingConnector(conn);
    setEditName(conn.name);
    setEditAutonomy(conn.autonomyMode);
    setEditOutboundUrl(conn.outboundWebhookUrl ?? "");
    setEditMappingText(JSON.stringify(conn.fieldMapping ?? {}, null, 2));
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingConnector) return;
    setBannerError(null);
    let parsedMapping: Record<string, string> = {};
    try {
      const raw = JSON.parse(editMappingText || "{}");
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        setBannerError("Field mapping must be a flat JSON object of canonicalField: sourcePath.");
        return;
      }
      parsedMapping = raw as Record<string, string>;
    } catch {
      setBannerError("Field mapping contains invalid JSON.");
      return;
    }

    setSavingEdit(true);
    try {
      const res = await fetch(`/api/integrations/${editingConnector.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName,
          autonomyMode: editAutonomy,
          outboundWebhookUrl: editOutboundUrl.trim() || null,
          fieldMapping: parsedMapping,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBannerError(data.error ?? "Failed to save connector settings.");
        return;
      }
      setConnectors((prev) =>
        prev.map((c) => (c.id === editingConnector.id ? data.connector : c)),
      );
      setEditingConnector(null);
      setBannerSuccess(`Saved configuration for "${data.connector.name}".`);
    } finally {
      setSavingEdit(false);
    }
  }

  function openPlaygroundForConnector(conn: PublicConnector) {
    const tpl =
      templates.find((t) => t.id === conn.systemType) ??
      templates[templates.length - 1];
    setActiveConnectorId(conn.id);
    if (tpl) {
      setPresetId(tpl.id);
      setPayloadText(tpl.samplePayload);
    }
    setPreviewResult(null);
    setIngestResult(null);
    setTab("playground");
  }

  async function handlePreviewMapping() {
    setBannerError(null);
    setPreviewing(true);
    setPreviewResult(null);
    try {
      const res = await fetch("/api/integrations/preview-map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: payloadText,
          connectorId: activeConnectorId || undefined,
          forceAi: forceAiMap,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBannerError(data.error ?? "Could not normalize payload.");
        return;
      }
      setPreviewResult(data as PreviewResponse);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Network error");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleSaveSuggestedMapping() {
    if (!activeConnectorId || !previewResult?.suggestedFieldMapping) return;
    const conn = connectors.find((c) => c.id === activeConnectorId);
    if (!conn) return;
    setBannerError(null);
    const merged = {
      ...(conn.fieldMapping ?? {}),
      ...previewResult.suggestedFieldMapping,
    };
    const res = await fetch(`/api/integrations/${conn.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldMapping: merged }),
    });
    const data = await res.json();
    if (!res.ok) {
      setBannerError(data.error ?? "Could not save learned mapping.");
      return;
    }
    setConnectors((prev) =>
      prev.map((c) => (c.id === conn.id ? data.connector : c)),
    );
    setBannerSuccess(
      `Saved ${Object.keys(previewResult.suggestedFieldMapping).length} learned field mappings to "${conn.name}".`,
    );
  }

  async function handleRunLiveIngest() {
    setBannerError(null);
    setBannerSuccess(null);
    if (!activeConnectorId) {
      setBannerError("Create or select a connected system first before ingesting.");
      return;
    }
    setIngesting(true);
    setIngestResult(null);
    try {
      const res = await fetch(`/api/integrations/${activeConnectorId}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload: payloadText,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBannerError(data.error ?? "Ingestion failed.");
        return;
      }
      const typed = data as LiveIngestResponse;
      setIngestResult(typed);
      if (Array.isArray(typed.events) && typed.events.length > 0) {
        setEvents((prev) => [...typed.events, ...prev].slice(0, 80));
      }
      await refreshAll();
      setBannerSuccess(
        `Ingested ${typed.processed} of ${typed.totalReceived} record(s) via ${typed.connectorName}. Autonomous agents executed.`,
      );
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Network error");
    } finally {
      setIngesting(false);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 512 * 1024) {
      setBannerError("File exceeds 512 KB upload limit.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      setPayloadText(text);
      setPreviewResult(null);
      setIngestResult(null);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  const sampleKeyPlaceholder = issuedCred?.apiKey ?? "ct_live_YOUR_CONNECTOR_API_KEY";
  const ingestEndpoint = `${origin}/api/v1/ingest`;
  const shipmentsEndpoint = `${origin}/api/v1/shipments`;

  const codeSnippets = {
    curl: `curl -X POST "${ingestEndpoint}" \\
  -H "Authorization: Bearer ${sampleKeyPlaceholder}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-88412" \\
  -d '${JSON.stringify({
    external_ref: "ERP-PO-88412",
    customer_name: "Nordic Industrial GmbH",
    origin_city: "Hamburg",
    destination_city: "Rotterdam",
    cargo_description: "CNC Hydraulic Actuators",
    weight_kg: 4250,
    quantity: 18,
    mode: "ROAD",
  })}'`,
    node: `const res = await fetch("${ingestEndpoint}", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${sampleKeyPlaceholder}",
    "Content-Type": "application/json",
    "Idempotency-Key": "order-88412",
  },
  body: JSON.stringify({
    external_ref: "ERP-PO-88412",
    customer_name: "Nordic Industrial GmbH",
    origin_city: "Hamburg",
    destination_city: "Rotterdam",
    cargo_description: "CNC Hydraulic Actuators",
    weight_kg: 4250,
    quantity: 18,
    mode: "ROAD",
  }),
});
const { results } = await res.json();
console.log("Autonomous shipment:", results[0].shipmentReference);`,
    python: `import requests

resp = requests.post(
    "${ingestEndpoint}",
    headers={
        "Authorization": "Bearer ${sampleKeyPlaceholder}",
        "Idempotency-Key": "order-88412",
    },
    json={
        "external_ref": "ERP-PO-88412",
        "customer_name": "Nordic Industrial GmbH",
        "origin_city": "Hamburg",
        "destination_city": "Rotterdam",
        "cargo_description": "CNC Hydraulic Actuators",
        "weight_kg": 4250,
        "quantity": 18,
        "mode": "ROAD",
    },
    timeout=30,
)
print(resp.json())`,
  };

  return (
    <div className="int-root">
      {/* KPI Strip */}
      <div className="int-kpi-grid">
        <div className="int-kpi">
          <span className="int-kpi-label">Connected systems</span>
          <strong className="int-kpi-value num">
            {kpis.activeCount}
            <span className="int-kpi-sub"> / {kpis.totalConnectors}</span>
          </strong>
        </div>
        <div className="int-kpi">
          <span className="int-kpi-label">Full autonomous pipelines</span>
          <strong className="int-kpi-value num">{kpis.autonomousCount}</strong>
        </div>
        <div className="int-kpi">
          <span className="int-kpi-label">External records handled</span>
          <strong className="int-kpi-value num">{kpis.totalProcessed}</strong>
        </div>
        <div className="int-kpi">
          <span className="int-kpi-label">Ingestion reliability</span>
          <strong className="int-kpi-value num">{kpis.successRate}%</strong>
        </div>
      </div>

      {/* Feedback banners */}
      {bannerError ? (
        <div className="int-alert" data-tone="crit" role="alert">
          <span>{bannerError}</span>
          <button
            type="button"
            className="int-icon-btn"
            aria-label="Dismiss error"
            onClick={() => setBannerError(null)}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

      {bannerSuccess ? (
        <div className="int-alert" data-tone="ok" role="status">
          <span>{bannerSuccess}</span>
          <button
            type="button"
            className="int-icon-btn"
            aria-label="Dismiss notice"
            onClick={() => setBannerSuccess(null)}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

      {/* One-time credential vault banner */}
      {issuedCred ? (
        <section className="int-cred-panel" aria-label="Issued connector credentials">
          <div className="int-cred-head">
            <div>
              <strong>Credentials issued for {issuedCred.connectorName}</strong>
              <p>
                Store these in your company system now. Only cryptographic hashes are
                saved on our server — these secrets cannot be viewed again.
              </p>
            </div>
            <button
              type="button"
              className="int-btn-secondary"
              onClick={() => setIssuedCred(null)}
            >
              Done
            </button>
          </div>
          <div className="int-cred-rows">
            <div className="int-cred-row">
              <span>Ingest API Key (Bearer / X-API-Key)</span>
              <div className="int-cred-code">
                <code>{issuedCred.apiKey}</code>
                <button
                  type="button"
                  className="int-btn-ghost"
                  onClick={() => copyText("apiKey", issuedCred.apiKey)}
                >
                  {copiedId === "apiKey" ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copiedId === "apiKey" ? "Copied" : "Copy"}</span>
                </button>
              </div>
            </div>
            <div className="int-cred-row">
              <span>Outbound Webhook Signing Secret (HMAC-SHA256)</span>
              <div className="int-cred-code">
                <code>{issuedCred.webhookSecret}</code>
                <button
                  type="button"
                  className="int-btn-ghost"
                  onClick={() => copyText("whSecret", issuedCred.webhookSecret)}
                >
                  {copiedId === "whSecret" ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copiedId === "whSecret" ? "Copied" : "Copy"}</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* Primary Workspace Toolbar & Segmented Tabs */}
      <div className="int-toolbar">
        <div className="int-tabs" role="tablist" aria-label="Integration views">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "connectors"}
            className="int-tab"
            data-active={tab === "connectors"}
            onClick={() => setTab("connectors")}
          >
            Connected systems ({connectors.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "playground"}
            className="int-tab"
            data-active={tab === "playground"}
            onClick={() => setTab("playground")}
          >
            Universal AI mapper &amp; ingest
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "logs"}
            className="int-tab"
            data-active={tab === "logs"}
            onClick={() => setTab("logs")}
          >
            Sync log ({events.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "reference"}
            className="int-tab"
            data-active={tab === "reference"}
            onClick={() => setTab("reference")}
          >
            API &amp; webhooks
          </button>
        </div>

        {canManage ? (
          <button
            type="button"
            className="int-btn-primary"
            onClick={() => {
              setTab("connectors");
              setShowCreator((v) => !v);
            }}
          >
            <Plus size={15} />
            <span>{showCreator ? "Close setup" : "Connect a system"}</span>
          </button>
        ) : null}
      </div>

      {/* TAB 1: CONNECTED SYSTEMS */}
      {tab === "connectors" ? (
        <div className="int-stack">
          {showCreator && canManage ? (
            <section className="panel int-creator">
              <div className="panel-head">
                <h2>Connect your logistics system</h2>
                <span className="panel-hint">
                  Zero schema lock-in · JSON, CSV, or EDI X12
                </span>
              </div>
              <div className="panel-body">
                <div className="int-template-grid">
                  {templates.map((tpl) => {
                    const active = tpl.id === selectedTemplateId;
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        className="int-template-btn"
                        data-selected={active}
                        onClick={() => selectTemplate(tpl)}
                      >
                        <div className="int-template-top">
                          <strong>{tpl.name}</strong>
                          <span className="int-meta-text">
                            {categoryLabel(tpl.category)}
                          </span>
                        </div>
                        <p>{tpl.summary}</p>
                        <span className="int-meta-text">
                          {tpl.formats.join(" · ")}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <form className="int-form" onSubmit={handleCreateConnector}>
                  <div className="int-form-grid">
                    <label className="int-field">
                      <span>Connection name</span>
                      <input
                        type="text"
                        required
                        minLength={2}
                        maxLength={100}
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder="e.g. Lagos SAP S/4HANA Production"
                      />
                    </label>

                    <label className="int-field">
                      <span>Agent autonomy policy</span>
                      <select
                        value={newAutonomy}
                        onChange={(e) =>
                          setNewAutonomy(e.target.value as AutonomyMode)
                        }
                      >
                        <option value="FULL_AUTONOMOUS">
                          Full Autonomous — agent handles end-to-end
                        </option>
                        <option value="ASSISTED_APPROVAL">
                          Assisted Approval — hold spend for sign-off
                        </option>
                        <option value="SYNC_ONLY">
                          Sync Only — mirror data without dispatching
                        </option>
                      </select>
                      <em>{AUTONOMY_MODE_META[newAutonomy].description}</em>
                    </label>
                  </div>

                  <label className="int-field">
                    <span>
                      Outbound callback webhook URL{" "}
                      <span className="int-optional">(optional)</span>
                    </span>
                    <input
                      type="url"
                      value={newOutboundUrl}
                      onChange={(e) => setNewOutboundUrl(e.target.value)}
                      placeholder="https://erp.yourcompany.com/webhooks/control-tower"
                    />
                    <em>
                      Control Tower signs every autonomous status update with
                      HMAC-SHA256 and POSTs results back to your system automatically.
                    </em>
                  </label>

                  <div className="int-form-actions">
                    <button
                      type="submit"
                      className="int-btn-primary"
                      disabled={creating}
                    >
                      <Plug size={15} />
                      <span>
                        {creating
                          ? "Provisioning connector..."
                          : "Create connector & issue API key"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="int-btn-secondary"
                      onClick={() => setShowCreator(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </section>
          ) : null}

          {editingConnector ? (
            <section className="panel">
              <div className="panel-head">
                <h2>Configure {editingConnector.name}</h2>
                <button
                  type="button"
                  className="int-icon-btn"
                  aria-label="Close editor"
                  onClick={() => setEditingConnector(null)}
                >
                  <X size={15} />
                </button>
              </div>
              <div className="panel-body">
                <form className="int-form" onSubmit={handleSaveEdit}>
                  <div className="int-form-grid">
                    <label className="int-field">
                      <span>Connection name</span>
                      <input
                        type="text"
                        required
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                    </label>
                    <label className="int-field">
                      <span>Agent autonomy policy</span>
                      <select
                        value={editAutonomy}
                        onChange={(e) =>
                          setEditAutonomy(e.target.value as AutonomyMode)
                        }
                      >
                        <option value="FULL_AUTONOMOUS">Full Autonomous</option>
                        <option value="ASSISTED_APPROVAL">Assisted Approval</option>
                        <option value="SYNC_ONLY">Sync Only</option>
                      </select>
                    </label>
                  </div>

                  <label className="int-field">
                    <span>Outbound callback webhook URL</span>
                    <input
                      type="url"
                      value={editOutboundUrl}
                      onChange={(e) => setEditOutboundUrl(e.target.value)}
                      placeholder="https://erp.yourcompany.com/webhooks/control-tower"
                    />
                  </label>

                  <label className="int-field">
                    <span>Custom field mapping JSON (canonicalField → source.dot.path)</span>
                    <textarea
                      rows={6}
                      value={editMappingText}
                      onChange={(e) => setEditMappingText(e.target.value)}
                      className="int-code-input"
                    />
                    <em>
                      Leave empty to let the AI Schema Mapper auto-detect any incoming
                      payload schema.
                    </em>
                  </label>

                  <div className="int-form-actions">
                    <button
                      type="submit"
                      className="int-btn-primary"
                      disabled={savingEdit}
                    >
                      {savingEdit ? "Saving..." : "Save changes"}
                    </button>
                    <button
                      type="button"
                      className="int-btn-secondary"
                      onClick={() => setEditingConnector(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-head">
              <h2>Active &amp; paused connectors</h2>
              <span className="panel-hint">
                Authenticated via org-scoped Bearer / X-API-Key headers
              </span>
            </div>
            {connectors.length === 0 ? (
              <div className="panel-body">
                <div className="empty">
                  <p>No external systems connected yet.</p>
                  <p className="hint">
                    Connect SAP, NetSuite, CargoWise, Shopify, Samsara GPS, EDI X12,
                    CSV manifests, or any custom REST API above — once connected, the
                    autonomous agent handles everything automatically.
                  </p>
                </div>
              </div>
            ) : (
              <div className="scroller" tabIndex={0} role="region" aria-label="Connected systems">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">System</th>
                      <th scope="col">Autonomy</th>
                      <th scope="col">Status</th>
                      <th scope="col">Key prefix</th>
                      <th scope="col">Records</th>
                      <th scope="col">Last sync</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {connectors.map((c) => {
                      const busy = busyConnectorId === c.id;
                      return (
                        <tr key={c.id}>
                          <td>
                            <div className="int-cell-primary">{c.name}</div>
                            <div className="int-meta-text">
                              {categoryLabel(c.category)}
                              {" · "}
                              {Object.keys(c.fieldMapping ?? {}).length} mapped fields
                              {c.outboundWebhookUrl ? " · Outbound webhook on" : ""}
                            </div>
                          </td>
                          <td>
                            <span className="int-text-strong">
                              {AUTONOMY_MODE_META[c.autonomyMode]?.label ?? c.autonomyMode}
                            </span>
                          </td>
                          <td>
                            <span
                              className="int-status-text"
                              data-tone={c.status === "ACTIVE" ? "ok" : "warn"}
                            >
                              {c.status === "ACTIVE" ? "Active" : "Paused"}
                            </span>
                          </td>
                          <td className="ref">{c.apiKeyPrefix}…</td>
                          <td className="num">
                            {c.eventsProcessed}
                            {c.errorsCount > 0 ? (
                              <span className="text-crit"> ({c.errorsCount} err)</span>
                            ) : null}
                          </td>
                          <td className="num text-muted">
                            {formatShortTime(c.lastSyncAt)}
                          </td>
                          <td>
                            <div className="int-row-actions">
                              <button
                                type="button"
                                className="int-btn-ghost"
                                onClick={() => openPlaygroundForConnector(c)}
                                title="Test or send payload through this connector"
                              >
                                <Send size={13} />
                                <span>Test ingest</span>
                              </button>
                              {canManage ? (
                                <>
                                  <button
                                    type="button"
                                    className="int-btn-ghost"
                                    onClick={() => openEdit(c)}
                                    disabled={busy}
                                    title="Edit mapping and webhook settings"
                                  >
                                    <Sliders size={13} />
                                    <span>Configure</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="int-btn-ghost"
                                    onClick={() => handleToggleStatus(c)}
                                    disabled={busy}
                                  >
                                    {c.status === "ACTIVE" ? (
                                      <>
                                        <Pause size={13} />
                                        <span>Pause</span>
                                      </>
                                    ) : (
                                      <>
                                        <Play size={13} />
                                        <span>Resume</span>
                                      </>
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    className="int-btn-ghost"
                                    onClick={() => handleRotateKey(c)}
                                    disabled={busy}
                                    title="Rotate API key and webhook signing secret"
                                  >
                                    <KeyRound size={13} />
                                    <span>Rotate key</span>
                                  </button>
                                </>
                              ) : null}
                              {canDelete ? (
                                <button
                                  type="button"
                                  className="int-btn-ghost int-btn-danger-ghost"
                                  onClick={() => handleDelete(c)}
                                  disabled={busy}
                                  title="Revoke connector"
                                >
                                  <Trash2 size={13} />
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {/* TAB 2: UNIVERSAL AI MAPPER & LIVE INGEST PLAYGROUND */}
      {tab === "playground" ? (
        <div className="int-playground-grid">
          <section className="panel">
            <div className="panel-head">
              <h2>External payload input</h2>
              <span className="panel-hint">
                Paste JSON, CSV manifest, or EDI X12 (204 / 214 / 856)
              </span>
            </div>
            <div className="panel-body int-stack">
              <div className="int-form-grid">
                <label className="int-field">
                  <span>Target connected system</span>
                  <select
                    value={activeConnectorId}
                    onChange={(e) => setActiveConnectorId(e.target.value)}
                  >
                    {connectors.length === 0 ? (
                      <option value="">No connector created yet</option>
                    ) : (
                      connectors.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({AUTONOMY_MODE_META[c.autonomyMode]?.label})
                        </option>
                      ))
                    )}
                  </select>
                </label>

                <label className="int-field">
                  <span>Load sample system schema</span>
                  <select
                    value={presetId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setPresetId(nextId);
                      const tpl = templates.find((t) => t.id === nextId);
                      if (tpl) {
                        setPayloadText(tpl.samplePayload);
                        setPreviewResult(null);
                        setIngestResult(null);
                      }
                    }}
                  >
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.sampleFormat})
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="int-payload-tools">
                <label className="int-checkbox">
                  <input
                    type="checkbox"
                    checked={forceAiMap}
                    onChange={(e) => setForceAiMap(e.target.checked)}
                  />
                  <span>Force Gemini AI schema discovery &amp; mapping suggestions</span>
                </label>

                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,.csv,.txt,.edi,.x12"
                    onChange={handleFileUpload}
                    style={{ display: "none" }}
                  />
                  <button
                    type="button"
                    className="int-btn-secondary"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload size={14} />
                    <span>Upload CSV / JSON / EDI</span>
                  </button>
                </div>
              </div>

              <textarea
                rows={15}
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
                className="int-code-input"
                aria-label="External payload editor"
                placeholder="Paste any JSON object/array, CSV rows, or EDI X12 message..."
              />

              <div className="int-form-actions">
                <button
                  type="button"
                  className="int-btn-secondary"
                  disabled={previewing || !payloadText.trim()}
                  onClick={handlePreviewMapping}
                >
                  <Sparkles size={14} />
                  <span>
                    {previewing ? "Mapping schema..." : "Preview AI mapping"}
                  </span>
                </button>
                <button
                  type="button"
                  className="int-btn-primary"
                  disabled={ingesting || !payloadText.trim() || !activeConnectorId}
                  onClick={handleRunLiveIngest}
                >
                  <Send size={14} />
                  <span>
                    {ingesting
                      ? "Agent executing..."
                      : "Ingest & run autonomous agent"}
                  </span>
                </button>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Normalized output &amp; agent execution</h2>
              <span className="panel-hint">
                Live canonical translation &amp; specialist delegation
              </span>
            </div>
            <div className="panel-body int-stack">
              {!previewResult && !ingestResult ? (
                <div className="empty">
                  <p>Ready to normalize any logistics payload.</p>
                  <p className="hint">
                    Click <strong>Preview AI mapping</strong> to inspect how Control
                    Tower interprets your company&apos;s schema, or click{" "}
                    <strong>Ingest &amp; run autonomous agent</strong> to execute the
                    full workflow live.
                  </p>
                </div>
              ) : null}

              {ingestResult ? (
                <div className="int-result-block">
                  <div className="int-result-head">
                    <strong>
                      Executed {ingestResult.processed} of {ingestResult.totalReceived}{" "}
                      record(s)
                    </strong>
                    <span className="int-meta-text">
                      {ingestResult.connectorName} · {ingestResult.format}
                    </span>
                  </div>
                  <div className="int-outcome-list">
                    {ingestResult.outcomes.map((o) => (
                      <div key={o.index} className="int-outcome-item">
                        <div className="int-outcome-top">
                          <span className="int-text-strong">
                            {o.entityType}
                            {o.externalRef ? ` · ${o.externalRef}` : ""}
                          </span>
                          <span
                            className="int-status-text"
                            data-tone={o.status === "PROCESSED" ? "ok" : "crit"}
                          >
                            {o.status} · {o.mappedBy}
                          </span>
                        </div>
                        <p className="int-outcome-summary">{o.summary}</p>
                        {o.orchestrationSummary ? (
                          <p className="int-agent-note">
                            <strong>Orchestrator:</strong> {o.orchestrationSummary}
                          </p>
                        ) : null}
                        <div className="int-outcome-links">
                          {o.orderReference ? (
                            <Link href="/orders" className="int-inline-link">
                              Order {o.orderReference}
                              <ArrowUpRight size={12} />
                            </Link>
                          ) : null}
                          {o.shipmentReference ? (
                            <Link
                              href={`/shipments/${encodeURIComponent(o.shipmentReference)}`}
                              className="int-inline-link"
                            >
                              Shipment {o.shipmentReference}
                              <ArrowUpRight size={12} />
                            </Link>
                          ) : null}
                          {o.delegatedAgents.length > 0 ? (
                            <span className="int-meta-text">
                              Agents: {o.delegatedAgents.join(", ")}
                            </span>
                          ) : null}
                          {o.outboundWebhookStatus ? (
                            <span className="int-meta-text">
                              Callback: {o.outboundWebhookStatus}
                            </span>
                          ) : null}
                        </div>
                        {o.error ? (
                          <p className="text-crit">{o.error}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {previewResult ? (
                <div className="int-result-block">
                  <div className="int-result-head">
                    <strong>
                      Detected {previewResult.totalRecordsDetected} {previewResult.format}{" "}
                      record(s)
                    </strong>
                    {Object.keys(previewResult.suggestedFieldMapping).length > 0 &&
                    activeConnectorId ? (
                      <button
                        type="button"
                        className="int-btn-secondary"
                        onClick={handleSaveSuggestedMapping}
                      >
                        Save learned mapping to connector
                      </button>
                    ) : null}
                  </div>
                  {previewResult.records.map((rec, i) => (
                    <div key={i} className="int-outcome-item">
                      <div className="int-outcome-top">
                        <span className="int-text-strong">
                          {rec.entityType} → {rec.intent}
                        </span>
                        <span className="int-meta-text">
                          {rec.mappedBy} · {Math.round(rec.confidence * 100)}% confidence
                        </span>
                      </div>
                      <p className="int-outcome-summary">{rec.summary}</p>
                      <dl className="int-kv-grid">
                        {rec.externalRef ? (
                          <div>
                            <dt>External ref</dt>
                            <dd className="ref">{rec.externalRef}</dd>
                          </div>
                        ) : null}
                        {rec.originCity || rec.destinationCity ? (
                          <div>
                            <dt>Corridor</dt>
                            <dd>
                              {rec.originCity ?? "—"} → {rec.destinationCity ?? "—"}
                            </dd>
                          </div>
                        ) : null}
                        {rec.cargoDescription ? (
                          <div>
                            <dt>Cargo</dt>
                            <dd>{rec.cargoDescription}</dd>
                          </div>
                        ) : null}
                        {rec.weightKg != null ? (
                          <div>
                            <dt>Weight</dt>
                            <dd className="num">{rec.weightKg} kg</dd>
                          </div>
                        ) : null}
                        {rec.preferredMode ? (
                          <div>
                            <dt>Mode</dt>
                            <dd>{rec.preferredMode}</dd>
                          </div>
                        ) : null}
                        {rec.customerName ? (
                          <div>
                            <dt>Customer</dt>
                            <dd>{rec.customerName}</dd>
                          </div>
                        ) : null}
                        {rec.vehicleRegistration ? (
                          <div>
                            <dt>Vehicle</dt>
                            <dd className="ref">{rec.vehicleRegistration}</dd>
                          </div>
                        ) : null}
                        {rec.latitude != null && rec.longitude != null ? (
                          <div>
                            <dt>GPS</dt>
                            <dd className="num">
                              {rec.latitude}, {rec.longitude}
                            </dd>
                          </div>
                        ) : null}
                        {rec.sku ? (
                          <div>
                            <dt>Warehouse / SKU</dt>
                            <dd className="ref">
                              {rec.warehouseCode ?? "WH"} · {rec.sku} ({rec.onHand ?? 0} on hand)
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {/* TAB 3: SYNC & DELIVERY LOG */}
      {tab === "logs" ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Inbound &amp; outbound sync ledger</h2>
            <div className="int-log-filters">
              <input
                type="search"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="Filter by ref, system, or summary..."
                className="int-search-input"
              />
              <select
                value={logFilterStatus}
                onChange={(e) => setLogFilterStatus(e.target.value)}
                className="int-select-compact"
              >
                <option value="ALL">All statuses</option>
                <option value="PROCESSED">Processed</option>
                <option value="DUPLICATE">Duplicate</option>
                <option value="FAILED">Failed</option>
              </select>
              <button
                type="button"
                className="int-btn-ghost"
                onClick={refreshAll}
                title="Refresh sync log"
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>

          {filteredEvents.length === 0 ? (
            <div className="panel-body">
              <div className="empty">
                <p>No integration events recorded yet.</p>
                <p className="hint">
                  Send a webhook to <code>POST /api/v1/ingest</code> or test any
                  connected system in the Universal AI Mapper tab.
                </p>
              </div>
            </div>
          ) : (
            <div className="scroller" tabIndex={0} role="region" aria-label="Integration sync log">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">System</th>
                    <th scope="col">Entity</th>
                    <th scope="col">Control Tower ref</th>
                    <th scope="col">Mapper &amp; agents</th>
                    <th scope="col">Status</th>
                    <th scope="col">Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((ev) => {
                    const expanded = expandedEventId === ev.id;
                    return (
                      <Fragment key={ev.id}>
                        <tr
                          className="int-clickable-row"
                          onClick={() =>
                            setExpandedEventId(expanded ? null : ev.id)
                          }
                        >
                          <td className="num text-muted">
                            {formatShortTime(ev.createdAt)}
                          </td>
                          <td>
                            <div className="int-cell-primary">{ev.connectorName}</div>
                            <div className="int-meta-text">
                              {ev.format}
                              {ev.externalRef ? ` · ${ev.externalRef}` : ""}
                            </div>
                          </td>
                          <td>{ev.entityType}</td>
                          <td className="ref">
                            {ev.shipmentRef ? (
                              <Link
                                href={`/shipments/${encodeURIComponent(ev.shipmentRef)}`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {ev.shipmentRef}
                              </Link>
                            ) : ev.orderRef ? (
                              ev.orderRef
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>
                            <div>{ev.mappedBy}</div>
                            <div className="int-meta-text">
                              {ev.delegatedAgents.length > 0
                                ? ev.delegatedAgents.join(", ")
                                : "Sync only"}
                            </div>
                          </td>
                          <td>
                            <span
                              className="int-status-text"
                              data-tone={
                                ev.status === "FAILED"
                                  ? "crit"
                                  : ev.status === "DUPLICATE"
                                    ? "warn"
                                    : "ok"
                              }
                            >
                              {ev.status}
                            </span>
                          </td>
                          <td className="num text-muted">{ev.latencyMs} ms</td>
                        </tr>
                        {expanded ? (
                          <tr key={`${ev.id}-detail`}>
                            <td colSpan={7} className="int-expand-cell">
                              <div className="int-expand-grid">
                                <div>
                                  <span className="snippet-label">Summary</span>
                                  <p>{ev.summary}</p>
                                  {ev.outboundStatus ? (
                                    <p className="int-meta-text">
                                      Outbound webhook: {ev.outboundStatus}
                                    </p>
                                  ) : null}
                                  {ev.error ? (
                                    <p className="text-crit">{ev.error}</p>
                                  ) : null}
                                </div>
                                <div>
                                  <span className="snippet-label">
                                    Normalized canonical payload
                                  </span>
                                  <pre className="int-code-block">
                                    {JSON.stringify(ev.normalizedPayload, null, 2)}
                                  </pre>
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {/* TAB 4: API & WEBHOOK REFERENCE */}
      {tab === "reference" ? (
        <div className="grid-2">
          <section className="panel">
            <div className="panel-head">
              <h2>
                <Code2 size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                Universal ingest &amp; read endpoints
              </h2>
            </div>
            <div className="panel-body int-stack">
              <div className="int-endpoint-box">
                <div className="int-endpoint-row">
                  <span className="int-method">POST</span>
                  <code>{ingestEndpoint}</code>
                  <button
                    type="button"
                    className="int-btn-ghost"
                    onClick={() => copyText("ingestUrl", ingestEndpoint)}
                  >
                    {copiedId === "ingestUrl" ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
                <p className="int-meta-text">
                  Accepts JSON objects/arrays, RFC-4180 CSV manifests, or raw EDI X12
                  (204 / 214 / 856). Automatically maps fields, deduplicates via{" "}
                  <code>Idempotency-Key</code>, and dispatches the Orchestrator agent.
                </p>
              </div>

              <div className="int-endpoint-box">
                <div className="int-endpoint-row">
                  <span className="int-method" data-method="GET">
                    GET
                  </span>
                  <code>{shipmentsEndpoint}</code>
                  <button
                    type="button"
                    className="int-btn-ghost"
                    onClick={() => copyText("shipUrl", shipmentsEndpoint)}
                  >
                    {copiedId === "shipUrl" ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
                <p className="int-meta-text">
                  Returns live shipments scoped strictly to your organization. Supports{" "}
                  <code>?state=IN_TRANSIT</code> or <code>?reference=LG-10421</code>.
                </p>
              </div>

              <div>
                <div className="int-snippet-tabs">
                  {(["curl", "node", "python"] as const).map((lang) => (
                    <button
                      key={lang}
                      type="button"
                      className="int-tab"
                      data-active={snippetLang === lang}
                      onClick={() => setSnippetLang(lang)}
                    >
                      {lang === "curl" ? "cURL" : lang === "node" ? "Node.js" : "Python"}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="int-btn-ghost"
                    style={{ marginLeft: "auto" }}
                    onClick={() => copyText("snippet", codeSnippets[snippetLang])}
                  >
                    {copiedId === "snippet" ? <Check size={13} /> : <Copy size={13} />}
                    <span>{copiedId === "snippet" ? "Copied" : "Copy"}</span>
                  </button>
                </div>
                <pre className="int-code-block">{codeSnippets[snippetLang]}</pre>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>
                <Webhook size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                Bidirectional outbound callbacks &amp; security
              </h2>
            </div>
            <div className="panel-body int-stack">
              <p className="prose">
                When your connector includes an outbound webhook URL, Control Tower
                pushes signed JSON callbacks immediately after the autonomous agent
                plans a shipment, assigns a carrier, logs an exception, or settles an
                approval.
              </p>
              <dl className="kv">
                <dt>Authentication</dt>
                <dd>
                  <code>Authorization: Bearer ct_live_…</code> or{" "}
                  <code>X-API-Key: ct_live_…</code>
                </dd>
                <dt>Deduplication</dt>
                <dd>
                  Pass <code>Idempotency-Key</code> so ERP/webhook retries never create
                  duplicate shipments.
                </dd>
                <dt>Callback signature</dt>
                <dd>
                  Every outbound delivery includes{" "}
                  <code>X-ControlTower-Signature: sha256=…</code> and{" "}
                  <code>X-ControlTower-Event</code>.
                </dd>
                <dt>Supported formats</dt>
                <dd>
                  Arbitrary JSON, batch JSON arrays, RFC-4180 CSV, and ANSI EDI X12
                  (204, 214, 856).
                </dd>
              </dl>
              <div>
                <span className="snippet-label">Sample outbound callback payload</span>
                <pre className="int-code-block">
                  {JSON.stringify(
                    {
                      event: "shipment.created",
                      connectorId: "conn_example123",
                      timestamp: "2026-11-24T13:15:00.000Z",
                      data: {
                        externalRef: "SAP-FO-88412",
                        entityType: "ORDER",
                        orderReference: "PO-2026-4910",
                        shipmentReference: "LG-58214",
                        delegatedAgents: [
                          "order-management",
                          "warehouse-coordination",
                          "shipment-management",
                          "route-optimization",
                        ],
                        autonomyMode: "FULL_AUTONOMOUS",
                      },
                    },
                    null,
                    2,
                  )}
                </pre>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
