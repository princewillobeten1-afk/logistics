"use client";

import { useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  AlertTriangle,
  CheckCircle2,
  Flame,
  Plane,
  ShieldAlert,
  ShieldCheck,
  Ship,
  Snowflake,
  TrainFront,
  Truck,
} from "lucide-react";
import {
  calculateShipmentPlan,
  matchBestConveyance,
  type ConveyanceCandidate,
  type TransportMode,
} from "@/lib/planning";
import { costScores, scoreCarrier } from "@/lib/scoring";

interface ScenarioPreset {
  id: string;
  label: string;
  corridor: string;
  originCity: string;
  destinationCity: string;
  summary: string;
  defaultMode: TransportMode;
  defaultWeightKg: number;
  defaultCapUsd: number;
  deadlineHours: number;
  defaultReefer: boolean;
  defaultHazmat: boolean;
}

const SCENARIOS: ScenarioPreset[] = [
  {
    id: "intermodal",
    label: "West Africa Trunk",
    corridor: "Lagos → Abuja",
    originCity: "Lagos",
    destinationCity: "Abuja",
    summary: "High-volume domestic trunk with 24-hour distribution hub cut-off.",
    defaultMode: "ROAD",
    defaultWeightKg: 8500,
    defaultCapUsd: 4200,
    deadlineHours: 24,
    defaultReefer: false,
    defaultHazmat: false,
  },
  {
    id: "congestion",
    label: "Corridor Reroute",
    corridor: "Lagos → Kano",
    originCity: "Lagos",
    destinationCity: "Kano",
    summary: "Highway bottleneck along northern corridor; evaluate rail vs road.",
    defaultMode: "RAIL",
    defaultWeightKg: 14000,
    defaultCapUsd: 4800,
    deadlineHours: 36,
    defaultReefer: false,
    defaultHazmat: false,
  },
  {
    id: "coldchain",
    label: "Cold-Chain Rush",
    corridor: "Abuja → Port Harcourt",
    originCity: "Abuja",
    destinationCity: "Port Harcourt",
    summary: "Temperature-controlled biologics requiring 2–8°C reefer certification.",
    defaultMode: "ROAD",
    defaultWeightKg: 4200,
    defaultCapUsd: 3400,
    deadlineHours: 16,
    defaultReefer: true,
    defaultHazmat: false,
  },
  {
    id: "express",
    label: "Cross-Border Express",
    corridor: "Lagos → Abidjan",
    originCity: "Lagos",
    destinationCity: "Abidjan",
    summary: "Urgent line-down industrial spares with strict 12-hour delivery SLA.",
    defaultMode: "AIR",
    defaultWeightKg: 2800,
    defaultCapUsd: 9500,
    deadlineHours: 12,
    defaultReefer: false,
    defaultHazmat: true,
  },
];

const FLEET_POOL: ConveyanceCandidate[] = [
  {
    registration: "CT-RD-204",
    active: true,
    assigned_to: null,
    capacity_kg: 12000,
    reefer: true,
    hazmat_certified: false,
    mode: "ROAD",
  },
  {
    registration: "CT-RD-418",
    active: true,
    assigned_to: null,
    capacity_kg: 22000,
    reefer: false,
    hazmat_certified: true,
    mode: "ROAD",
  },
  {
    registration: "CT-RL-091",
    active: true,
    assigned_to: null,
    capacity_kg: 30000,
    reefer: true,
    hazmat_certified: true,
    mode: "RAIL",
  },
  {
    registration: "CT-AR-77F",
    active: true,
    assigned_to: null,
    capacity_kg: 9000,
    reefer: true,
    hazmat_certified: true,
    mode: "AIR",
  },
  {
    registration: "CT-SE-510",
    active: true,
    assigned_to: null,
    capacity_kg: 40000,
    reefer: true,
    hazmat_certified: false,
    mode: "SEA",
  },
];

interface CarrierCandidate {
  id: string;
  name: string;
  priceMultiplier: number;
  onTimeRate: number;
  damageRate: number;
  availabilityRate: number;
  serviceScore: number;
  shipmentsCount: number;
  supportsReefer: boolean;
  supportsHazmat: boolean;
}

