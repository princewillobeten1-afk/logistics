"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRight,
  BookOpen,
  Check,
  Code2,
  Copy,
  Database,
  FileCode2,
  KeyRound,
  Layers,
  Lock,
  Plug,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  Webhook,
} from "lucide-react";
import type { PublicConnector } from "@/lib/integrations/store";
import {
  API_ENDPOINTS,
  CANONICAL_ENTITIES,
  CODE_LANGS,
  FIELD_ALIASES,
  HTTP_STATUS_MATRIX,
  INTEGRATION_RECIPES,
  SHIPMENTS_RESPONSE_SAMPLE,
  WEBHOOK_ENVELOPE_SAMPLE,
  WEBHOOK_EVENTS,
  WEBHOOK_LANGS,
  buildIngestSnippet,
  buildShipmentsQuerySnippet,
  buildWebhookVerificationSnippet,
  type CodeLang,
  type RecipeId,
  type WebhookLang,
} from "@/lib/api-docs/snippets";

const NAV_SECTIONS = [
  { id: "quickstart", label: "Quickstart & Base URL" },
  { id: "authentication", label: "Auth & Idempotency" },
  { id: "endpoints", label: "Endpoint Directory" },
  { id: "ingest-recipes", label: "ERP & TMS Recipes" },
  { id: "canonical-entities", label: "Supported Entities" },
  { id: "shipments-query", label: "Query Shipments" },
  { id: "webhooks", label: "Outbound Webhooks" },
  { id: "field-mapping", label: "Field Mapping & Errors" },
];

