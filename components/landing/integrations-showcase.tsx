"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, CheckCircle2, Database, FileSpreadsheet, Radio, Webhook } from "lucide-react";

type IntegrationCategoryId = "erp" | "edi" | "telematics" | "channels";
type SignalStage = "inbound" | "outcome";

interface ConnectorItem {
  name: string;
  protocol: string;
}

interface SignalField {
  label: string;
  value: string;
  highlight?: boolean;
}

interface IntegrationEcosystem {
  id: IntegrationCategoryId;
  label: string;
  headline: string;
  summary: string;
  connectors: ConnectorItem[];
  guarantee: string;
  sourceSubtitle: string;
  pipelineSource: string;
  pipelineAction: string;
  inboundSummary: string;
  outcomeSummary: string;
  inboundFields: SignalField[];
  outcomeFields: SignalField[];
}

const ECOSYSTEMS: IntegrationEcosystem[] = [
  {
    id: "erp",
    label: "ERP & Order Feeds",
    headline: "Turn raw ERP purchase orders into scored lanes automatically.",
    summary:
      "Wire in SAP S/4HANA, NetSuite, Shopify, or internal databases with scoped API keys. Every order normalizes into a validated corridor with built-in idempotency—zero CSV cleanup, zero duplicate tenders.",
    connectors: [
      { name: "SAP S/4HANA", protocol: "REST / OData" },
      { name: "Oracle NetSuite", protocol: "Webhook Feed" },
      { name: "Shopify Plus", protocol: "Order Stream" },
      { name: "Postgres / Custom", protocol: "HMAC API Key" },
    ],
    guarantee: "Idempotency keys stop duplicate bookings · Dead-letter replay built in",
    sourceSubtitle: "SAP S/4HANA · Live Order Stream",
    pipelineSource: "ERP Purchase Order",
    pipelineAction: "Corridor Planned",
    inboundSummary: "Purchase order checked against tenant schema and deduplicated automatically.",
    outcomeSummary: "Corridor planned and cleared under versioned policy rules.",
    inboundFields: [
      { label: "Source System", value: "SAP S/4HANA · Order Sync" },
      { label: "Order Reference", value: "PO-9941-EU" },
      { label: "Origin & Destination", value: "Rotterdam (NL) → Munich (DE)" },
      { label: "Cargo Profile", value: "18 pallets · 9,420 kg · 4.0°C controlled" },
      { label: "SLA Deadline", value: "Nov 27, 2026 · 16:00 UTC" },
    ],
    outcomeFields: [
      { label: "Shipment Record", value: "CT-9941 · Status: Planned", highlight: true },
      { label: "Verified Corridor", value: "Rotterdam → Duisburg Rail → Munich" },
      { label: "Top-Ranked Carrier", value: "Nordic Intermodal Express (93.4 / 100)" },
      { label: "Contracted Rate", value: "$2,190 · Within $4,500 policy cap" },
      { label: "Governance Check", value: "Auto-approved under Policy v4.2", highlight: true },
    ],
  },
  {
    id: "edi",
    label: "EDI & Rate Cards",
    headline: "Ingest EDI X12 tenders and carrier rate sheets without writing parsers.",
    summary:
      "Drop in carrier CSVs or stream EDI 204 tenders and 214 status updates out of the box. Control Tower pulls lane rates, fuel surcharges, and equipment rules with dry-run validation before you go live.",
    connectors: [
      { name: "EDI X12 204", protocol: "Load Tender" },
      { name: "EDI X12 214", protocol: "Shipment Status" },
      { name: "Carrier Rate CSV", protocol: "Dry-Run Parser" },
      { name: "AS2 / SFTP Drop", protocol: "Scheduled Sync" },
    ],
    guarantee: "Schema-checked rate ingestion · Preview every parse before going live",
    sourceSubtitle: "EDI X12 204 · Automated Load Tender",
    pipelineSource: "X12 204 Tender",
    pipelineAction: "Rate Card Matched",
    inboundSummary: "X12 segment structure verified with zero syntax errors or missing stops.",
    outcomeSummary: "Contracted rate card matched and tender dispatched to carrier.",
    inboundFields: [
      { label: "Document Type", value: "EDI X12 204 · Motor Carrier Tender" },
      { label: "Shipment Reference", value: "CT-9941 · Transaction #0001" },
      { label: "Shipper Facility", value: "Rotterdam Maasvlakte Hub" },
      { label: "Consignee Facility", value: "Munich North Cold Storage" },
      { label: "Billable Weight", value: "9,420 kg · Prepaid Freight" },
    ],
    outcomeFields: [
      { label: "Matched Rate Table", value: "NORD_EU_REEFER_2026", highlight: true },
      { label: "Computed Contract Quote", value: "$2,190 all-in (incl. fuel surcharge)" },
      { label: "Validation Status", value: "Passed dry-run schema check" },
      { label: "Dispatched Carrier", value: "Nordic Intermodal Express" },
      { label: "Dead-Letter Queue", value: "0 exceptions · Clean handoff", highlight: true },
    ],
  },
  {
    id: "telematics",
    label: "Telematics & Weather",
    headline: "Spot storm blocks and port queues before a driver hits the bottleneck.",
    summary:
      "Pair live Samsara GPS and reefer probes with Google Routes and Weather corridor scans. The moment congestion or severe weather threatens your SLA, backup carriers are already scored and ready.",
    connectors: [
      { name: "Samsara Fleet", protocol: "GPS Heartbeat" },
      { name: "ELD Telemetry", protocol: "Reefer & Seal" },
      { name: "Google Routes", protocol: "Traffic Matrix" },
      { name: "Weather Corridors", protocol: "Hazard Polygons" },
    ],
    guarantee: "Continuous ETA recalculation · Backup plans ready hours before cutoff",
    sourceSubtitle: "Samsara Fleet · GPS & Reefer Stream",
    pipelineSource: "Vehicle Beacon",
    pipelineAction: "Detour Verified",
    inboundSummary: "Beacon telemetry correlated with regional weather hazard along the A3 corridor.",
    outcomeSummary: "Bypass corridor verified within budget and customer notifications sent.",
    inboundFields: [
      { label: "Vehicle Unit", value: "TRK-19-EU · Linked to CT-9941" },
      { label: "Last Coordinates", value: "51.4344° N, 6.7623° E · 78 km/h" },
      { label: "Reefer Probe", value: "4.1°C · Door seal closed" },
      { label: "Weather Advisory", value: "Moderate wind alert · Ruhr Valley A3" },
      { label: "SLA Impact", value: "+95 min congestion delay projected", highlight: true },
    ],
    outcomeFields: [
      { label: "Recommended Bypass", value: "Duisburg Electric Rail Shuttle", highlight: true },
      { label: "Net Transit Impact", value: "Recovers 3.2 hours · Meets SLA window" },
      { label: "Incremental Cost", value: "+$240 · Under $500 recovery limit" },
      { label: "Policy Verdict", value: "Auto-rerouted and confirmed", highlight: true },
      { label: "Alerts Delivered", value: "Consignee webhook & Operations Telegram" },
    ],
  },
  {
    id: "channels",
    label: "Dispatch Channels",
    headline: "Put live shipment control inside the chat apps drivers already open.",
    summary:
      "Connect Telegram or WhatsApp so drivers report dock delays in two taps and buyers pull verified ETAs—eliminating dozens of daily status phone calls.",
    connectors: [
      { name: "Telegram Bot API", protocol: "Driver Commands" },
      { name: "WhatsApp Cloud", protocol: "Customer ETAs" },
      { name: "Signed Webhooks", protocol: "HMAC-SHA256" },
      { name: "Email Alerts", protocol: "SLA Escalation" },
    ],
    guarantee: "Tenant-scoped bot auth · Every ETA grounded in live shipment records",
    sourceSubtitle: "Telegram Driver Bot · Verified Session",
    pipelineSource: "Driver Message",
    pipelineAction: "ETA Broadcast",
    inboundSummary: "Authenticated driver report parsed and attached to active shipment timeline.",
    outcomeSummary: "Updated ETA confirmed to driver and synced to customer status channel.",
    inboundFields: [
      { label: "Channel & Sender", value: "Telegram · Verified Carrier Driver" },
      { label: "Shipment Reference", value: "CT-9941" },
      { label: "Reported Event", value: "Gate congestion · 45 min queue" },
      { label: "Location Context", value: "Duisburg North Terminal Gate 4" },
      { label: "Session Verification", value: "Tenant-scoped driver key confirmed" },
    ],
    outcomeFields: [
      { label: "Timeline Logged", value: "Gate congestion exception recorded", highlight: true },
      { label: "Updated Arrival ETA", value: "Nov 27, 2026 · 14:55 UTC" },
      { label: "SLA Buffer Remaining", value: "65 minutes ahead of cutoff", highlight: true },
      { label: "Consignee Sync", value: "WhatsApp ETA update delivered" },
      { label: "Human Escalation", value: "Not required · Within SLA buffer" },
    ],
  },
];