const CARRIER_MARKET: CarrierCandidate[] = [
  {
    id: "meridian",
    name: "Meridian Freight Lines",
    priceMultiplier: 0.96,
    onTimeRate: 0.96,
    damageRate: 0.008,
    availabilityRate: 0.93,
    serviceScore: 0.94,
    shipmentsCount: 240,
    supportsReefer: true,
    supportsHazmat: true,
  },
  {
    id: "nordic",
    name: "Atlas Corridor Logistics",
    priceMultiplier: 0.89,
    onTimeRate: 0.88,
    damageRate: 0.024,
    availabilityRate: 0.86,
    serviceScore: 0.84,
    shipmentsCount: 145,
    supportsReefer: true,
    supportsHazmat: false,
  },
  {
    id: "kestrel",
    name: "Kestrel Priority Cargo",
    priceMultiplier: 1.09,
    onTimeRate: 0.985,
    damageRate: 0.004,
    availabilityRate: 0.97,
    serviceScore: 0.97,
    shipmentsCount: 192,
    supportsReefer: true,
    supportsHazmat: true,
  },
];

const MODE_OPTIONS: { value: TransportMode; label: string; icon: typeof Truck }[] = [
  { value: "ROAD", label: "Road", icon: Truck },
  { value: "RAIL", label: "Rail", icon: TrainFront },
  { value: "AIR", label: "Air", icon: Plane },
  { value: "SEA", label: "Sea", icon: Ship },
];

