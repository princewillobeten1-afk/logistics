"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CloudRain,
  MessageSquare,
  Route,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

type WorkflowTabId = "corridor" | "scoring" | "recovery" | "dispatch";
type CorridorModeId = "intermodal" | "air" | "ocean";
type WeightPresetId = "balanced" | "cost" | "speed" | "reliability";
type ChannelId = "telegram" | "whatsapp" | "console";

interface WorkflowTabMeta {
  id: WorkflowTabId;
  index: string;
  label: string;
}

const WORKFLOW_TABS: WorkflowTabMeta[] = [
  { id: "corridor", index: "01", label: "Corridor Solver" },
  { id: "scoring", index: "02", label: "Carrier Scoring" },
  { id: "recovery", index: "03", label: "Policy Recovery" },
  { id: "dispatch", index: "04", label: "Channel Dispatch" },
];

interface CorridorWaypoint {
  code: string;
  name: string;
  coords: string;
  x: number;
  y: number;
}

const CORRIDOR_MODES: Record<
  CorridorModeId,
  {
    label: string;
    lane: string;
    origin: CorridorWaypoint;
    hubSafe: CorridorWaypoint;
    hubDirect: CorridorWaypoint;
    destination: CorridorWaypoint;
    safePath: string;
    directPath: string;
    stormCenter: { x: number; y: number; label: string; copyName: string };
    baseHours: number;
    weatherDeltaHours: number;
    distanceKm: number;
    co2Kg: number;
    costUsd: number;
    conveyance: string;
  }
> = {
  intermodal: {
    label: "Road + Rail",
    lane: "RTM-DE-408",
    origin: { code: "RTM", name: "Rotterdam", coords: "51.92°N", x: 64, y: 160 },
    hubSafe: { code: "DUI", name: "Duisburg Rail", coords: "Bypass N", x: 258, y: 76 },
    hubDirect: { code: "COL", name: "Cologne A3", coords: "Storm Risk", x: 266, y: 168 },
    destination: { code: "MUC", name: "Munich Hub", coords: "48.13°N", x: 486, y: 120 },
    safePath: "M 64 160 C 128 110, 184 72, 258 76 C 338 80, 412 100, 486 120",
    directPath: "M 64 160 C 138 166, 200 172, 266 168 C 344 164, 418 142, 486 120",
    stormCenter: {
      x: 274,
      y: 166,
      label: "Ruhr Wind Advisory",
      copyName: "Ruhr wind advisory",
    },
    baseHours: 18,
    weatherDeltaHours: 2,
    distanceKm: 842,
    co2Kg: 318,
    costUsd: 2140,
    conveyance: "Electric Rail Shuttle + Regional Tractor",
  },
  air: {
    label: "Priority Air",
    lane: "AMS-MUC-219",
    origin: { code: "AMS", name: "Schiphol", coords: "52.31°N", x: 68, y: 148 },
    hubSafe: { code: "FRA", name: "Frankfurt Air", coords: "Clear Vector", x: 274, y: 74 },
    hubDirect: { code: "STR", name: "Stuttgart Cell", coords: "Turbulence", x: 272, y: 172 },
    destination: { code: "MUC", name: "Munich Cargo", coords: "48.35°N", x: 488, y: 126 },
    safePath: "M 68 148 C 136 96, 206 70, 274 74 C 350 78, 422 104, 488 126",
    directPath: "M 68 148 C 142 170, 206 178, 272 172 C 348 166, 422 146, 488 126",
    stormCenter: {
      x: 276,
      y: 170,
      label: "Convective Cell",
      copyName: "Stuttgart convective cell",
    },
    baseHours: 5,
    weatherDeltaHours: 1,
    distanceKm: 678,
    co2Kg: 1290,
    costUsd: 4680,
    conveyance: "ULD Widebody Freighter + Final-Mile Van",
  },
  ocean: {
    label: "Short-Sea + Road",
    lane: "ANT-HAM-772",
    origin: { code: "ANT", name: "Antwerp", coords: "51.26°N", x: 60, y: 172 },
    hubSafe: { code: "HAM", name: "Hamburg Quay", coords: "Elbe Clear", x: 266, y: 74 },
    hubDirect: { code: "BRE", name: "North Sea Swell", coords: "+4h Gale", x: 264, y: 168 },
    destination: { code: "BER", name: "Berlin Depot", coords: "52.52°N", x: 488, y: 118 },
    safePath: "M 60 172 C 122 116, 192 72, 266 74 C 344 76, 418 98, 488 118",
    directPath: "M 60 172 C 136 174, 198 174, 264 168 C 344 160, 418 140, 488 118",
    stormCenter: {
      x: 268,
      y: 166,
      label: "Coastal Gale Zone",
      copyName: "North Sea coastal gale zone",
    },
    baseHours: 42,
    weatherDeltaHours: 4,
    distanceKm: 915,
    co2Kg: 194,
    costUsd: 1620,
    conveyance: "40ft High-Cube Feeder + Drayage",
  },
};

