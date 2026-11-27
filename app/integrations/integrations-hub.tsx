"use client";

import Link from "next/link";
import { Fragment, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Code2,
  Copy,
  Database,
  FileUp,
  Globe,
  KeyRound,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Send,
  Server,
  Sliders,
  Sparkles,
  Trash2,
  Upload,
  Webhook,
  X,
  Zap,
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
import type { IntegrationConnectionMode } from "@/lib/local-store";

type TabId = "connectors" | "playground" | "logs" | "reference";
type SetupPathId = "website" | "database" | "api" | "import";

interface IssuedCredential {
  connectorName: string;
  apiKey: string;
  webhookSecret: string;
}

interface DiscoveredTableItem {
  schema: string;
  table: string;
  qualifiedName: string;
  suggestedEntity: string;
  rowCount: number;
}

interface PreviewResponse {
  format: string;
  totalRecordsDetected: number;
  previewedCount: number;
  entityBreakdown?: Record<string, number>;
  records: NormalizedLogisticsEvent[];
  suggestedFieldMapping: Record<string, string>;
}

interface LiveIngestResponse {
  ok: boolean;
  connectorName: string;
  format?: string;
  sourceKind?: string;
  tablesSynced?: string[];
  totalReceived: number;
  processed: number;
  duplicates: number;
  failed: number;
  entityCounts?: Record<string, number>;
  takeoverSummary?: {
    booked: number;
    awaitingApproval: number;
  };
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
    WEBSITE: "Website",
    DATABASE: "Database",
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

function connectionModeLabel(mode: IntegrationConnectionMode | string): string {
  const map: Record<string, string> = {
    POSTGRES_DB: "Live PostgreSQL",
    PULL_API: "Pull API",
    WEBSITE_EMBED: "Website & Webhook",
    FILE_IMPORT: "Whole-Data Import",
    PUSH_WEBHOOK: "Push Webhook",
  };
  return map[mode] ?? "Webhook";
}

function entityLabel(entity: string): string {
  const map: Record<string, string> = {
    WAREHOUSE: "Warehouses",
    CARRIER: "Carriers",
    CUSTOMER: "Customers",
    FLEET_VEHICLE: "Fleet units",
    DRIVER: "Drivers",
    INVENTORY_SYNC: "Inventory SKUs",
    ORDER: "Orders",
    SHIPMENT_UPDATE: "Shipment updates",
    TELEMETRY: "GPS updates",
    EXCEPTION: "Exceptions",
    CARRIER_QUOTE: "Quotes",
    CUSTOMS_DOC: "Customs docs",
  };
  return map[entity] ?? entity.replace(/_/g, " ");
}

function formatEntityBreakdown(counts?: Record<string, number>): string {
  if (!counts) return "";
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${entityLabel(k).toLowerCase()}`)
    .join(" · ");
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

  // Quick Connect Studio state
  const [showCreator, setShowCreator] = useState(initialConnectors.length === 0);
  const [setupPath, setSetupPath] = useState<SetupPathId>("website");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    "website_storefront",
  );
  const [newName, setNewName] = useState<string>("Company Website & Storefront");
  const [newAutonomy, setNewAutonomy] = useState<AutonomyMode>("FULL_AUTONOMOUS");
  const [newAutoTakeover, setNewAutoTakeover] = useState<boolean>(true);
  const [newOutboundUrl, setNewOutboundUrl] = useState<string>("");
  const [newSourceUrl, setNewSourceUrl] = useState<string>("");
  const [newSourceAuth, setNewSourceAuth] = useState<string>("");
  const [newDatabaseUrl, setNewDatabaseUrl] = useState<string>("");
  const [discoveredTables, setDiscoveredTables] = useState<DiscoveredTableItem[]>([]);
  const [selectedDbTables, setSelectedDbTables] = useState<string[]>([]);
  const [testingSource, setTestingSource] = useState(false);
  const [sourceTestSummary, setSourceTestSummary] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Edit connector panel state
  const [editingConnector, setEditingConnector] = useState<PublicConnector | null>(null);
  const [editName, setEditName] = useState("");
  const [editAutonomy, setEditAutonomy] = useState<AutonomyMode>("FULL_AUTONOMOUS");
  const [editAutoTakeover, setEditAutoTakeover] = useState(true);
  const [editSourceUrl, setEditSourceUrl] = useState("");
  const [editSourceAuth, setEditSourceAuth] = useState("");
  const [editDatabaseUrl, setEditDatabaseUrl] = useState("");
  const [editOutboundUrl, setEditOutboundUrl] = useState("");
  const [editMappingText, setEditMappingText] = useState("{}");
  const [savingEdit, setSavingEdit] = useState(false);

  // Data & DB Import / AI Schema Mapper state
  const [activeConnectorId, setActiveConnectorId] = useState<string>(
    initialConnectors[0]?.id ?? "",
  );
  const [payloadText, setPayloadText] = useState<string>("");
  const [forceAiMap, setForceAiMap] = useState<boolean>(false);
  const [previewing, setPreviewing] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [previewResult, setPreviewResult] = useState<PreviewResponse | null>(null);
  const [ingestResult, setIngestResult] = useState<LiveIngestResponse | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Live Sync & Autonomous Takeover Sweep state
  const [syncingConnectorId, setSyncingConnectorId] = useState<string | null>(null);
  const [runningTakeover, setRunningTakeover] = useState(false);

  // Logs filter & inspection
  const [logSearch, setLogSearch] = useState("");
  const [logFilterStatus, setLogFilterStatus] = useState<string>("ALL");
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [busyConnectorId, setBusyConnectorId] = useState<string | null>(null);
  const [snippetLang, setSnippetLang] = useState<"embed" | "curl" | "node" | "python">(
    "embed",
  );

  const apiTemplates = useMemo(
    () =>
      templates.filter(
        (t) =>
          t.id !== "website_storefront" &&
          t.id !== "postgres_database" &&
          t.id !== "full_database_import",
      ),
    [templates],
  );

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

  function chooseSetupPath(path: SetupPathId) {
    setSetupPath(path);
    setBannerError(null);
    setSourceTestSummary(null);
    if (path === "website") {
      setSelectedTemplateId("website_storefront");
      setNewName("Company Website & Storefront");
      setNewAutonomy("FULL_AUTONOMOUS");
    } else if (path === "database") {
      setSelectedTemplateId("postgres_database");
      setNewName("Primary PostgreSQL Database");
      setNewAutonomy("FULL_AUTONOMOUS");
    } else if (path === "api") {
      const first = apiTemplates[0];
      if (first) {
        setSelectedTemplateId(first.id);
        setNewName(first.name);
        setNewAutonomy(first.defaultAutonomy);
      }
    } else if (path === "import") {
      setTab("playground");
      setShowCreator(false);
    }
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

  async function handleTestSourceConnection() {
    setBannerError(null);
    setSourceTestSummary(null);
    setTestingSource(true);
    try {
      const payload =
        setupPath === "database"
          ? { mode: "POSTGRES", databaseUrl: newDatabaseUrl }
          : {
              mode: "API",
              sourceUrl: newSourceUrl,
              sourceAuthHeader: newSourceAuth || undefined,
            };

      const res = await fetch("/api/integrations/test-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setBannerError(data.error ?? "Connection test failed.");
        return;
      }

      if (setupPath === "database") {
        const tables = (data.tables ?? []) as DiscoveredTableItem[];
        setDiscoveredTables(tables);
        setSelectedDbTables(tables.map((t) => t.qualifiedName));
        setSourceTestSummary(
          `Connected read-only to ${data.database ?? data.host ?? "PostgreSQL"} · discovered ${tables.length} table(s).`,
        );
      } else {
        const breakdown = formatEntityBreakdown(data.entityBreakdown);
        setSourceTestSummary(
          `HTTP ${data.statusCode ?? 200} · detected ${data.totalRecords} ${data.format ?? "JSON"} record(s)${breakdown ? ` (${breakdown})` : ""}.`,
        );
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Network error while testing connection.");
    } finally {
      setTestingSource(false);
    }
  }

  function toggleDbTable(qualifiedName: string) {
    setSelectedDbTables((prev) =>
      prev.includes(qualifiedName)
        ? prev.filter((t) => t !== qualifiedName)
        : [...prev, qualifiedName],
    );
  }

  async function handleCreateConnector(e: React.FormEvent, syncImmediately = false) {
    e.preventDefault();
    setBannerError(null);
    setBannerSuccess(null);

    if (setupPath === "database" && !newDatabaseUrl.trim()) {
      setBannerError("Enter your read-only PostgreSQL connection URI first.");
      return;
    }

    setCreating(true);
    try {
      const connectionMode: IntegrationConnectionMode =
        setupPath === "database"
          ? "POSTGRES_DB"
          : setupPath === "website"
            ? newSourceUrl.trim()
              ? "PULL_API"
              : "WEBSITE_EMBED"
            : newSourceUrl.trim()
              ? "PULL_API"
              : "PUSH_WEBHOOK";

      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          systemType: selectedTemplateId,
          connectionMode,
          autoTakeover: newAutoTakeover,
          sourceUrl: newSourceUrl.trim() || null,
          sourceAuthHeader: newSourceAuth.trim() || null,
          databaseUrl:
            setupPath === "database" ? newDatabaseUrl.trim() || null : null,
          dbTables: setupPath === "database" ? selectedDbTables : undefined,
          autonomyMode: newAutonomy,
          outboundWebhookUrl: newOutboundUrl.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBannerError(data.error ?? "Failed to create connector.");
        return;
      }

      const createdConn = data.connector as PublicConnector;
      setConnectors((prev) => [createdConn, ...prev]);
      setActiveConnectorId(createdConn.id);
      setIssuedCred({
        connectorName: createdConn.name,
        apiKey: data.apiKey,
        webhookSecret: data.webhookSecret,
      });
      setNewOutboundUrl("");
      setNewSourceUrl("");
      setNewSourceAuth("");
      setNewDatabaseUrl("");
      setDiscoveredTables([]);
      setSelectedDbTables([]);
      setSourceTestSummary(null);
      setShowCreator(false);

      if (
        syncImmediately &&
        (createdConn.hasDatabaseConfig || createdConn.sourceUrl)
      ) {
        setBannerSuccess(
          `Connected "${createdConn.name}". Running initial whole-system sync & autonomous takeover now...`,
        );
        await handleSyncNow(createdConn);
      } else {
        setBannerSuccess(
          `Connected "${createdConn.name}". Copy your API key below — it is shown only once.`,
        );
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Network error");
    } finally {
      setCreating(false);
    }
  }

  async function handleSyncNow(conn: PublicConnector) {
    setBannerError(null);
    setBannerSuccess(null);
    setSyncingConnectorId(conn.id);
    try {
      const res = await fetch(`/api/integrations/${conn.id}/sync`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setBannerError(data.error ?? `Live sync failed for "${conn.name}".`);
        return;
      }
      const typed = data as LiveIngestResponse;
      setIngestResult(typed);
      if (Array.isArray(typed.events) && typed.events.length > 0) {
        setEvents((prev) => [...typed.events, ...prev].slice(0, 80));
      }
      await refreshAll();
      const breakdown = formatEntityBreakdown(typed.entityCounts);
      const bookedNote = typed.takeoverSummary?.booked
        ? ` · ${typed.takeoverSummary.booked} shipment(s) autonomously booked`
        : typed.takeoverSummary?.awaitingApproval
          ? ` · ${typed.takeoverSummary.awaitingApproval} queued in Approvals`
          : "";
      setBannerSuccess(
        `Synced ${typed.processed} record(s) from "${conn.name}"${breakdown ? ` (${breakdown})` : ""}${bookedNote}.`,
      );
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Network error during sync.");
    } finally {
      setSyncingConnectorId(null);
    }
  }

  async function handleRunAutonomousTakeover() {
    setBannerError(null);
    setBannerSuccess(null);
    setRunningTakeover(true);
    try {
      const res = await fetch("/api/integrations/takeover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autonomyMode: "FULL_AUTONOMOUS" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBannerError(data.error ?? "Autonomous takeover sweep failed.");
        return;
      }
      if (data.scanned === 0) {
        setBannerSuccess(
          "Autonomous takeover checked your workspace: all active shipments are already planned and booked.",
        );
      } else {
        setBannerSuccess(
          `Autonomous takeover completed across ${data.scanned} open shipment(s): ${data.booked} booked end-to-end${data.awaitingApproval ? `, ${data.awaitingApproval} queued for approval` : ""}.`,
        );
      }
      await refreshAll();
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Network error");
    } finally {
      setRunningTakeover(false);
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
      setBannerSuccess(
        `Rotated API key for "${conn.name}". Update your external system now.`,
      );
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
    setEditAutoTakeover(conn.autoTakeover !== false);
    setEditSourceUrl(conn.sourceUrl ?? "");
    setEditSourceAuth("");
    setEditDatabaseUrl("");
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
        setBannerError(
          "Field mapping must be a flat JSON object of canonicalField: sourcePath.",
        );
        return;
      }
      parsedMapping = raw as Record<string, string>;
    } catch {
      setBannerError("Field mapping contains invalid JSON.");
      return;
    }

    setSavingEdit(true);
    try {
      const patchBody: Record<string, unknown> = {
        name: editName,
        autonomyMode: editAutonomy,
        autoTakeover: editAutoTakeover,
        sourceUrl: editSourceUrl.trim() || null,
        outboundWebhookUrl: editOutboundUrl.trim() || null,
        fieldMapping: parsedMapping,
      };
      if (editSourceAuth.trim()) {
        patchBody.sourceAuthHeader = editSourceAuth.trim();
      }
      if (editDatabaseUrl.trim()) {
        patchBody.databaseUrl = editDatabaseUrl.trim();
      }

      const res = await fetch(`/api/integrations/${editingConnector.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
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
    setActiveConnectorId(conn.id);
    setPayloadText("");
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

  async function ensureActiveConnectorForImport(): Promise<string | null> {
    if (activeConnectorId) return activeConnectorId;
    if (connectors[0]?.id) {
      setActiveConnectorId(connectors[0].id);
      return connectors[0].id;
    }
    // Effortless auto-provisioning if user imports data before creating a connector
    const res = await fetch("/api/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Whole-Database Import",
        systemType: "full_database_import",
        connectionMode: "FILE_IMPORT",
        autoTakeover: true,
        autonomyMode: "FULL_AUTONOMOUS",
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.connector?.id) {
      setBannerError(data.error ?? "Could not initialize import connector.");
      return null;
    }
    setConnectors((prev) => [data.connector, ...prev]);
    setActiveConnectorId(data.connector.id);
    return data.connector.id as string;
  }

  async function handleRunLiveIngest() {
    setBannerError(null);
    setBannerSuccess(null);
    setIngesting(true);
    setIngestResult(null);
    try {
      const targetId = await ensureActiveConnectorForImport();
      if (!targetId) return;

      const res = await fetch(`/api/integrations/${targetId}/simulate`, {
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
      const breakdown = formatEntityBreakdown(typed.entityCounts);
      const bookedNote = typed.takeoverSummary?.booked
        ? ` · ${typed.takeoverSummary.booked} shipment(s) autonomously booked`
        : typed.takeoverSummary?.awaitingApproval
          ? ` · ${typed.takeoverSummary.awaitingApproval} queued in Approvals`
          : "";
      setBannerSuccess(
        `Imported ${typed.processed} of ${typed.totalReceived} record(s) via ${typed.connectorName}${breakdown ? ` (${breakdown})` : ""}${bookedNote}.`,
      );
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Network error");
    } finally {
      setIngesting(false);
    }
  }

  function loadFileIntoEditor(file: File) {
    if (file.size > 2 * 1024 * 1024) {
      setBannerError("File exceeds 2 MB upload limit.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      setPayloadText(text);
      setPreviewResult(null);
      setIngestResult(null);
      setBannerError(null);
    };
    reader.readAsText(file);
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    loadFileIntoEditor(file);
    e.target.value = "";
  }

  function handleDropFile(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadFileIntoEditor(file);
  }

  const sampleKeyPlaceholder = issuedCred?.apiKey ?? "ct_live_YOUR_CONNECTOR_API_KEY";
  const ingestEndpoint = `${origin}/api/v1/ingest`;
  const shipmentsEndpoint = `${origin}/api/v1/shipments`;

  const codeSnippets = {
    embed: `<!-- Drop into any company website or checkout page -->
<iframe
  src="${origin}/track"
  title="Shipment Tracking & Booking Portal"
  style="width:100%;height:680px;border:1px solid #d4d4d8;border-radius:10px;"
  loading="lazy"
></iframe>

<!-- Forward website orders automatically to Control Tower -->
<script>
async function forwardOrderToControlTower(order) {
  await fetch("${ingestEndpoint}", {
    method: "POST",
    headers: {
      "Authorization": "Bearer ${sampleKeyPlaceholder}",
      "Content-Type": "application/json",
      "Idempotency-Key": order.id
    },
    body: JSON.stringify(order)
  });
}
</script>`,
    curl: `curl -X POST "${ingestEndpoint}" \\
  -H "Authorization: Bearer ${sampleKeyPlaceholder}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: <unique-event-id>" \\
  -d '${JSON.stringify({
    warehouses: [{ code: "WH-01", name: "Main Hub", city: "<origin_city>", country: "US" }],
    customers: [{ code: "CUST-01", name: "<customer_name>", email: "<customer_email>" }],
    orders: [
      {
        external_ref: "<external_order_ref>",
        customer_name: "<customer_name>",
        origin_city: "<origin_city>",
        destination_city: "<destination_city>",
        cargo_description: "<cargo_description>",
        weight_kg: 1200,
        quantity: 4,
        mode: "ROAD",
      },
    ],
  })}'`,
    node: `const res = await fetch("${ingestEndpoint}", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${sampleKeyPlaceholder}",
    "Content-Type": "application/json",
    "Idempotency-Key": "<unique-event-id>",
  },
  body: JSON.stringify({
    customers: [{ code: "CUST-01", name: "<customer_name>", email: "<customer_email>" }],
    orders: [{
      external_ref: "<external_order_ref>",
      customer_name: "<customer_name>",
      origin_city: "<origin_city>",
      destination_city: "<destination_city>",
      cargo_description: "<cargo_description>",
      weight_kg: 1200,
      quantity: 4,
      mode: "ROAD",
    }],
  }),
});
const data = await res.json();
console.log("Synced entities:", data.entityCounts, "Booked:", data.takeoverSummary);`,
    python: `import requests

resp = requests.post(
    "${ingestEndpoint}",
    headers={
        "Authorization": "Bearer ${sampleKeyPlaceholder}",
        "Idempotency-Key": "<unique-event-id>",
    },
    json={
        "orders": [{
            "external_ref": "<external_order_ref>",
            "customer_name": "<customer_name>",
            "origin_city": "<origin_city>",
            "destination_city": "<destination_city>",
            "cargo_description": "<cargo_description>",
            "weight_kg": 1200,
            "quantity": 4,
            "mode": "ROAD",
        }]
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
          <span className="int-kpi-label">Autonomous pipelines</span>
          <strong className="int-kpi-value num">{kpis.autonomousCount}</strong>
        </div>
        <div className="int-kpi">
          <span className="int-kpi-label">External records synced</span>
          <strong className="int-kpi-value num">{kpis.totalProcessed}</strong>
        </div>
        <div className="int-kpi">
          <span className="int-kpi-label">Sync reliability</span>
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
                Store these in your company system now. Only encrypted hashes are saved on
                our server — these secrets cannot be viewed again.
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
            Whole-database &amp; file import
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
            Website embed &amp; API
          </button>
        </div>

        {canManage ? (
          <div className="int-toolbar-actions">
            <button
              type="button"
              className="int-btn-secondary"
              disabled={runningTakeover}
              onClick={handleRunAutonomousTakeover}
              title="Autonomously plan routes, score carriers, assign fleet, and book any open shipments"
            >
              <Zap size={14} />
              <span>
                {runningTakeover ? "Running takeover..." : "Run autonomous takeover"}
              </span>
            </button>
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
          </div>
        ) : null}
      </div>

      {/* TAB 1: CONNECTED SYSTEMS & 4-PATH QUICK CONNECT */}
      {tab === "connectors" ? (
        <div className="int-stack">
          {showCreator && canManage ? (
            <section className="panel int-creator">
              <div className="panel-head">
                <h2>Connect your website, database, or logistics stack</h2>
                <span className="panel-hint">
                  Auto-maps warehouses, fleet, drivers, carriers, customers, inventory &amp; orders
                </span>
              </div>
              <div className="panel-body">
                {/* 4-Path Mode Selector */}
                <div className="int-path-grid" role="tablist" aria-label="Integration method">
                  <button
                    type="button"
                    className="int-path-card"
                    data-selected={setupPath === "website"}
                    onClick={() => chooseSetupPath("website")}
                  >
                    <div className="int-path-head">
                      <Globe size={16} />
                      <strong>Whole website &amp; storefront</strong>
                    </div>
                    <p>
                      Connect a live site API or webhook and drop in our 1-line portal embed.
                    </p>
                  </button>

                  <button
                    type="button"
                    className="int-path-card"
                    data-selected={setupPath === "database"}
                    onClick={() => chooseSetupPath("database")}
                  >
                    <div className="int-path-head">
                      <Database size={16} />
                      <strong>Live PostgreSQL database</strong>
                    </div>
                    <p>
                      Auto-discover tables read-only and sync your entire operational database.
                    </p>
                  </button>

                  <button
                    type="button"
                    className="int-path-card"
                    data-selected={setupPath === "api"}
                    onClick={() => chooseSetupPath("api")}
                  >
                    <div className="int-path-head">
                      <Server size={16} />
                      <strong>ERP / TMS / WMS / GPS API</strong>
                    </div>
                    <p>
                      Connect SAP, NetSuite, CargoWise, Shopify, Manhattan WMS, Samsara, or EDI.
                    </p>
                  </button>

                  <button
                    type="button"
                    className="int-path-card"
                    data-selected={setupPath === "import"}
                    onClick={() => chooseSetupPath("import")}
                  >
                    <div className="int-path-head">
                      <FileUp size={16} />
                      <strong>Full data export upload</strong>
                    </div>
                    <p>
                      Upload a multi-table JSON backup, SQL INSERT dump, CSV, or NDJSON file.
                    </p>
                  </button>
                </div>

                {/* ERP/TMS/WMS Template Grid when API path is chosen */}
                {setupPath === "api" ? (
                  <div className="int-template-grid">
                    {apiTemplates.map((tpl) => {
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
                ) : null}

                <form className="int-form" onSubmit={(e) => handleCreateConnector(e, false)}>
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
                        placeholder="Production website, database, or ERP name"
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
                          Full Autonomous — plan, assign fleet &amp; book end-to-end
                        </option>
                        <option value="ASSISTED_APPROVAL">
                          Assisted Approval — prepare plan &amp; queue sign-off
                        </option>
                        <option value="SYNC_ONLY">
                          Sync Only — mirror data without booking
                        </option>
                      </select>
                      <em>{AUTONOMY_MODE_META[newAutonomy].description}</em>
                    </label>
                  </div>

                  {/* LIVE POSTGRESQL DATABASE FIELDS */}
                  {setupPath === "database" ? (
                    <div className="int-subpanel">
                      <label className="int-field">
                        <span>Read-only PostgreSQL connection URI</span>
                        <div className="int-input-action-row">
                          <input
                            type="password"
                            required
                            value={newDatabaseUrl}
                            onChange={(e) => setNewDatabaseUrl(e.target.value)}
                            placeholder="postgresql://readonly_user:password@db.yourcompany.com:5432/logistics?sslmode=require"
                            autoComplete="off"
                          />
                          <button
                            type="button"
                            className="int-btn-secondary"
                            disabled={testingSource || !newDatabaseUrl.trim()}
                            onClick={handleTestSourceConnection}
                          >
                            <Database size={14} />
                            <span>
                              {testingSource
                                ? "Discovering..."
                                : "Test & discover tables"}
                            </span>
                          </button>
                        </div>
                        <em>
                          Stored encrypted at rest and queried strictly in read-only mode.
                          Publicly routable PostgreSQL hosts only.
                        </em>
                      </label>

                      {sourceTestSummary ? (
                        <p className="int-test-ok">{sourceTestSummary}</p>
                      ) : null}

                      {discoveredTables.length > 0 ? (
                        <div className="int-table-picker">
                          <div className="int-table-picker-head">
                            <strong>
                              Select tables to sync ({selectedDbTables.length} /{" "}
                              {discoveredTables.length})
                            </strong>
                            <button
                              type="button"
                              className="int-btn-ghost"
                              onClick={() =>
                                setSelectedDbTables(
                                  selectedDbTables.length === discoveredTables.length
                                    ? []
                                    : discoveredTables.map((t) => t.qualifiedName),
                                )
                              }
                            >
                              {selectedDbTables.length === discoveredTables.length
                                ? "Clear all"
                                : "Select all"}
                            </button>
                          </div>
                          <div className="int-table-grid">
                            {discoveredTables.map((tbl) => {
                              const checked = selectedDbTables.includes(tbl.qualifiedName);
                              return (
                                <label key={tbl.qualifiedName} className="int-table-option">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleDbTable(tbl.qualifiedName)}
                                  />
                                  <span className="int-table-option-info">
                                    <span className="int-cell-primary">
                                      {tbl.qualifiedName}
                                    </span>
                                    <span className="int-meta-text">
                                      → {entityLabel(tbl.suggestedEntity)} ·{" "}
                                      {tbl.rowCount.toLocaleString()} rows
                                    </span>
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    /* WEBSITE OR ERP/API PULL FEED FIELDS */
                    <div className="int-subpanel">
                      <div className="int-form-grid">
                        <label className="int-field">
                          <span>
                            Live Pull API / Site Feed URL{" "}
                            <span className="int-optional">(optional)</span>
                          </span>
                          <input
                            type="url"
                            value={newSourceUrl}
                            onChange={(e) => setNewSourceUrl(e.target.value)}
                            placeholder="https://api.yourcompany.com/v1/logistics/export"
                          />
                          <em>
                            Provide an HTTPS endpoint returning JSON, CSV, or NDJSON to
                            sync on demand with one click.
                          </em>
                        </label>

                        <label className="int-field">
                          <span>
                            Pull API Authorization header{" "}
                            <span className="int-optional">(optional)</span>
                          </span>
                          <input
                            type="password"
                            value={newSourceAuth}
                            onChange={(e) => setNewSourceAuth(e.target.value)}
                            placeholder="Bearer sk_live_... or Basic ..."
                            autoComplete="off"
                          />
                          <em>Encrypted at rest and never returned to the browser.</em>
                        </label>
                      </div>

                      {newSourceUrl.trim() ? (
                        <div className="int-form-actions">
                          <button
                            type="button"
                            className="int-btn-secondary"
                            disabled={testingSource}
                            onClick={handleTestSourceConnection}
                          >
                            <RefreshCw size={14} />
                            <span>
                              {testingSource ? "Testing endpoint..." : "Test Pull API"}
                            </span>
                          </button>
                          {sourceTestSummary ? (
                            <span className="int-test-ok">{sourceTestSummary}</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )}

                  <label className="int-field">
                    <span>
                      Outbound status callback URL{" "}
                      <span className="int-optional">(optional)</span>
                    </span>
                    <input
                      type="url"
                      value={newOutboundUrl}
                      onChange={(e) => setNewOutboundUrl(e.target.value)}
                      placeholder="https://yourcompany.com/webhooks/control-tower"
                    />
                    <em>
                      Control Tower signs every autonomous booking, route plan, and
                      exception update with HMAC-SHA256 and POSTs it back to your site.
                    </em>
                  </label>

                  <label className="int-checkbox">
                    <input
                      type="checkbox"
                      checked={newAutoTakeover}
                      onChange={(e) => setNewAutoTakeover(e.target.checked)}
                    />
                    <span>
                      Automatically run end-to-end autonomous takeover (route planning,
                      carrier scoring, fleet assignment &amp; booking) on every synced order
                    </span>
                  </label>

                  <div className="int-form-actions">
                    {setupPath === "database" || newSourceUrl.trim() ? (
                      <button
                        type="button"
                        className="int-btn-primary"
                        disabled={creating}
                        onClick={(e) => handleCreateConnector(e, true)}
                      >
                        <Zap size={15} />
                        <span>
                          {creating
                            ? "Connecting & syncing..."
                            : setupPath === "database"
                              ? "Connect & sync whole database"
                              : "Connect & run first sync"}
                        </span>
                      </button>
                    ) : null}

                    <button
                      type="submit"
                      className={
                        setupPath === "database" || newSourceUrl.trim()
                          ? "int-btn-secondary"
                          : "int-btn-primary"
                      }
                      disabled={creating}
                    >
                      <Plug size={15} />
                      <span>
                        {creating
                          ? "Provisioning..."
                          : "Save connector & issue API key"}
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

                  <div className="int-form-grid">
                    <label className="int-field">
                      <span>Live Pull API URL</span>
                      <input
                        type="url"
                        value={editSourceUrl}
                        onChange={(e) => setEditSourceUrl(e.target.value)}
                        placeholder="https://api.yourcompany.com/v1/export"
                      />
                    </label>
                    <label className="int-field">
                      <span>
                        Replace Pull API Auth Header{" "}
                        <span className="int-optional">
                          ({editingConnector.hasSourceAuth ? "saved" : "not set"})
                        </span>
                      </span>
                      <input
                        type="password"
                        value={editSourceAuth}
                        onChange={(e) => setEditSourceAuth(e.target.value)}
                        placeholder="Leave blank to keep existing"
                        autoComplete="off"
                      />
                    </label>
                  </div>

                  <div className="int-form-grid">
                    <label className="int-field">
                      <span>
                        Replace PostgreSQL URI{" "}
                        <span className="int-optional">
                          ({editingConnector.hasDatabaseConfig ? "connected" : "not set"})
                        </span>
                      </span>
                      <input
                        type="password"
                        value={editDatabaseUrl}
                        onChange={(e) => setEditDatabaseUrl(e.target.value)}
                        placeholder="Leave blank to keep existing"
                        autoComplete="off"
                      />
                    </label>
                    <label className="int-field">
                      <span>Outbound callback webhook URL</span>
                      <input
                        type="url"
                        value={editOutboundUrl}
                        onChange={(e) => setEditOutboundUrl(e.target.value)}
                        placeholder="https://yourcompany.com/webhooks/control-tower"
                      />
                    </label>
                  </div>

                  <label className="int-checkbox">
                    <input
                      type="checkbox"
                      checked={editAutoTakeover}
                      onChange={(e) => setEditAutoTakeover(e.target.checked)}
                    />
                    <span>Run end-to-end autonomous takeover automatically on sync</span>
                  </label>

                  <label className="int-field">
                    <span>Custom field mapping JSON (canonicalField → source.dot.path)</span>
                    <textarea
                      rows={5}
                      value={editMappingText}
                      onChange={(e) => setEditMappingText(e.target.value)}
                      className="int-code-input"
                    />
                    <em>
                      Leave empty to let the universal mapper auto-detect your schema.
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
                Live Pull APIs, read-only PostgreSQL databases, websites &amp; webhooks
              </span>
            </div>
            {connectors.length === 0 ? (
              <div className="panel-body">
                <div className="empty">
                  <p>No external systems connected yet.</p>
                  <p className="hint">
                    Connect your company website, live PostgreSQL database, ERP/TMS/WMS
                    API, or upload a full database export above. Once connected, Control
                    Tower takes over planning, carrier selection, fleet dispatch, and
                    tracking automatically.
                  </p>
                </div>
              </div>
            ) : (
              <div
                className="scroller"
                tabIndex={0}
                role="region"
                aria-label="Connected systems"
              >
                <table>
                  <thead>
                    <tr>
                      <th scope="col">System</th>
                      <th scope="col">Autonomy</th>
                      <th scope="col">Status</th>
                      <th scope="col">Key prefix</th>
                      <th scope="col">Synced</th>
                      <th scope="col">Last sync</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {connectors.map((c) => {
                      const busy = busyConnectorId === c.id;
                      const syncing = syncingConnectorId === c.id;
                      const canPullSync = Boolean(c.hasDatabaseConfig || c.sourceUrl);
                      return (
                        <tr key={c.id}>
                          <td>
                            <div className="int-cell-primary">{c.name}</div>
                            <div className="int-meta-text">
                              {connectionModeLabel(c.connectionMode)}
                              {" · "}
                              {categoryLabel(c.category)}
                              {c.dbTables?.length
                                ? ` · ${c.dbTables.length} tables`
                                : ""}
                              {c.outboundWebhookUrl ? " · Callback active" : ""}
                            </div>
                          </td>
                          <td>
                            <span className="int-text-strong">
                              {AUTONOMY_MODE_META[c.autonomyMode]?.label ??
                                c.autonomyMode}
                            </span>
                            <div className="int-meta-text">
                              {c.autoTakeover !== false
                                ? "Auto-takeover on"
                                : "Manual takeover"}
                            </div>
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
                              {canPullSync && canManage ? (
                                <button
                                  type="button"
                                  className="int-btn-ghost int-btn-accent-ghost"
                                  disabled={syncing || busy || c.status === "PAUSED"}
                                  onClick={() => handleSyncNow(c)}
                                  title="Pull latest records and run autonomous takeover"
                                >
                                  <RefreshCw size={13} />
                                  <span>{syncing ? "Syncing..." : "Sync now"}</span>
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="int-btn-ghost"
                                onClick={() => openPlaygroundForConnector(c)}
                                title="Import file or send payload through this connector"
                              >
                                <Upload size={13} />
                                <span>Import</span>
                              </button>
                              {canManage ? (
                                <>
                                  <button
                                    type="button"
                                    className="int-btn-ghost"
                                    onClick={() => openEdit(c)}
                                    disabled={busy}
                                    title="Edit source URL, database URI, mapping, and webhook settings"
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

      {/* TAB 2: WHOLE-DATABASE & FILE IMPORT / AI MAPPER */}
      {tab === "playground" ? (
        <div className="int-playground-grid">
          <section className="panel">
            <div className="panel-head">
              <h2>Whole-database &amp; payload import</h2>
              <span className="panel-hint">
                JSON bundle · SQL INSERT dump · CSV · NDJSON · EDI X12 (up to 2 MB)
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
                      <option value="">
                        Auto-create Whole-Database Import connector on ingest
                      </option>
                    ) : (
                      connectors.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({AUTONOMY_MODE_META[c.autonomyMode]?.label})
                        </option>
                      ))
                    )}
                  </select>
                </label>

                <div className="int-field">
                  <span>Upload export file</span>
                  <div
                    className="int-dropzone"
                    data-active={dragActive}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragActive(true);
                    }}
                    onDragLeave={() => setDragActive(false)}
                    onDrop={handleDropFile}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json,.sql,.csv,.ndjson,.txt,.edi,.x12"
                      onChange={handleFileUpload}
                      className="sr-only"
                    />
                    <button
                      type="button"
                      className="int-btn-secondary"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload size={14} />
                      <span>Choose .json / .sql / .csv / .edi</span>
                    </button>
                    <span className="int-meta-text">or drag &amp; drop here</span>
                  </div>
                </div>
              </div>

              <div className="int-payload-tools">
                <label className="int-checkbox">
                  <input
                    type="checkbox"
                    checked={forceAiMap}
                    onChange={(e) => setForceAiMap(e.target.checked)}
                  />
                  <span>Force Gemini AI schema discovery &amp; field-mapping suggestions</span>
                </label>
              </div>

              <textarea
                rows={15}
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
                className="int-code-input"
                aria-label="External database export or payload editor"
                placeholder={`Paste a multi-table JSON database export ({ "warehouses": [...], "carriers": [...], "fleet": [...], "customers": [...], "orders": [...] }), SQL INSERT dump, CSV manifest, NDJSON, or EDI X12 message...`}
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
                    {previewing ? "Analyzing schema..." : "Preview mapped entities"}
                  </span>
                </button>
                <button
                  type="button"
                  className="int-btn-primary"
                  disabled={ingesting || !payloadText.trim()}
                  onClick={handleRunLiveIngest}
                >
                  <Zap size={14} />
                  <span>
                    {ingesting
                      ? "Importing & running takeover..."
                      : "Import & run autonomous takeover"}
                  </span>
                </button>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Auto-mapped entities &amp; autonomous execution</h2>
              <span className="panel-hint">
                Upserts master data &amp; executes planning, quoting, and booking
              </span>
            </div>
            <div className="panel-body int-stack">
              {ingestResult ? (
                <div className="int-result-block">
                  <div className="int-result-head">
                    <strong>
                      Imported {ingestResult.processed} / {ingestResult.totalReceived} record(s)
                    </strong>
                    <span className="int-meta-text">
                      {ingestResult.format ?? ingestResult.sourceKind ?? "SYNC"}
                      {ingestResult.takeoverSummary?.booked
                        ? ` · ${ingestResult.takeoverSummary.booked} booked`
                        : ""}
                      {ingestResult.takeoverSummary?.awaitingApproval
                        ? ` · ${ingestResult.takeoverSummary.awaitingApproval} pending approval`
                        : ""}
                    </span>
                  </div>

                  {ingestResult.entityCounts &&
                  Object.keys(ingestResult.entityCounts).length > 0 ? (
                    <p className="int-breakdown-line">
                      {formatEntityBreakdown(ingestResult.entityCounts)}
                    </p>
                  ) : null}

                  <div className="int-outcome-list">
                    {ingestResult.outcomes.slice(0, 20).map((o) => (
                      <div key={o.index} className="int-outcome-item">
                        <div className="int-outcome-top">
                          <span className="int-text-strong">
                            {entityLabel(o.entityType)}
                          </span>
                          <span
                            className="int-status-text"
                            data-tone={
                              o.status === "PROCESSED"
                                ? "ok"
                                : o.status === "DUPLICATE"
                                  ? "warn"
                                  : "crit"
                            }
                          >
                            {o.status}
                          </span>
                        </div>
                        <p className="int-outcome-summary">{o.summary}</p>
                        {o.orchestrationSummary ? (
                          <p className="int-agent-note">{o.orchestrationSummary}</p>
                        ) : null}
                        {o.error ? (
                          <p className="text-crit int-outcome-summary">{o.error}</p>
                        ) : null}
                        <div className="int-outcome-links">
                          {o.shipmentReference ? (
                            <Link
                              href={`/shipments/${encodeURIComponent(o.shipmentReference)}`}
                              className="int-inline-link"
                            >
                              <span>Open {o.shipmentReference}</span>
                              <ArrowUpRight size={12} />
                            </Link>
                          ) : null}
                          {o.entityType === "WAREHOUSE" ? (
                            <Link href="/warehouses" className="int-inline-link">
                              <span>Warehouses</span>
                              <ArrowUpRight size={12} />
                            </Link>
                          ) : null}
                          {o.entityType === "CARRIER" ? (
                            <Link href="/carriers" className="int-inline-link">
                              <span>Carriers</span>
                              <ArrowUpRight size={12} />
                            </Link>
                          ) : null}
                          {o.entityType === "FLEET_VEHICLE" ||
                          o.entityType === "DRIVER" ? (
                            <Link href="/fleet" className="int-inline-link">
                              <span>Fleet</span>
                              <ArrowUpRight size={12} />
                            </Link>
                          ) : null}
                          {o.entityType === "CUSTOMER" ? (
                            <Link href="/customers" className="int-inline-link">
                              <span>Customers</span>
                              <ArrowUpRight size={12} />
                            </Link>
                          ) : null}
                          {o.outboundWebhookStatus ? (
                            <span className="int-meta-text">
                              Callback: {o.outboundWebhookStatus}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : previewResult ? (
                <div className="int-result-block">
                  <div className="int-result-head">
                    <strong>
                      Detected {previewResult.totalRecordsDetected} record(s) (
                      {previewResult.format})
                    </strong>
                    {Object.keys(previewResult.suggestedFieldMapping ?? {}).length > 0 &&
                    activeConnectorId ? (
                      <button
                        type="button"
                        className="int-btn-ghost"
                        onClick={handleSaveSuggestedMapping}
                      >
                        <Check size={13} />
                        <span>Save AI field mapping</span>
                      </button>
                    ) : null}
                  </div>

                  {previewResult.entityBreakdown &&
                  Object.keys(previewResult.entityBreakdown).length > 0 ? (
                    <p className="int-breakdown-line">
                      {formatEntityBreakdown(previewResult.entityBreakdown)}
                    </p>
                  ) : null}

                  <div className="int-outcome-list">
                    {previewResult.records.map((rec, i) => (
                      <div key={i} className="int-outcome-item">
                        <div className="int-outcome-top">
                          <span className="int-text-strong">
                            {entityLabel(rec.entityType)}
                          </span>
                          <span className="int-meta-text">
                            {rec.mappedBy} · {Math.round(rec.confidence * 100)}%
                          </span>
                        </div>
                        <p className="int-outcome-summary">{rec.summary}</p>
                        <dl className="int-kv-grid">
                          {rec.externalRef ? (
                            <div>
                              <dt>External Ref</dt>
                              <dd className="ref">{rec.externalRef}</dd>
                            </div>
                          ) : null}
                          {rec.originCity || rec.destinationCity ? (
                            <div>
                              <dt>Lane / City</dt>
                              <dd>
                                {rec.originCity && rec.destinationCity
                                  ? `${rec.originCity} → ${rec.destinationCity}`
                                  : rec.originCity ?? rec.destinationCity}
                              </dd>
                            </div>
                          ) : null}
                          {rec.customerName ? (
                            <div>
                              <dt>Customer</dt>
                              <dd>{rec.customerName}</dd>
                            </div>
                          ) : null}
                          {rec.carrierName ? (
                            <div>
                              <dt>Carrier</dt>
                              <dd>
                                {rec.carrierName}
                                {rec.carrierModes?.length
                                  ? ` (${rec.carrierModes.join(", ")})`
                                  : ""}
                              </dd>
                            </div>
                          ) : null}
                          {rec.vehicleRegistration ? (
                            <div>
                              <dt>Vehicle</dt>
                              <dd className="ref">
                                {rec.vehicleRegistration}
                                {rec.capacityKg ? ` · ${rec.capacityKg} kg` : ""}
                              </dd>
                            </div>
                          ) : null}
                          {rec.weightKg ? (
                            <div>
                              <dt>Weight</dt>
                              <dd className="num">{rec.weightKg} kg</dd>
                            </div>
                          ) : null}
                        </dl>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="empty">
                  <p>Upload or paste your site or database export on the left.</p>
                  <p className="hint">
                    Supports multi-table JSON backups, SQL INSERT dumps, CSV spreadsheets,
                    NDJSON streams, and EDI X12. Warehouses, carriers, fleet, drivers,
                    customers, inventory, and orders are imported in dependency order and
                    dispatched automatically.
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {/* TAB 3: SYNC LOG */}
      {tab === "logs" ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Sync &amp; webhook event log</h2>
            <div className="int-log-filters">
              <input
                type="search"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="Search ref, entity, or system..."
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
              >
                <RefreshCw size={13} />
                <span>Refresh</span>
              </button>
            </div>
          </div>

          {filteredEvents.length === 0 ? (
            <div className="panel-body">
              <div className="empty">
                <p>No integration events recorded yet.</p>
                <p className="hint">
                  Sync a connected database, pull from your site API, or upload a data
                  export to see live records and autonomous bookings here.
                </p>
              </div>
            </div>
          ) : (
            <div
              className="scroller"
              tabIndex={0}
              role="region"
              aria-label="Integration sync events"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">System</th>
                    <th scope="col">Entity</th>
                    <th scope="col">Reference</th>
                    <th scope="col">Status</th>
                    <th scope="col">Summary</th>
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
                            <div className="int-cell-primary">
                              {ev.connectorName}
                            </div>
                            <div className="int-meta-text">
                              {ev.format} · {ev.mappedBy}
                            </div>
                          </td>
                          <td>{entityLabel(ev.entityType)}</td>
                          <td className="ref">
                            {ev.shipmentRef ? (
                              <Link
                                href={`/shipments/${encodeURIComponent(ev.shipmentRef)}`}
                                className="int-inline-link"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {ev.shipmentRef}
                              </Link>
                            ) : (
                              ev.externalRef ?? "—"
                            )}
                          </td>
                          <td>
                            <span
                              className="int-status-text"
                              data-tone={
                                ev.status === "PROCESSED" ||
                                ev.status === "DELIVERED"
                                  ? "ok"
                                  : ev.status === "DUPLICATE"
                                    ? "warn"
                                    : "crit"
                              }
                            >
                              {ev.status}
                            </span>
                          </td>
                          <td>{ev.summary}</td>
                          <td className="num text-muted">{ev.latencyMs} ms</td>
                        </tr>
                        {expanded ? (
                          <tr>
                            <td colSpan={7} className="int-expand-cell">
                              <div className="int-expand-grid">
                                <div>
                                  <strong className="int-meta-text">
                                    Raw incoming preview
                                  </strong>
                                  <pre className="int-code-block">
                                    {ev.rawPreview}
                                  </pre>
                                </div>
                                <div>
                                  <strong className="int-meta-text">
                                    Normalized canonical record
                                  </strong>
                                  <pre className="int-code-block">
                                    {JSON.stringify(
                                      ev.normalizedPayload,
                                      null,
                                      2,
                                    )}
                                  </pre>
                                </div>
                              </div>
                              {ev.error ? (
                                <p className="text-crit int-outcome-summary">
                                  Error: {ev.error}
                                </p>
                              ) : null}
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

      {/* TAB 4: WEBSITE EMBED & API REFERENCE */}
      {tab === "reference" ? (
        <div className="int-stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Universal ingest &amp; website embed reference</h2>
              <span className="panel-hint">
                Authenticated via org-scoped Bearer / X-API-Key
              </span>
            </div>
            <div className="panel-body int-stack">
              <div className="int-endpoint-box">
                <span className="int-meta-text">Universal Ingest Endpoint (JSON, Multi-table DB, SQL, CSV, NDJSON, EDI X12)</span>
                <div className="int-endpoint-row">
                  <span className="int-text-strong">POST</span>
                  <code>{ingestEndpoint}</code>
                  <button
                    type="button"
                    className="int-btn-ghost"
                    onClick={() => copyText("ingestEp", ingestEndpoint)}
                  >
                    {copiedId === "ingestEp" ? <Check size={13} /> : <Copy size={13} />}
                    <span>{copiedId === "ingestEp" ? "Copied" : "Copy"}</span>
                  </button>
                </div>
              </div>

              <div className="int-endpoint-box">
                <span className="int-meta-text">Live Shipments Status Read Endpoint</span>
                <div className="int-endpoint-row">
                  <span className="int-text-strong">GET</span>
                  <code>{shipmentsEndpoint}</code>
                  <button
                    type="button"
                    className="int-btn-ghost"
                    onClick={() => copyText("shipEp", shipmentsEndpoint)}
                  >
                    {copiedId === "shipEp" ? <Check size={13} /> : <Copy size={13} />}
                    <span>{copiedId === "shipEp" ? "Copied" : "Copy"}</span>
                  </button>
                </div>
              </div>

              <div className="int-toolbar">
                <div className="int-tabs">
                  {(
                    [
                      ["embed", "Website Embed"],
                      ["curl", "cURL"],
                      ["node", "Node.js"],
                      ["python", "Python"],
                    ] as const
                  ).map(([lang, label]) => (
                    <button
                      key={lang}
                      type="button"
                      className="int-tab"
                      data-active={snippetLang === lang}
                      onClick={() => setSnippetLang(lang)}
                    >
                      <Code2 size={13} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="int-btn-secondary"
                  onClick={() => copyText("snippet", codeSnippets[snippetLang])}
                >
                  {copiedId === "snippet" ? <Check size={14} /> : <Copy size={14} />}
                  <span>{copiedId === "snippet" ? "Copied" : "Copy snippet"}</span>
                </button>
              </div>

              <pre className="int-code-block">{codeSnippets[snippetLang]}</pre>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Outbound status callbacks (HMAC-SHA256)</h2>
              <span className="panel-hint">
                <Webhook size={13} /> Signed with X-ControlTower-Signature
              </span>
            </div>
            <div className="panel-body">
              <p className="int-outcome-summary">
                Whenever Control Tower autonomously books a carrier, assigns a vehicle,
                flags an exception, or receives an approval decision, we POST a signed JSON
                envelope to your configured outbound webhook URL. Verify authenticity by
                computing HMAC-SHA256 of the raw request body with your connector webhook
                secret and comparing against the <code>X-ControlTower-Signature</code>{" "}
                header in constant time.
              </p>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