function EcosystemIcon({ id }: { id: IntegrationCategoryId }) {
  if (id === "erp") return <Database size={16} aria-hidden="true" />;
  if (id === "edi") return <FileSpreadsheet size={16} aria-hidden="true" />;
  if (id === "telematics") return <Radio size={16} aria-hidden="true" />;
  return <Webhook size={16} aria-hidden="true" />;
}

export function IntegrationsShowcase({ isAuthenticated }: { isAuthenticated: boolean }) {
  const [activeId, setActiveId] = useState<IntegrationCategoryId>("erp");
  const [signalStage, setSignalStage] = useState<SignalStage>("inbound");

  const active = ECOSYSTEMS.find((item) => item.id === activeId) ?? ECOSYSTEMS[0];
  const fields = signalStage === "inbound" ? active.inboundFields : active.outcomeFields;
  const stageSummary = signalStage === "inbound" ? active.inboundSummary : active.outcomeSummary;

  return (
    <div className="lp-integ-shell">
      {/* Category Switcher Tabs with hover scale/opacity and smooth active fill */}
      <div className="lp-integ-tabs" role="tablist" aria-label="Integration system categories">
        {ECOSYSTEMS.map((eco) => {
          const isActive = eco.id === active.id;
          return (
            <motion.button
              key={eco.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`lp-integ-tab${isActive ? " is-active" : ""}`}
              initial={false}
              animate={{ opacity: isActive ? 1 : 0.88 }}
              whileHover={{ scale: 1.025, opacity: 1 }}
              whileTap={{ scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              onClick={() => setActiveId(eco.id)}
            >
              <EcosystemIcon id={eco.id} />
              <span>{eco.label}</span>
            </motion.button>
          );
        })}
      </div>

      {/* Split Editorial Copy + Human-Readable Signal Flow Preview */}
      <div className="lp-integ-grid">
        <AnimatePresence mode="wait">
          <motion.div
            key={active.id}
            className="lp-integ-copy"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          >
            <h3 className="lp-integ-heading">{active.headline}</h3>
            <p className="lp-integ-summary">{active.summary}</p>

            {/* 2x2 Tactile Connector Matrix */}
            <div className="lp-connector-grid">
              {active.connectors.map((conn) => (
                <div key={conn.name} className="lp-connector-tile">
                  <strong>{conn.name}</strong>
                  <span>{conn.protocol}</span>
                </div>
              ))}
            </div>

            <div className="lp-integ-guarantee">
              <span className="lp-integ-label">Operational guarantee</span>
              <p>{active.guarantee}</p>
            </div>

            <div className="lp-integ-actions">
              <Link
                href={isAuthenticated ? "/integrations" : "/signup"}
                className="lp-btn lp-btn-primary"
              >
                <span>{isAuthenticated ? "Open Integrations Hub" : "Connect Your First Feed"}</span>
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
              <Link
                href={isAuthenticated ? "/integrations/docs" : "/login"}
                className="lp-link-quiet"
              >
                <span>{isAuthenticated ? "Read API Documentation" : "Sign in for API keys"}</span>
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Clean Dark Architectural Signal Preview (no raw JSON dump) */}
        <div className="lp-integ-console">
          {/* 3-Step Visual Pipeline Bar */}
          <div className="lp-integ-flow-bar" aria-hidden="true">
            <div className={`lp-integ-flow-step${signalStage === "inbound" ? " is-active" : ""}`}>
              <span>01 Ingest</span>
              <strong>{active.pipelineSource}</strong>
            </div>
            <div className="lp-integ-flow-link">
              <span className="lp-integ-flow-pulse" />
            </div>
            <div className="lp-integ-flow-step">
              <span>02 Validate</span>
              <strong>Idempotent Schema</strong>
            </div>
            <div className="lp-integ-flow-link">
              <span className="lp-integ-flow-pulse is-delayed" />
            </div>
            <div className={`lp-integ-flow-step${signalStage === "outcome" ? " is-active" : ""}`}>
              <span>03 Output</span>
              <strong>{active.pipelineAction}</strong>
            </div>
          </div>

          <div className="lp-integ-console-bar">
            <span className="lp-integ-source-title">{active.sourceSubtitle}</span>

            <div className="lp-seg-group" role="group" aria-label="Signal inspection stage">
              <button
                type="button"
                className={`lp-seg-btn${signalStage === "inbound" ? " is-active" : ""}`}
                onClick={() => setSignalStage("inbound")}
              >
                Inbound Signal
              </button>
              <button
                type="button"
                className={`lp-seg-btn${signalStage === "outcome" ? " is-active" : ""}`}
                onClick={() => setSignalStage("outcome")}
              >
                Planned Outcome
              </button>
            </div>
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={`${active.id}-${signalStage}`}
              className="lp-integ-ledger"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            >
              <dl className="lp-integ-ledger-rows">
                {fields.map((field) => (
                  <div key={field.label} className="lp-integ-ledger-row">
                    <dt>{field.label}</dt>
                    <dd className={field.highlight ? "is-highlight" : undefined}>{field.value}</dd>
                  </div>
                ))}
              </dl>

              <div className="lp-integ-ledger-verdict">
                <CheckCircle2 size={15} aria-hidden="true" />
                <span>{stageSummary}</span>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