interface CarrierBid {
  id: string;
  name: string;
  contract: string;
  quoteUsd: number;
  transitHours: number;
  onTimePct: number;
  carbonScore: number;
  capacityScore: number;
  complianceScore: number;
}

const CARRIER_BIDS: CarrierBid[] = [
  {
    id: "nordic-line",
    name: "Nordic Intermodal Express",
    contract: "Tier-1 Contract · EDI 204",
    quoteUsd: 2190,
    transitHours: 19,
    onTimePct: 98.4,
    carbonScore: 94,
    capacityScore: 92,
    complianceScore: 99,
  },
  {
    id: "euro-haul",
    name: "EuroFreight Direct",
    contract: "Spot Rate · REST Webhook",
    quoteUsd: 1980,
    transitHours: 26,
    onTimePct: 91.2,
    carbonScore: 76,
    capacityScore: 84,
    complianceScore: 93,
  },
  {
    id: "alpine-air",
    name: "Alpine Priority Cargo",
    contract: "Expedited SLA · API Tender",
    quoteUsd: 3340,
    transitHours: 11,
    onTimePct: 99.3,
    carbonScore: 62,
    capacityScore: 96,
    complianceScore: 99,
  },
];

const WEIGHT_PRESETS: Record<
  WeightPresetId,
  {
    label: string;
    weights: { price: number; speed: number; reliability: number; carbon: number; capacity: number; compliance: number };
  }
> = {
  balanced: {
    label: "Balanced SLA",
    weights: { price: 0.25, speed: 0.2, reliability: 0.25, carbon: 0.1, capacity: 0.1, compliance: 0.1 },
  },
  cost: {
    label: "Lowest Cost",
    weights: { price: 0.5, speed: 0.1, reliability: 0.15, carbon: 0.05, capacity: 0.1, compliance: 0.1 },
  },
  speed: {
    label: "Fastest Transit",
    weights: { price: 0.1, speed: 0.48, reliability: 0.2, carbon: 0.04, capacity: 0.1, compliance: 0.08 },
  },
  reliability: {
    label: "Max On-Time",
    weights: { price: 0.12, speed: 0.15, reliability: 0.45, carbon: 0.05, capacity: 0.13, compliance: 0.1 },
  },
};

const CHANNEL_TRANSCRIPTS: Record<
  ChannelId,
  {
    label: string;
    handle: string;
    inboundLabel: string;
    prompts: Array<{
      id: string;
      buttonLabel: string;
      userMessage: string;
      reply: string;
      auditAction: string;
    }>;
  }