function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API unavailable in restricted context
    }
  }

  return (
    <button
      type="button"
      className="docs-copy-btn"
      onClick={onCopy}
      aria-label={copied ? "Copied to clipboard" : `${label} to clipboard`}
    >
      {copied ? (
        <>
          <Check size={13} strokeWidth={2.2} aria-hidden="true" />
          <span>Copied</span>
        </>
      ) : (
        <>
          <Copy size={13} strokeWidth={1.9} aria-hidden="true" />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}

function MethodTag({ method }: { method: "GET" | "POST" | "PATCH" | "DELETE" }) {
  return (
    <span className={`docs-method docs-method-${method.toLowerCase()}`}>
      {method}
    </span>
  );
}

export function ApiDocsClient({
  origin,
  orgName,
  connectors,
}: {
  origin: string;
  orgName: string;
  connectors: PublicConnector[];
}) {
  const [lang, setLang] = useState<CodeLang>("curl");
  const [webhookLang, setWebhookLang] = useState<WebhookLang>("node");
  const [activeRecipe, setActiveRecipe] = useState<RecipeId>("erp_order");
  const [recipeView, setRecipeView] = useState<"request" | "response">("request");
  const [shipmentsView, setShipmentsView] = useState<"request" | "response">("request");
  const [selectedConnectorId, setSelectedConnectorId] = useState<string>(
    connectors[0]?.id ?? "",
  );
  const [filterQuery, setFilterQuery] = useState("");

  const selectedConnector = useMemo(
    () => connectors.find((c) => c.id === selectedConnectorId) ?? null,
    [connectors, selectedConnectorId],
  );

  // Never expose or ask for raw secrets; display masked key placeholder tailored to selected connector
  const keyPlaceholder = selectedConnector
    ? `${selectedConnector.apiKeyPrefix}YOUR_FULL_KEY`
    : "ct_live_YOUR_CONNECTOR_API_KEY";

  const recipe = useMemo(
    () => INTEGRATION_RECIPES.find((r) => r.id === activeRecipe) ?? INTEGRATION_RECIPES[0],
    [activeRecipe],
  );

  const ingestSnippet = useMemo(
    () => buildIngestSnippet(activeRecipe, lang, origin, keyPlaceholder),
    [activeRecipe, lang, origin, keyPlaceholder],
  );

  const shipmentsSnippet = useMemo(
    () => buildShipmentsQuerySnippet(lang, origin, keyPlaceholder),
    [lang, origin, keyPlaceholder],
  );

  const webhookVerifySnippet = useMemo(
    () => buildWebhookVerificationSnippet(webhookLang),
    [webhookLang],
  );

  const q = filterQuery.trim().toLowerCase();

  const filteredEndpoints = useMemo(() => {
    if (!q) return API_ENDPOINTS;
    return API_ENDPOINTS.filter(
      (ep) =>
        ep.path.toLowerCase().includes(q) ||
        ep.title.toLowerCase().includes(q) ||
        ep.summary.toLowerCase().includes(q) ||
        ep.method.toLowerCase().includes(q),
    );
  }, [q]);

  const filteredEntities = useMemo(() => {
    if (!q) return CANONICAL_ENTITIES;
    return CANONICAL_ENTITIES.filter(
      (row) =>
        row.entity.toLowerCase().includes(q) ||
        row.tableOrDomain.toLowerCase().includes(q) ||
        row.erpTmsExamples.toLowerCase().includes(q) ||
        row.autonomousAction.toLowerCase().includes(q),
    );
  }, [q]);

  const filteredAliases = useMemo(() => {
    if (!q) return FIELD_ALIASES;
    return FIELD_ALIASES.filter(
      (row) =>
        row.canonicalField.toLowerCase().includes(q) ||
        row.acceptedAliases.toLowerCase().includes(q) ||
        row.notes.toLowerCase().includes(q),
    );
  }, [q]);

  const filteredEvents = useMemo(() => {
    if (!q) return WEBHOOK_EVENTS;
    return WEBHOOK_EVENTS.filter(
      (row) =>
        row.event.toLowerCase().includes(q) ||
        row.trigger.toLowerCase().includes(q) ||
        row.typicalErpAction.toLowerCase().includes(q),
    );
  }, [q]);

  return (
    <div className="docs-shell">
      {/* Sticky left outline on desktop / compact horizontal jump bar on mobile */}
      <aside className="docs-toc" aria-label="Documentation sections">
        <div className="docs-toc-head">
          <BookOpen size={14} strokeWidth={1.9} aria-hidden="true" />
          <span>On this page</span>
        </div>
        <nav className="docs-toc-nav">
          {NAV_SECTIONS.map((sec) => (
            <a key={sec.id} href={`#${sec.id}`} className="docs-toc-link">
              {sec.label}
            </a>
          ))}
        </nav>

        <div className="docs-toc-card">
          <div className="docs-toc-card-title">Workspace scope</div>
          <p className="docs-toc-card-org">{orgName}</p>
          <p className="docs-toc-card-meta">
            {connectors.length === 0
              ? "No connectors provisioned yet."
              : `${connectors.length} connector${connectors.length === 1 ? "" : "s"} active in this org.`}
          </p>
          <Link href="/integrations" className="docs-toc-cta">
            <span>Open Integrations</span>
            <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
          </Link>
        </div>
      </aside>

      {/* Main documentation stream */}
      <div className="docs-main">
        {/* Global Controls Toolbar: Base URL, Language, Connector Context, Quick Search */}
        <section className="docs-toolbar" aria-label="Documentation controls">
          <div className="docs-toolbar-top">
            <div className="docs-env-block">
              <span className="docs-field-label">Base URL</span>
              <div className="docs-base-url-box">
                <code className="docs-base-url-code">{origin}</code>
                <CopyButton value={origin} label="Copy URL" />
              </div>
            </div>

            <div className="docs-env-block">
              <span className="docs-field-label">Active connector context</span>
              {connectors.length > 0 ? (
                <select
                  aria-label="Select connector for snippet placeholders"
                  className="docs-select"
                  value={selectedConnectorId}
                  onChange={(e) => setSelectedConnectorId(e.target.value)}
                >
                  {connectors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.apiKeyPrefix}… · {c.status})
                    </option>
                  ))}
                </select>
              ) : (
                <div className="docs-no-conn-row">
                  <span>No API key yet</span>
                  <Link href="/integrations" className="docs-inline-link">
                    Create connector →
                  </Link>
                </div>
              )}
            </div>
          </div>

          <div className="docs-toolbar-bottom">
            <div className="docs-lang-group" role="tablist" aria-label="Snippet language">
              <span className="docs-lang-caption">
                <Terminal size={13} strokeWidth={1.9} aria-hidden="true" />
                <span>Code language</span>
              </span>
              <div className="docs-lang-tabs">
                {CODE_LANGS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={lang === item.id}
                    className={`docs-lang-btn ${lang === item.id ? "is-active" : ""}`}
                    onClick={() => setLang(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="docs-search-wrap">
              <Search size={14} strokeWidth={1.9} aria-hidden="true" className="docs-search-icon" />
              <input
                type="search"
                className="docs-search-input"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="Filter endpoints, entities, fields, or events…"
                aria-label="Filter API documentation"
              />
            </div>
          </div>
        </section>

        {/* 1. Quickstart */}
        <section id="quickstart" className="docs-section">
          <div className="docs-section-head">
            <span className="docs-section-num">01</span>
            <div>
              <h2>ERP &amp; TMS integration quickstart</h2>
              <p>
                Connect SAP S/4HANA, Oracle NetSuite, Oracle OTM, Manhattan TMS, Blue Yonder,
                Shopify, or custom SQL backends in three steps—no middleware translation layer
                required.
              </p>
            </div>
          </div>

          <div className="docs-steps-grid">
            <div className="docs-step-card">
              <div className="docs-step-head">
                <KeyRound size={15} strokeWidth={1.9} aria-hidden="true" />
                <span>Step 1 · Provision a connector</span>
              </div>
              <p>
                Open <Link href="/integrations" className="docs-inline-link">System → Integrations</Link>{" "}
                and create a connector for your ERP, TMS, or PostgreSQL database. Copy the
                one-time <code className="docs-inline-code">ct_live_…</code> API key and{" "}
                <code className="docs-inline-code">whsec_…</code> webhook signing secret into your
                secrets vault.
              </p>
            </div>

            <div className="docs-step-card">
              <div className="docs-step-head">
                <Database size={15} strokeWidth={1.9} aria-hidden="true" />
                <span>Step 2 · Push or pull live records</span>
              </div>
              <p>
                Send orders, EDI X12 204/214 payloads, telematics pings, or whole-database JSON
                snapshots to <code className="docs-inline-code">POST /api/v1/ingest</code>, or let
                Control Tower pull directly from a read-only PostgreSQL database or HTTPS feed.
              </p>
            </div>

            <div className="docs-step-card">
              <div className="docs-step-head">
                <Webhook size={15} strokeWidth={1.9} aria-hidden="true" />
                <span>Step 3 · Verify signed callbacks</span>
              </div>
              <p>
                Configure an HTTPS callback URL on the connector. As Control Tower plans routes,
                assigns carriers and fleet units, and books shipments, it pushes HMAC-SHA256
                signed status events back to your ERP or TMS.
              </p>
            </div>
          </div>
        </section>

        {/* 2. Authentication & Idempotency */}
        <section id="authentication" className="docs-section">
          <div className="docs-section-head">
            <span className="docs-section-num">02</span>
            <div>
              <h2>Authentication, headers &amp; idempotency</h2>
              <p>
                Every machine-to-machine request to <code className="docs-inline-code">/api/v1/*</code>{" "}
                authenticates with an organisation-scoped connector API key stored as a one-way
                SHA-256 hash on our servers.
              </p>
            </div>
          </div>

          <div className="docs-table-wrap">
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Header</th>
                  <th>Requirement</th>
                  <th>Format &amp; behavior</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><code className="docs-inline-code">Authorization</code></td>
                  <td>Required (or X-API-Key)</td>
                  <td>
                    <code className="docs-inline-code">Bearer ct_live_…</code> — Preferred for
                    standard REST clients and enterprise API gateways.
                  </td>
                </tr>
                <tr>
                  <td><code className="docs-inline-code">X-API-Key</code></td>
                  <td>Alternative auth</td>
                  <td>
                    Raw <code className="docs-inline-code">ct_live_…</code> key for legacy ERP
                    connectors or EDI bridges that reserve the Authorization header.
                  </td>
                </tr>
                <tr>
                  <td><code className="docs-inline-code">Idempotency-Key</code></td>
                  <td>Recommended</td>
                  <td>
                    Unique key per ERP document or batch (also accepts{" "}
                    <code className="docs-inline-code">X-Idempotency-Key</code>). Re-sending the
                    same key deduplicates cleanly without creating duplicate orders or bookings.
                  </td>
                </tr>
                <tr>
                  <td><code className="docs-inline-code">Content-Type</code></td>
                  <td>Auto-detected</td>
                  <td>
                    Accepts <code className="docs-inline-code">application/json</code>,{" "}
                    <code className="docs-inline-code">application/x-ndjson</code>,{" "}
                    <code className="docs-inline-code">text/csv</code>, or{" "}
                    <code className="docs-inline-code">text/plain</code> (EDI X12 or SQL INSERT
                    dumps). Maximum payload size is <strong>2 MB</strong> (up to 250 records per
                    request).
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="docs-callout">
            <Lock size={15} strokeWidth={1.9} aria-hidden="true" />
            <div>
              <strong>Security note:</strong> Keep connector API keys in your ERP middleware or
              backend secrets manager. Never embed <code className="docs-inline-code">ct_live_</code>{" "}
              keys in public browser bundles. Pausing a connector in{" "}
              <Link href="/integrations" className="docs-inline-link">Integrations</Link>{" "}
              immediately returns <code className="docs-inline-code">403 Forbidden</code> until
              resumed.
            </div>
          </div>
        </section>

        {/* 3. Endpoint Directory */}
        <section id="endpoints" className="docs-section">
          <div className="docs-section-head">
            <span className="docs-section-num">03</span>
            <div>
              <h2>API endpoint directory</h2>
              <p>
                Machine-to-machine integration endpoints under <code className="docs-inline-code">/api/v1</code>{" "}
                plus operator automation routes for schema previews, live syncs, and autonomous
                takeover sweeps.
              </p>
            </div>
          </div>

          <div className="docs-endpoint-list">
            {filteredEndpoints.length === 0 ? (
              <div className="docs-empty-filter">
                No endpoints match &ldquo;{filterQuery}&rdquo;.
              </div>
            ) : (
              filteredEndpoints.map((ep) => (
                <div key={ep.id} className="docs-endpoint-card">
                  <div className="docs-endpoint-head">
                    <div className="docs-endpoint-path-row">
                      <MethodTag method={ep.method} />
                      <code className="docs-endpoint-path">{ep.path}</code>
                    </div>
                    <div className="docs-endpoint-meta">
                      <span className="docs-meta-item">{ep.auth}</span>
                      <CopyButton value={`${origin}${ep.path}`} label="Copy path" />
                    </div>
                  </div>
                  <h3>{ep.title}</h3>
                  <p>{ep.summary}</p>
                  <div className="docs-endpoint-foot">
                    <Server size={12} strokeWidth={1.9} aria-hidden="true" />
                    <span>{ep.rateOrLimit}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* 4. Universal Ingest & ERP/TMS Recipes */}
        <section id="ingest-recipes" className="docs-section">
          <div className="docs-section-head">
            <span className="docs-section-num">04</span>
            <div>
              <h2>Universal ingest &amp; ERP/TMS recipes</h2>
              <p>
                <MethodTag method="POST" />{" "}
                <code className="docs-inline-code">/api/v1/ingest</code> accepts single records,
                arrays, whole-database JSON exports, CSV files, SQL INSERT dumps, and raw EDI X12
                envelopes. Choose a scenario below to view production-ready code in your selected
                language.
              </p>
            </div>
          </div>

          <div className="docs-recipe-tabs" role="tablist" aria-label="ERP and TMS recipes">
            {INTEGRATION_RECIPES.map((r) => (
              <button
                key={r.id}
                type="button"
                role="tab"
                aria-selected={activeRecipe === r.id}
                className={`docs-recipe-tab ${activeRecipe === r.id ? "is-active" : ""}`}
                onClick={() => {
                  setActiveRecipe(r.id);
                  setRecipeView("request");
                }}
              >
                <span className="docs-recipe-tab-title">{r.label}</span>
                <span className="docs-recipe-tab-sub">{r.systems}</span>
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={`${activeRecipe}-${lang}-${recipeView}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14 }}
              className="docs-code-panel"
            >
              <div className="docs-code-panel-intro">
                <p>{recipe.summary}</p>
                <div className="docs-code-panel-meta">
                  <span>Content-Type: <code className="docs-inline-code">{recipe.contentType}</code></span>
                </div>
              </div>

              <div className="docs-code-bar">
                <div className="docs-subtabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={recipeView === "request"}
                    className={`docs-subtab ${recipeView === "request" ? "is-active" : ""}`}
                    onClick={() => setRecipeView("request")}
                  >
                    <Code2 size={13} strokeWidth={1.9} aria-hidden="true" />
                    <span>
                      Request ({CODE_LANGS.find((l) => l.id === lang)?.label})
                    </span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={recipeView === "response"}
                    className={`docs-subtab ${recipeView === "response" ? "is-active" : ""}`}
                    onClick={() => setRecipeView("response")}
                  >
                    <FileCode2 size={13} strokeWidth={1.9} aria-hidden="true" />
                    <span>201 Created Response</span>
                  </button>
                </div>

                <CopyButton
                  value={recipeView === "request" ? ingestSnippet : recipe.responseSample}
                  label={recipeView === "request" ? "Copy code" : "Copy JSON"}
                />
              </div>

              <pre className="docs-pre">
                <code>{recipeView === "request" ? ingestSnippet : recipe.responseSample}</code>
              </pre>
            </motion.div>
          </AnimatePresence>
        </section>

        {/* 5. Canonical Entities */}
        <section id="canonical-entities" className="docs-section">
          <div className="docs-section-head">
            <span className="docs-section-num">05</span>
            <div>
              <h2>Canonical entities &amp; autonomous takeover order</h2>
              <p>
                When a multi-table JSON object or SQL dump arrives, Control Tower automatically
                sorts records into dependency order—loading facilities, carriers, fleet, drivers,
                and customers before planning and booking orders.
              </p>
            </div>
          </div>

          <div className="docs-table-wrap">
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Canonical Entity</th>
                  <th>Control Tower Domain</th>
                  <th>Common ERP / TMS Sources</th>
                  <th>Autonomous Platform Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntities.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="docs-empty-cell">
                      No canonical entities match &ldquo;{filterQuery}&rdquo;.
                    </td>
                  </tr>
                ) : (
                  filteredEntities.map((row) => (
                    <tr key={row.entity}>
                      <td>
                        <code className="docs-inline-code">{row.entity}</code>
                      </td>
                      <td><strong>{row.tableOrDomain}</strong></td>
                      <td>{row.erpTmsExamples}</td>
                      <td>{row.autonomousAction}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* 6. Query Shipments API */}
        <section id="shipments-query" className="docs-section">
          <div className="docs-section-head">
            <span className="docs-section-num">06</span>
            <div>
              <h2>Query shipments for ERP reconciliation</h2>
              <p>
                Use <MethodTag method="GET" />{" "}
                <code className="docs-inline-code">/api/v1/shipments</code> to pull current
                dispatch status, assigned carriers, cargo details, and route plans back into your
                ERP or customer portal.
              </p>
            </div>
          </div>

          <div className="docs-table-wrap">
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Query Parameter</th>
                  <th>Type</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><code className="docs-inline-code">reference</code></td>
                  <td>string (optional)</td>
                  <td>
                    Exact Control Tower shipment reference (e.g., <code className="docs-inline-code">LG-90412</code>).
                    Returns up to 1 matching shipment.
                  </td>
                </tr>
                <tr>
                  <td><code className="docs-inline-code">state</code></td>
                  <td>string (optional)</td>
                  <td>
                    Lifecycle filter such as <code className="docs-inline-code">BOOKED</code>,{" "}
                    <code className="docs-inline-code">AWAITING_APPROVAL</code>,{" "}
                    <code className="docs-inline-code">IN_TRANSIT</code>,{" "}
                    <code className="docs-inline-code">DELAYED</code>, or{" "}
                    <code className="docs-inline-code">DELIVERED</code>. Returns up to 100 latest
                    matching shipments.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="docs-code-panel">
            <div className="docs-code-bar">
              <div className="docs-subtabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={shipmentsView === "request"}
                  className={`docs-subtab ${shipmentsView === "request" ? "is-active" : ""}`}
                  onClick={() => setShipmentsView("request")}
                >
                  <Code2 size={13} strokeWidth={1.9} aria-hidden="true" />
                  <span>Request ({CODE_LANGS.find((l) => l.id === lang)?.label})</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={shipmentsView === "response"}
                  className={`docs-subtab ${shipmentsView === "response" ? "is-active" : ""}`}
                  onClick={() => setShipmentsView("response")}
                >
                  <FileCode2 size={13} strokeWidth={1.9} aria-hidden="true" />
                  <span>200 OK Response</span>
                </button>
              </div>
              <CopyButton
                value={shipmentsView === "request" ? shipmentsSnippet : SHIPMENTS_RESPONSE_SAMPLE}
                label={shipmentsView === "request" ? "Copy code" : "Copy JSON"}
              />
            </div>

            <pre className="docs-pre">
              <code>
                {shipmentsView === "request" ? shipmentsSnippet : SHIPMENTS_RESPONSE_SAMPLE}
              </code>
            </pre>
          </div>
        </section>

        {/* 7. Outbound Webhooks & HMAC Signature Verification */}
        <section id="webhooks" className="docs-section">
          <div className="docs-section-head">
            <span className="docs-section-num">07</span>
            <div>
              <h2>Outbound webhooks &amp; signature verification</h2>
              <p>
                Whenever Control Tower books a shipment, queues a spend approval, or syncs master
                data, it sends an HTTPS <code className="docs-inline-code">POST</code> callback to
                your connector&apos;s configured webhook URL signed with your{" "}
                <code className="docs-inline-code">whsec_…</code> secret.
              </p>
            </div>
          </div>

          <div className="docs-webhook-grid">
            <div className="docs-card">
              <div className="docs-card-head">
                <ShieldCheck size={15} strokeWidth={1.9} aria-hidden="true" />
                <h3>Signed callback headers</h3>
              </div>
              <dl className="docs-dl">
                <div>
                  <dt><code className="docs-inline-code">X-ControlTower-Signature</code></dt>
                  <dd>
                    <code className="docs-inline-code">sha256=&lt;hex&gt;</code> — HMAC-SHA256
                    digest computed over the exact raw UTF-8 request body using your connector&apos;s
                    webhook secret.
                  </dd>
                </div>
                <div>
                  <dt><code className="docs-inline-code">X-ControlTower-Event</code></dt>
                  <dd>Event name such as <code className="docs-inline-code">shipment.booked</code> or <code className="docs-inline-code">approval.requested</code>.</dd>
                </div>
                <div>
                  <dt><code className="docs-inline-code">X-ControlTower-Connector</code></dt>
                  <dd>Connector ID originating the event (e.g., <code className="docs-inline-code">conn_sap_prod_01</code>).</dd>
                </div>
                <div>
                  <dt><code className="docs-inline-code">User-Agent</code></dt>
                  <dd><code className="docs-inline-code">ControlTower-Webhook/1.0</code> · 6-second timeout · redirects disabled.</dd>
                </div>
              </dl>
            </div>

            <div className="docs-card">
              <div className="docs-card-head">
                <Layers size={15} strokeWidth={1.9} aria-hidden="true" />
                <h3>Callback JSON envelope</h3>
                <CopyButton value={WEBHOOK_ENVELOPE_SAMPLE} label="Copy JSON" />
              </div>
              <pre className="docs-pre docs-pre-compact">
                <code>{WEBHOOK_ENVELOPE_SAMPLE}</code>
              </pre>
            </div>
          </div>

          <div className="docs-code-panel">
            <div className="docs-code-bar">
              <div className="docs-subtabs" role="tablist" aria-label="Webhook verification language">
                {WEBHOOK_LANGS.map((wl) => (
                  <button
                    key={wl.id}
                    type="button"
                    role="tab"
                    aria-selected={webhookLang === wl.id}
                    className={`docs-subtab ${webhookLang === wl.id ? "is-active" : ""}`}
                    onClick={() => setWebhookLang(wl.id)}
                  >
                    <ShieldCheck size={13} strokeWidth={1.9} aria-hidden="true" />
                    <span>{wl.label}</span>
                  </button>
                ))}
              </div>
              <CopyButton value={webhookVerifySnippet} label="Copy verifier" />
            </div>

            <pre className="docs-pre">
              <code>{webhookVerifySnippet}</code>
            </pre>
          </div>

          <div className="docs-table-wrap">
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Event Name</th>
                  <th>When It Fires</th>
                  <th>Recommended ERP / TMS Handler</th>
                </tr>
              </thead>
              <tbody>
                {filteredEvents.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="docs-empty-cell">
                      No webhook events match &ldquo;{filterQuery}&rdquo;.
                    </td>
                  </tr>
                ) : (
                  filteredEvents.map((ev) => (
                    <tr key={ev.event}>
                      <td><code className="docs-inline-code">{ev.event}</code></td>
                      <td>{ev.trigger}</td>
                      <td>{ev.typicalErpAction}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* 8. Field Mapping Aliases & HTTP Error Reference */}
        <section id="field-mapping" className="docs-section">
          <div className="docs-section-head">
            <span className="docs-section-num">08</span>
            <div>
              <h2>Zero-config field aliases &amp; HTTP status reference</h2>
              <p>
                Control Tower recognizes standard ERP, TMS, EDI, and e-commerce column names out of
                the box. For proprietary column names, attach a custom{" "}
                <code className="docs-inline-code">fieldMapping</code> dictionary on the connector
                or test it first with <code className="docs-inline-code">POST /api/integrations/preview-map</code>.
              </p>
            </div>
          </div>

          <div className="docs-table-wrap">
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Canonical Field</th>
                  <th>Automatically Recognized Aliases</th>
                  <th>Normalization Notes</th>
                </tr>
              </thead>
              <tbody>
                {filteredAliases.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="docs-empty-cell">
                      No field aliases match &ldquo;{filterQuery}&rdquo;.
                    </td>
                  </tr>
                ) : (
                  filteredAliases.map((row) => (
                    <tr key={row.canonicalField}>
                      <td><code className="docs-inline-code">{row.canonicalField}</code></td>
                      <td className="docs-mono-cell">{row.acceptedAliases}</td>
                      <td>{row.notes}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="docs-subhead-row">
            <h3>HTTP status codes &amp; troubleshooting</h3>
          </div>

          <div className="docs-table-wrap">
            <table className="docs-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Meaning</th>
                  <th>Recommended Handling</th>
                </tr>
              </thead>
              <tbody>
                {HTTP_STATUS_MATRIX.map((row) => (
                  <tr key={row.status}>
                    <td><code className="docs-inline-code">{row.status}</code></td>
                    <td>{row.meaning}</td>
                    <td>{row.remediation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="docs-footer-cta">
            <div className="docs-footer-cta-copy">
              <Plug size={18} strokeWidth={1.8} aria-hidden="true" />
              <div>
                <strong>Ready to test live payloads against your workspace?</strong>
                <p>
                  Provision a connector, test PostgreSQL or Pull-API connections, or drop in a
                  sample JSON, CSV, SQL, or EDI X12 export inside the Integrations hub.
                </p>
              </div>
            </div>
            <Link href="/integrations" className="btn btn-primary">
              <span>Go to Integrations Hub</span>
              <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