const FIXED_NOW_MS = Date.UTC(2026, 10, 25, 8, 0, 0);

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function DecisionSimulator() {
  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0].id);
  const [mode, setMode] = useState<TransportMode>(SCENARIOS[0].defaultMode);
  const [weightKg, setWeightKg] = useState<number>(SCENARIOS[0].defaultWeightKg);
  const [capUsd, setCapUsd] = useState<number>(SCENARIOS[0].defaultCapUsd);
  const [reefer, setReefer] = useState<boolean>(SCENARIOS[0].defaultReefer);
  const [hazmat, setHazmat] = useState<boolean>(SCENARIOS[0].defaultHazmat);

  const scenario = useMemo(
    () => SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0],
    [scenarioId],
  );

  const selectScenario = (preset: ScenarioPreset) => {
    setScenarioId(preset.id);
    setMode(preset.defaultMode);
    setWeightKg(preset.defaultWeightKg);
    setCapUsd(preset.defaultCapUsd);
    setReefer(preset.defaultReefer);
    setHazmat(preset.defaultHazmat);
  };

  const simulation = useMemo(() => {
    const deadlineIso = new Date(FIXED_NOW_MS + scenario.deadlineHours * 3_600_000).toISOString();
    const plan = calculateShipmentPlan({
      originCity: scenario.originCity,
      destinationCity: scenario.destinationCity,
      weightKg,
      preferredMode: mode,
      deadlineIso,
      currency: "USD",
      nowMs: FIXED_NOW_MS,
    });

    // Convert deterministic minor units into realistic corridor USD scale,
    // adding compliance surcharges for reefer or hazmat handling.
    const complianceFactor = (reefer ? 1.14 : 1) * (hazmat ? 1.18 : 1);
    const baselineUsd = Math.max(
      480,
      Math.round((plan.estimatedCostMinor / 65000) * complianceFactor),
    );

    const matchedUnit = matchBestConveyance(
      {
        weightKg,
        reefer,
        hazmat,
        preferredMode: mode,
      },
      FLEET_POOL,
    );

    const eligibleCarriers = CARRIER_MARKET.filter((c) => {
      if (reefer && !c.supportsReefer) return false;
      if (hazmat && !c.supportsHazmat) return false;
      return true;
    });

    const quoted = eligibleCarriers.map((carrier) => ({
      ...carrier,
      quoteUsd: Math.round(baselineUsd * carrier.priceMultiplier),
    }));

    const normalisedCosts = costScores(quoted.map((q) => q.quoteUsd));

    const ranked = quoted
      .map((carrier, index) => {
        const breakdown = scoreCarrier({
          costScore: normalisedCosts[index],
          onTimeRate: carrier.onTimeRate,
          damageRate: carrier.damageRate,
          availabilityRate: carrier.availabilityRate,
          serviceScore: carrier.serviceScore,
          shipmentsCount: carrier.shipmentsCount,
        });
        return {
          ...carrier,
          breakdown,
          scorePct: Math.round(breakdown.normalised * 1000) / 10,
        };
      })
      .sort((a, b) => b.breakdown.normalised - a.breakdown.normalised);

    const winner = ranked[0];
    const withinCap = winner ? winner.quoteUsd <= capUsd : false;
    const capDelta = winner ? Math.abs(winner.quoteUsd - capUsd) : 0;
    const autoApproved = Boolean(winner && withinCap && plan.meetsDeadline);

    const gateReason = !plan.meetsDeadline
      ? `Projected ${plan.transitHours}h transit misses ${scenario.deadlineHours}h SLA — switch to faster mode or approve exception.`
      : !withinCap
        ? `Best bid (${formatUsd(winner.quoteUsd)}) exceeds autonomous ceiling by ${formatUsd(capDelta)}.`
        : `${winner.name} cleared all 6 scoring weights with ${formatUsd(capDelta)} policy headroom.`;

    const trace = [
      {
        step: "01",
        title: "Corridor Plan Computed",
        detail: `${scenario.corridor} (${plan.distanceKm.toLocaleString()} km) · ${plan.transitHours}h via ${plan.mode} · ${plan.co2eKg.toLocaleString()} kg CO₂e`,
      },
      {
        step: "02",
        title: "Fleet Capacity Matched",
        detail: matchedUnit
          ? `Assigned idle unit ${matchedUnit.registration} (${Number(matchedUnit.capacity_kg).toLocaleString()} kg cap, ${matchedUnit.mode})`
          : "No idle internal conveyance meets weight & certification — routed to contracted carrier tender",
      },
      {
        step: "03",
        title: "6-Factor Carrier Scorecard",
        detail: `${ranked.length} compliant bids scored (30% cost, 25% on-time, 15% availability, 10% damage, 10% lane, 10% service)`,
      },
      {
        step: "04",
        title: autoApproved ? "Policy Gate Cleared" : "Policy Gate Escalated",
        detail: autoApproved
          ? `Auto-awarded to ${winner.name} at ${formatUsd(winner.quoteUsd)} (score ${winner.scorePct.toFixed(1)}/100)`
          : `Held for Ops Director review — ${!plan.meetsDeadline ? "SLA breach risk" : `+${formatUsd(capDelta)} above ceiling`}`,
      },
      {
        step: "05",
        title: "Downstream Sync Queued",
        detail: autoApproved
          ? "ERP booking webhook, EDI 204 tender, and Telegram customer ETA notification dispatched"
          : "Approval card posted to Console & Telegram ops channel with one-tap override audit trail",
      },
    ];

    return {
      plan,
      matchedUnit,
      ranked,
      winner,
      withinCap,
      capDelta,
      autoApproved,
      gateReason,
      trace,
    };
  }, [scenario, mode, weightKg, capUsd, reefer, hazmat]);

  return (
    <div className="lp-sim-shell">
      <div className="lp-sim-presets" role="tablist" aria-label="Corridor scenarios">
        {SCENARIOS.map((item) => {
          const active = item.id === scenario.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`lp-sim-preset${active ? " is-active" : ""}`}
              onClick={() => selectScenario(item)}
            >
              <span className="lp-sim-preset-name">{item.label}</span>
              <span className="lp-sim-preset-corridor">{item.corridor}</span>
            </button>
          );
        })}
      </div>

      <div className="lp-sim-grid">
        {/* Left: Controls */}
        <div className="lp-sim-controls">
          <div className="lp-sim-panel-head">
            <div>
              <span className="lp-eyebrow-mono">INPUT PARAMETERS</span>
              <h3>{scenario.corridor}</h3>
            </div>
            <span className="lp-mono-meta">SLA {scenario.deadlineHours}h</span>
          </div>
          <p className="lp-sim-desc">{scenario.summary}</p>

          <div className="lp-control-block">
            <label className="lp-control-label">Transport Mode</label>
            <div className="lp-mode-grid">
              {MODE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const selected = mode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`lp-mode-btn${selected ? " is-active" : ""}`}
                    onClick={() => setMode(opt.value)}
                    aria-pressed={selected}
                  >
                    <Icon size={15} aria-hidden="true" />
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="lp-control-block">
            <label className="lp-control-label">Cargo Constraints</label>
            <div className="lp-constraint-row">
              <button
                type="button"
                className={`lp-toggle-btn${reefer ? " is-active" : ""}`}
                onClick={() => setReefer((v) => !v)}
                aria-pressed={reefer}
              >
                <Snowflake size={14} aria-hidden="true" />
                <span>Reefer 2–8°C</span>
              </button>
              <button
                type="button"
                className={`lp-toggle-btn${hazmat ? " is-active" : ""}`}
                onClick={() => setHazmat((v) => !v)}
                aria-pressed={hazmat}
              >
                <Flame size={14} aria-hidden="true" />
                <span>Hazmat Certified</span>
              </button>
            </div>
          </div>

          <div className="lp-control-block">
            <div className="lp-slider-head">
              <label htmlFor="sim-weight" className="lp-control-label">
                Payload Weight
              </label>
              <output htmlFor="sim-weight" className="lp-slider-val">
                {weightKg.toLocaleString()} kg
              </output>
            </div>
            <input
              id="sim-weight"
              type="range"
              min={500}
              max={24000}
              step={500}
              value={weightKg}
              onChange={(e) => setWeightKg(Number(e.target.value))}
              className="lp-range"
            />
            <div className="lp-slider-bounds">
              <span>500 kg</span>
              <span>24,000 kg</span>
            </div>
          </div>

          <div className="lp-control-block">
            <div className="lp-slider-head">
              <label htmlFor="sim-cap" className="lp-control-label">
                Autonomous Spend Cap
              </label>
              <output htmlFor="sim-cap" className="lp-slider-val">
                {formatUsd(capUsd)}
              </output>
            </div>
            <input
              id="sim-cap"
              type="range"
              min={1200}
              max={18000}
              step={200}
              value={capUsd}
              onChange={(e) => setCapUsd(Number(e.target.value))}
              className="lp-range"
            />
            <div className="lp-slider-bounds">
              <span>$1,200</span>
              <span>$18,000</span>
            </div>
          </div>

          <div className="lp-sim-unit-box">
            <span className="lp-eyebrow-mono">INTERNAL FLEET MATCH</span>
            <p className="lp-sim-unit-text">
              {simulation.matchedUnit ? (
                <>
                  <strong>{simulation.matchedUnit.registration}</strong> ·{" "}
                  {Number(simulation.matchedUnit.capacity_kg).toLocaleString()} kg ·{" "}
                  {simulation.matchedUnit.mode}
                </>
              ) : (
                "No idle internal unit qualifies — external tender active"
              )}
            </p>
          </div>
        </div>

        {/* Right: Deterministic Output */}
        <div className="lp-sim-output">
          {/* Policy Gate Verdict */}
          <div
            className={`lp-gate-banner ${simulation.autoApproved ? "is-approved" : "is-held"}`}
            role="status"
            aria-live="polite"
          >
            <div className="lp-gate-icon" aria-hidden="true">
              {simulation.autoApproved ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}
            </div>
            <div className="lp-gate-body">
              <div className="lp-gate-title">
                {simulation.autoApproved
                  ? "Auto-Approved — Executed Under Policy"
                  : "Held for Human Approval — Policy Gate Triggered"}
              </div>
              <p className="lp-gate-reason">{simulation.gateReason}</p>
            </div>
          </div>

          {/* 4 deterministic KPIs */}
          <div className="lp-sim-kpis">
            <div className="lp-sim-kpi">
              <span className="lp-sim-kpi-label">Transit Window</span>
              <strong className="lp-sim-kpi-value">{simulation.plan.transitHours}h</strong>
              <span
                className={`lp-sim-kpi-sub ${simulation.plan.meetsDeadline ? "is-ok" : "is-warn"}`}
              >
                {simulation.plan.meetsDeadline ? (
                  <>
                    <CheckCircle2 size={12} aria-hidden="true" /> Meets {scenario.deadlineHours}h SLA
                  </>
                ) : (
                  <>
                    <AlertTriangle size={12} aria-hidden="true" /> Misses {scenario.deadlineHours}h SLA
                  </>
                )}
              </span>
            </div>

            <div className="lp-sim-kpi">
              <span className="lp-sim-kpi-label">Winning Bid</span>
              <strong className="lp-sim-kpi-value">
                {simulation.winner ? formatUsd(simulation.winner.quoteUsd) : "—"}
              </strong>
              <span className="lp-sim-kpi-sub">
                Cap {formatUsd(capUsd)}
              </span>
            </div>

            <div className="lp-sim-kpi">
              <span className="lp-sim-kpi-label">Corridor Distance</span>
              <strong className="lp-sim-kpi-value">
                {simulation.plan.distanceKm.toLocaleString()} km
              </strong>
              <span className="lp-sim-kpi-sub">{simulation.plan.mode} route</span>
            </div>

            <div className="lp-sim-kpi">
              <span className="lp-sim-kpi-label">Carbon Footprint</span>
              <strong className="lp-sim-kpi-value">
                {simulation.plan.co2eKg.toLocaleString()} kg
              </strong>
              <span className="lp-sim-kpi-sub">CO₂e estimate</span>
            </div>
          </div>

          {/* Live Carrier Scorecard */}
          <div className="lp-scorecard">
            <div className="lp-scorecard-head">
              <span className="lp-eyebrow-mono">LIVE 6-FACTOR CARRIER SCORECARD</span>
              <span className="lp-mono-meta">lib/scoring.ts · deterministic</span>
            </div>

            <div className="lp-carrier-list">
              {simulation.ranked.map((carrier, idx) => {
                const isWinner = idx === 0;
                return (
                  <div
                    key={carrier.id}
                    className={`lp-carrier-row${isWinner ? " is-winner" : ""}`}
                  >
                    <div className="lp-carrier-top">
                      <div className="lp-carrier-name-wrap">
                        <span className="lp-carrier-rank">0{idx + 1}</span>
                        <span className="lp-carrier-name">{carrier.name}</span>
                        {isWinner ? (
                          <span className="lp-carrier-tag">Selected</span>
                        ) : null}
                      </div>
                      <div className="lp-carrier-nums">
                        <span className="lp-carrier-quote">{formatUsd(carrier.quoteUsd)}</span>
                        <span className="lp-carrier-score">{carrier.scorePct.toFixed(1)}</span>
                      </div>
                    </div>
                    <div className="lp-score-track" aria-hidden="true">
                      <motion.div
                        className="lp-score-fill"
                        initial={false}
                        animate={{ width: `${Math.min(100, Math.max(8, carrier.scorePct))}%` }}
                        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                      />
                    </div>
                    <div className="lp-carrier-meta">
                      <span>On-time {(carrier.onTimeRate * 100).toFixed(1)}%</span>
                      <span>Damage {(carrier.damageRate * 100).toFixed(1)}%</span>
                      <span>Avail {(carrier.availabilityRate * 100).toFixed(0)}%</span>
                      <span>{carrier.shipmentsCount} lane runs</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Autonomous Execution Trace */}
          <div className="lp-trace">
            <div className="lp-scorecard-head">
              <span className="lp-eyebrow-mono">AUTONOMOUS EXECUTION TRACE</span>
              <span className="lp-mono-meta">audit-ready</span>
            </div>
            <ol className="lp-trace-list">
              {simulation.trace.map((item) => (
                <li key={item.step} className="lp-trace-item">
                  <span className="lp-trace-step">{item.step}.</span>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