> = {
  telegram: {
    label: "Telegram Bot",
    handle: "@ControlTowerOpsBot",
    inboundLabel: "Driver & Shipper Command",
    prompts: [
      {
        id: "eta",
        buttonLabel: "Check live ETA",
        userMessage: "/eta CT-8841",
        reply:
          "Shipment CT-8841 is 118 km outside Munich North Hub on A9. Current ETA 14:20 CET (12m ahead of SLA window). Seal & temperature telemetry nominal (4.1°C).",
        auditAction: "Read-only live state lookup · 48ms · Tenant verified",
      },
      {
        id: "delay",
        buttonLabel: "Report port gate delay",
        userMessage: "/delay CT-8841 port gate queue 95m",
        reply:
          "Logged 95m delay on CT-8841. Policy gate verified reserve slot at Dock B4 and updated consignee ETA to 15:40 CET with zero penalty.",
        auditAction: "Shipment event persisted · Consignee notified via webhook",
      },
    ],
  },
  whatsapp: {
    label: "WhatsApp Dispatch",
    handle: "Verified Business Line",
    inboundLabel: "Customer Service Thread",
    prompts: [
      {
        id: "eta",
        buttonLabel: "Verify delivery window",
        userMessage: "Can pallet order PO-4419 arrive before 17:00 today?",
        reply:
          "Confirmed. Order PO-4419 cleared customs at 09:14 and is assigned to Tractor #19 (ETA 15:35). Receiving dock confirmation attached.",
        auditAction: "State-backed customer reply · Zero unverified fields",
      },
      {
        id: "delay",
        buttonLabel: "Request dock redirect",
        userMessage: "Redirect PO-4419 from Dock East to Cold Storage 2.",
        reply:
          "Dock update accepted within policy bounds (+0 USD delta). Updated waybill sent to driver handheld and WMS receiving queue.",
        auditAction: "Dock override committed · Policy v4.2 compliant",
      },
    ],
  },
  console: {
    label: "Ops Webhook",
    handle: "POST /api/webhooks/dispatch",
    inboundLabel: "ERP Autonomous Trigger",
    prompts: [
      {
        id: "eta",
        buttonLabel: "Verify tender award",
        userMessage: "event: tender.evaluated · ref: CT-8841 · delta: +$210",
        reply:
          "Tender CT-8841 auto-awarded to Nordic Intermodal Express (score 93.4/100). Spend cap headroom remaining: $2,810.",
        auditAction: "Signed HMAC webhook dispatched · Idempotency key stored",
      },
      {
        id: "delay",
        buttonLabel: "Trigger spend escalation",
        userMessage: "event: sla.risk · ref: CT-8841 · storm_alert: SEVERE",
        reply:
          "Expedited reroute quote ($4,890) exceeds $4,500 spend cap. Tender paused automatically and routed to Shift Supervisor queue.",
        auditAction: "Human approval gate engaged · Zero unapproved spend",
      },
    ],
  },
};

export function HeroWorkflowShowcase() {
  const [activeTab, setActiveTab] = useState<WorkflowTabId>("corridor");
  const [corridorMode, setCorridorMode] = useState<CorridorModeId>("intermodal");
  const [weatherRouting, setWeatherRouting] = useState<boolean>(true);
  const [weightPreset, setWeightPreset] = useState<WeightPresetId>("balanced");
  const [disruptionActive, setDisruptionActive] = useState<boolean>(true);
  const [spendCap, setSpendCap] = useState<number>(4800);
  const [activeChannel, setActiveChannel] = useState<ChannelId>("telegram");
  const [activePromptIdx, setActivePromptIdx] = useState<number>(0);

  const activeCorridor = CORRIDOR_MODES[corridorMode];
  const effectiveHours = activeCorridor.baseHours + (weatherRouting ? 0 : activeCorridor.weatherDeltaHours);
  const activeHub = weatherRouting ? activeCorridor.hubSafe : activeCorridor.hubDirect;
  const activeSvgPath = weatherRouting ? activeCorridor.safePath : activeCorridor.directPath;

  const rankedBids = useMemo(() => {
    const w = WEIGHT_PRESETS[weightPreset].weights;
    return [...CARRIER_BIDS]
      .map((bid) => {
        const priceScore = Math.max(40, Math.min(100, Math.round((1980 / bid.quoteUsd) * 100)));
        const speedScore = Math.max(40, Math.min(100, Math.round((11 / bid.transitHours) * 100)));
        const reliabilityScore = Math.round(bid.onTimePct);
        const total = Number(
          (
            priceScore * w.price +
            speedScore * w.speed +
            reliabilityScore * w.reliability +
            bid.carbonScore * w.carbon +
            bid.capacityScore * w.capacity +
            bid.complianceScore * w.compliance
          ).toFixed(1),
        );
        return { ...bid, priceScore, speedScore, total };
      })
      .sort((a, b) => b.total - a.total);
  }, [weightPreset]);

  const recoveryQuoteUsd = disruptionActive ? 4650 : 2190;
  const recoveryApproved = recoveryQuoteUsd <= spendCap;
  const capUtilizationPct = Math.min(100, Math.round((recoveryQuoteUsd / 6000) * 100));
  const capLinePct = Math.min(100, Math.round((spendCap / 6000) * 100));

  const channelData = CHANNEL_TRANSCRIPTS[activeChannel];
  const currentPrompt = channelData.prompts[activePromptIdx] ?? channelData.prompts[0];

  return (
    <div className="lp-stage-frame">
      <div className="lp-stage-dark" aria-label="Interactive Control Tower workflow preview">
        {/* Clean Minimalist Top Tab Rail */}
        <div className="lp-stage-header">
          <div className="lp-stage-tabs" role="tablist" aria-label="Autonomous workflow stages">
            {WORKFLOW_TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`lp-stage-tab${isActive ? " is-active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <span className="lp-stage-tab-num">{tab.index}</span>
                  <span className="lp-stage-tab-label">{tab.label}</span>
                  {isActive ? (
                    <motion.span
                      layoutId="lp-hero-tab-line"
                      className="lp-stage-tab-line"
                      transition={{ type: "spring", stiffness: 460, damping: 38 }}
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          <span className="lp-stage-env-meta">Deterministic Sandbox</span>
        </div>

        {/* Hairline-Structured Stage Workspace */}
        <div className="lp-stage-body">
          <AnimatePresence mode="wait">
            {activeTab === "corridor" ? (
              <motion.div
                key="corridor"
                className="lp-stage-panel"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="lp-stage-toolbar">
                  <div className="lp-stage-title-group">
                    <span className="lp-stage-kicker">
                      <Route size={13} aria-hidden="true" />
                      Corridor Engine · Lane {activeCorridor.lane}
                    </span>
                    <h3>Evaluate alternate freight modes against live corridor hazards</h3>
                  </div>

                  <div className="lp-stage-controls">
                    <div className="lp-seg-group" role="group" aria-label="Transport mode">
                      {(Object.keys(CORRIDOR_MODES) as CorridorModeId[]).map((modeKey) => (
                        <button
                          key={modeKey}
                          type="button"
                          className={`lp-seg-btn${corridorMode === modeKey ? " is-active" : ""}`}
                          onClick={() => setCorridorMode(modeKey)}
                        >
                          {CORRIDOR_MODES[modeKey].label}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      className={`lp-dark-toggle${weatherRouting ? " is-on" : " is-alert"}`}
                      aria-pressed={weatherRouting}
                      onClick={() => setWeatherRouting((prev) => !prev)}
                    >
                      <CloudRain size={13} aria-hidden="true" />
                      <span>{weatherRouting ? "Weather avoidance on" : "Storm exposure active"}</span>
                    </button>
                  </div>
                </div>

                <div className="lp-stage-corridor-grid">
                  {/* Left: Edge-to-Edge Precision Route Topology */}
                  <div className="lp-corridor-canvas-col">
                    <div className="lp-corridor-map-top">
                      <span>Corridor Topology</span>
                      <span className="lp-corridor-map-coord">
                        {activeCorridor.origin.code} → {activeHub.code} → {activeCorridor.destination.code}
                      </span>
                    </div>

                    <svg
                      viewBox="0 0 560 242"
                      className="lp-corridor-svg"
                      role="img"
                      aria-label={`Route map from ${activeCorridor.origin.name} to ${activeCorridor.destination.name}`}
                    >
                      <defs>
                        <pattern
                          id="lpCorridorDots"
                          width="22"
                          height="22"
                          patternUnits="userSpaceOnUse"
                        >
                          <circle cx="1.5" cy="1.5" r="0.9" fill="rgba(255,255,255,0.1)" />
                        </pattern>
                        <radialGradient id="lpStormGlow" cx="50%" cy="50%" r="50%">
                          <stop offset="0%" stopColor="rgba(251, 191, 36, 0.2)" />
                          <stop offset="100%" stopColor="rgba(251, 191, 36, 0)" />
                        </radialGradient>
                        <linearGradient id="lpRouteGlow" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="#2dd4bf" />
                          <stop offset="100%" stopColor="#5eead4" />
                        </linearGradient>
                      </defs>

                      <rect width="560" height="242" fill="url(#lpCorridorDots)" />

                      {/* Weather hazard radar zone */}
                      <motion.g
                        animate={{
                          opacity: weatherRouting ? 0.78 : 1,
                          scale: weatherRouting ? 1 : 1.07,
                        }}
                        transition={{ duration: 0.25 }}
                        style={{
                          transformOrigin: `${activeCorridor.stormCenter.x}px ${activeCorridor.stormCenter.y}px`,
                        }}
                      >
                        <circle
                          cx={activeCorridor.stormCenter.x}
                          cy={activeCorridor.stormCenter.y}
                          r={42}
                          fill="url(#lpStormGlow)"
                        />
                        <circle
                          cx={activeCorridor.stormCenter.x}
                          cy={activeCorridor.stormCenter.y}
                          r={27}
                          fill="rgba(251, 191, 36, 0.05)"
                          stroke="rgba(251, 191, 36, 0.42)"
                          strokeWidth="1"
                          strokeDasharray="3 4"
                        />
                        <circle
                          cx={activeCorridor.stormCenter.x}
                          cy={activeCorridor.stormCenter.y}
                          r={12}
                          fill="none"
                          stroke="rgba(251, 191, 36, 0.28)"
                          strokeWidth="1"
                        />
                        <text
                          x={activeCorridor.stormCenter.x}
                          y={activeCorridor.stormCenter.y + 42}
                          textAnchor="middle"
                          fill="#fbbf24"
                          fontSize="10"
                          fontWeight="500"
                        >
                          {activeCorridor.stormCenter.label}
                        </text>
                      </motion.g>

                      {/* Secondary ghost alternate path */}
                      <path
                        d={weatherRouting ? activeCorridor.directPath : activeCorridor.safePath}
                        fill="none"
                        stroke="rgba(255,255,255,0.13)"
                        strokeWidth="1.25"
                        strokeDasharray="3 5"
                      />

                      {/* Active morphed corridor trajectory */}
                      <motion.path
                        d={activeSvgPath}
                        fill="none"
                        stroke={weatherRouting ? "url(#lpRouteGlow)" : "#fbbf24"}
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        initial={false}
                        animate={{ d: activeSvgPath }}
                        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                      />

                      {/* Traveling signal particle along active path */}
                      <circle r="4" fill={weatherRouting ? "#5eead4" : "#fde68a"}>
                        <animateMotion dur="3.4s" repeatCount="indefinite" path={activeSvgPath} />
                      </circle>
                      <circle r="9" fill={weatherRouting ? "rgba(45,212,191,0.2)" : "rgba(251,191,36,0.2)"}>
                        <animateMotion dur="3.4s" repeatCount="indefinite" path={activeSvgPath} />
                      </circle>

                      {/* Origin Node */}
                      <g transform={`translate(${activeCorridor.origin.x}, ${activeCorridor.origin.y})`}>
                        <circle r="10" fill="rgba(45,212,191,0.14)" />
                        <circle r="4.5" fill="#2dd4bf" stroke="#0a0e0e" strokeWidth="2" />
                        <text x="0" y="-15" textAnchor="middle" fill="#f4f5f3" fontSize="11" fontWeight="600">
                          {activeCorridor.origin.name}
                        </text>
                        <text x="0" y="22" textAnchor="middle" fill="#929d9a" fontSize="9.5" fontWeight="500">
                          {activeCorridor.origin.code} · {activeCorridor.origin.coords}
                        </text>
                      </g>

                      {/* Active Hub Node */}
                      <motion.g
                        initial={false}
                        animate={{ x: activeHub.x, y: activeHub.y }}
                        transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                      >
                        <circle
                          r="9.5"
                          fill={weatherRouting ? "rgba(45,212,191,0.14)" : "rgba(251,191,36,0.18)"}
                        />
                        <circle
                          r="4.25"
                          fill={weatherRouting ? "#2dd4bf" : "#fbbf24"}
                          stroke="#0a0e0e"
                          strokeWidth="2"
                        />
                        <text x="0" y="-14" textAnchor="middle" fill="#f4f5f3" fontSize="10.5" fontWeight="600">
                          {activeHub.name}
                        </text>
                        <text x="0" y="20" textAnchor="middle" fill={weatherRouting ? "#2dd4bf" : "#fbbf24"} fontSize="9.5" fontWeight="600">
                          {activeHub.coords}
                        </text>
                      </motion.g>

                      {/* Destination Node */}
                      <g transform={`translate(${activeCorridor.destination.x}, ${activeCorridor.destination.y})`}>
                        <circle r="10" fill="rgba(244,245,243,0.12)" />
                        <circle r="4.5" fill="#f4f5f3" stroke="#0a0e0e" strokeWidth="2" />
                        <text x="0" y="-15" textAnchor="middle" fill="#f4f5f3" fontSize="11" fontWeight="600">
                          {activeCorridor.destination.name}
                        </text>
                        <text x="0" y="22" textAnchor="middle" fill="#929d9a" fontSize="9.5" fontWeight="500">
                          {activeCorridor.destination.code} · {activeCorridor.destination.coords}
                        </text>
                      </g>
                    </svg>

                    <div className="lp-stage-conveyance">
                      <span>Assigned Conveyance</span>
                      <strong>{activeCorridor.conveyance}</strong>
                    </div>
                  </div>

                  {/* Right: Hairline-Divided Metric Ledger + Verdict */}
                  <div className="lp-stage-metrics-col">
                    <div className="lp-stage-kpi-grid">
                      <div className="lp-stage-kpi">
                        <span>Corridor Distance</span>
                        <strong>{activeCorridor.distanceKm} km</strong>
                      </div>
                      <div className="lp-stage-kpi">
                        <span>Estimated Transit</span>
                        <strong>{effectiveHours}h 00m</strong>
                      </div>
                      <div className="lp-stage-kpi">
                        <span>Carbon Footprint</span>
                        <strong>{activeCorridor.co2Kg} kg CO₂e</strong>
                      </div>
                      <div className="lp-stage-kpi">
                        <span>Projected Cost</span>
                        <strong>${activeCorridor.costUsd.toLocaleString()}</strong>
                      </div>
                    </div>

                    <div className={`lp-stage-verdict${weatherRouting ? "" : " is-warn"}`}>
                      <div className="lp-stage-verdict-head">
                        {weatherRouting ? (
                          <CheckCircle2 size={14} aria-hidden="true" />
                        ) : (
                          <AlertTriangle size={14} aria-hidden="true" />
                        )}
                        <span>
                          {weatherRouting
                            ? "SLA Protected · 98.6% On-Time"
                            : "Weather Exposure · Variance Risk"}
                        </span>
                      </div>
                      <p>
                        {weatherRouting
                          ? `Corridor bypasses the ${activeCorridor.stormCenter.copyName} via ${activeHub.name}, preserving full delivery margin with zero SLA penalty.`
                          : `Direct vector intersects the ${activeCorridor.stormCenter.copyName}. Expect +${activeCorridor.weatherDeltaHours}h transit variance unless avoidance is active.`}
                      </p>
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : null}

            {activeTab === "scoring" ? (
              <motion.div
                key="scoring"
                className="lp-stage-panel"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="lp-stage-toolbar">
                  <div className="lp-stage-title-group">
                    <span className="lp-stage-kicker">
                      <Scale size={13} aria-hidden="true" />
                      6-Factor Weighted Scoring · Auditable Bid Math
                    </span>
                    <h3>Adjust lane priorities to inspect real-time carrier selection</h3>
                  </div>

                  <div className="lp-seg-group" role="group" aria-label="Scoring weight preset">
                    {(Object.keys(WEIGHT_PRESETS) as WeightPresetId[]).map((presetKey) => (
                      <button
                        key={presetKey}
                        type="button"
                        className={`lp-seg-btn${weightPreset === presetKey ? " is-active" : ""}`}
                        onClick={() => setWeightPreset(presetKey)}
                      >
                        {WEIGHT_PRESETS[presetKey].label}
                      </button>
                    ))}
                  </div>
                </div>

                <LayoutGroup id="hero-carrier-leaderboard">
                  <div className="lp-dark-bids">
                    {rankedBids.map((bid, idx) => (
                      <motion.div
                        key={bid.id}
                        layout
                        transition={{ type: "spring", stiffness: 360, damping: 32 }}
                        className={`lp-dark-bid-row${idx === 0 ? " is-top" : ""}`}
                      >
                        <div className="lp-dark-bid-main">
                          <span className="lp-dark-bid-rank">0{idx + 1}</span>
                          <div>
                            <div className="lp-dark-bid-title">
                              <strong>{bid.name}</strong>
                              {idx === 0 ? <span className="lp-dark-bid-win">Selected</span> : null}
                            </div>
                            <span className="lp-dark-bid-meta">
                              {bid.contract} · {bid.transitHours}h transit · {bid.onTimePct}% SLA · Carbon {bid.carbonScore}
                            </span>
                          </div>
                        </div>

                        <div className="lp-dark-bid-score-col">
                          <div className="lp-dark-bid-nums">
                            <span className="lp-dark-bid-price">${bid.quoteUsd.toLocaleString()}</span>
                            <strong className="lp-dark-bid-pts">{bid.total} pts</strong>
                          </div>
                          <div className="lp-dark-bar-track" aria-hidden="true">
                            <div
                              className="lp-dark-bar-fill"
                              style={{ width: `${Math.min(100, bid.total)}%` }}
                            />
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </LayoutGroup>
              </motion.div>
            ) : null}

            {activeTab === "recovery" ? (
              <motion.div
                key="recovery"
                className="lp-stage-panel"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="lp-stage-toolbar">
                  <div className="lp-stage-title-group">
                    <span className="lp-stage-kicker">
                      <ShieldCheck size={13} aria-hidden="true" />
                      Pre-Award Policy Guardrails · Versioned Spend Caps
                    </span>
                    <h3>Inject a schedule disruption to verify budget escalation rules</h3>
                  </div>

                  <button
                    type="button"
                    className={`lp-dark-toggle${disruptionActive ? " is-alert" : " is-on"}`}
                    aria-pressed={disruptionActive}
                    onClick={() => setDisruptionActive((prev) => !prev)}
                  >
                    <AlertTriangle size={13} aria-hidden="true" />
                    <span>{disruptionActive ? "Disruption injected (+6h delay)" : "Schedule nominal"}</span>
                  </button>
                </div>

                {/* Hairline-Divided 3-Step Gate Strip */}
                <div className="lp-recovery-flow" aria-hidden="true">
                  <div className="lp-recovery-flow-node">
                    <span>01 · Trigger</span>
                    <strong>{disruptionActive ? "Storm Delay (+6h)" : "Nominal Feed"}</strong>
                  </div>
                  <div className="lp-recovery-flow-node">
                    <span>02 · Backup Quote</span>
                    <strong>${recoveryQuoteUsd.toLocaleString()}</strong>
                  </div>
                  <div className={`lp-recovery-flow-node${recoveryApproved ? " is-ok" : " is-held"}`}>
                    <span>03 · Policy Gate</span>
                    <strong>{recoveryApproved ? "Auto-Awarded" : "Human Escalation"}</strong>
                  </div>
                </div>

                <div className="lp-recovery-grid">
                  <div className="lp-recovery-control">
                    <div className="lp-recovery-slider-head">
                      <label htmlFor="hero-spend-cap">
                        <SlidersHorizontal size={13} aria-hidden="true" />
                        Autonomous Spend Ceiling
                      </label>
                      <strong>${spendCap.toLocaleString()}</strong>
                    </div>
                    <input
                      id="hero-spend-cap"
                      type="range"
                      min={2500}
                      max={6000}
                      step={250}
                      value={spendCap}
                      onChange={(e) => setSpendCap(Number(e.target.value))}
                      className="lp-dark-range"
                    />
                    <div className="lp-cap-meter" aria-hidden="true">
                      <div
                        className={`lp-cap-meter-quote${recoveryApproved ? " is-ok" : " is-held"}`}
                        style={{ width: `${capUtilizationPct}%` }}
                      />
                      <div className="lp-cap-meter-threshold" style={{ left: `${capLinePct}%` }} />
                    </div>
                    <div className="lp-recovery-bounds">
                      <span>$2,500 strict</span>
                      <span>Quote: ${recoveryQuoteUsd.toLocaleString()}</span>
                      <span>$6,000 flexible</span>
                    </div>
                  </div>

                  <div
                    className={`lp-recovery-verdict${recoveryApproved ? " is-approved" : " is-held"}`}
                    role="status"
                  >
                    <div className="lp-recovery-verdict-head">
                      {recoveryApproved ? (
                        <CheckCircle2 size={16} aria-hidden="true" />
                      ) : (
                        <AlertTriangle size={16} aria-hidden="true" />
                      )}
                      <strong>
                        {recoveryApproved
                          ? "Auto-Approved Within Policy"
                          : "Paused for Operator Approval"}
                      </strong>
                    </div>
                    <p>
                      {recoveryApproved
                        ? `Recovery tender ($${recoveryQuoteUsd.toLocaleString()}) clears the $${spendCap.toLocaleString()} policy cap. Backup carrier booked and consignee ETA updated automatically.`
                        : `Expedited backup quote ($${recoveryQuoteUsd.toLocaleString()}) exceeds your $${spendCap.toLocaleString()} autonomous ceiling by $${(recoveryQuoteUsd - spendCap).toLocaleString()}. Tender held safely for one-tap review.`}
                    </p>
                  </div>
                </div>
              </motion.div>
            ) : null}

            {activeTab === "dispatch" ? (
              <motion.div
                key="dispatch"
                className="lp-stage-panel"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="lp-stage-toolbar">
                  <div className="lp-stage-title-group">
                    <span className="lp-stage-kicker">
                      <MessageSquare size={13} aria-hidden="true" />
                      Omnichannel Dispatch · Grounded in Persisted Shipment State
                    </span>
                    <h3>Inspect live exception logging and customer ETA synchronization</h3>
                  </div>

                  <div className="lp-seg-group" role="group" aria-label="Messaging channel">
                    {(Object.keys(CHANNEL_TRANSCRIPTS) as ChannelId[]).map((ch) => (
                      <button
                        key={ch}
                        type="button"
                        className={`lp-seg-btn${activeChannel === ch ? " is-active" : ""}`}
                        onClick={() => {
                          setActiveChannel(ch);
                          setActivePromptIdx(0);
                        }}
                      >
                        {CHANNEL_TRANSCRIPTS[ch].label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="lp-dispatch-grid">
                  <div className="lp-dispatch-prompts">
                    <div className="lp-dispatch-channel-meta">
                      {channelData.handle} · {channelData.inboundLabel}
                    </div>
                    <div className="lp-dispatch-prompt-list">
                      {channelData.prompts.map((item, idx) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`lp-dispatch-prompt-btn${activePromptIdx === idx ? " is-active" : ""}`}
                          onClick={() => setActivePromptIdx(idx)}
                        >
                          <span>{item.buttonLabel}</span>
                          <ArrowRight size={13} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </div>

                  <AnimatePresence mode="wait">
                    <motion.div
                      key={`${activeChannel}-${activePromptIdx}`}
                      className="lp-dispatch-thread"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.16 }}
                    >
                      <div className="lp-dispatch-msg is-inbound">
                        <span>Inbound event</span>
                        <code>{currentPrompt.userMessage}</code>
                      </div>
                      <div className="lp-dispatch-msg is-reply">
                        <span>Control Tower response</span>
                        <p>{currentPrompt.reply}</p>
                        <div className="lp-dispatch-audit">{currentPrompt.auditAction}</div>
                      </div>
                    </motion.div>
                  </AnimatePresence>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
