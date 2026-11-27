"use client";

import { useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "motion/react";

const SCORING_FACTORS = [
  { label: "On-Time SLA History", weight: "25%", fill: 92 },
  { label: "Contract Rate Fit", weight: "25%", fill: 88 },
  { label: "Transit Velocity", weight: "20%", fill: 84 },
  { label: "Carbon CO₂e Score", weight: "10%", fill: 94 },
  { label: "Fleet Capacity", weight: "10%", fill: 90 },
  { label: "Compliance & Docs", weight: "10%", fill: 99 },
];

const PIPELINE_STAGES = [
  {
    id: "ingest",
    step: "01",
    name: "Ingest",
    spec: "REST · EDI X12 · Webhooks · CSV",
    summary:
      "Every incoming purchase order, rate sheet, and GPS ping is cleaned, schema-checked, and guarded against duplicate tenders.",
  },
  {
    id: "plan",
    step: "02",
    name: "Plan",
    spec: "Deterministic corridor & fleet solver",
    summary:
      "Repeatable code computes multimodal legs, carbon footprint, and 6-factor carrier scores—zero prompt drift, identical math every run.",
  },
  {
    id: "gate",
    step: "03",
    name: "Gate",
    spec: "Versioned spend caps & SLA floors",
    summary:
      "Every recovery booking checks your organization's spend cap first. Above-limit spot quotes pause cleanly for one-tap human sign-off.",
  },
  {
    id: "notify",
    step: "04",
    name: "Notify",
    spec: "Telegram · WhatsApp · Email · Console",
    summary:
      "Drivers get updated dock instructions and buyers pull verified ETAs grounded strictly in live shipment telemetry.",
  },
];

export function ArchitectureBento() {
  const [activeStageId, setActiveStageId] = useState<string>("plan");
  const activeStage =
    PIPELINE_STAGES.find((stage) => stage.id === activeStageId) ?? PIPELINE_STAGES[1];

  return (
    <div className="lp-bento-grid">
      {/* Card 1: Wide Visual Corridor Showcase with Hero Terminal Photo */}
      <div className="lp-bento-card lp-bento-span-7 lp-bento-media-card">
        <Image
          src="/images/landing/hero-terminal.jpg"
          alt="Automated intermodal container terminal illuminated at dusk with gantry cranes along the berth"
          fill
          sizes="(max-width: 960px) 100vw, 58vw"
          className="lp-photo-img"
          referrerPolicy="no-referrer"
        />
        <div className="lp-bento-scrim" aria-hidden="true" />
        <div className="lp-bento-media-content">
          <div className="lp-bento-eyebrow">Deterministic Corridor Planning</div>
          <h3>Every leg verified before a tender leaves the tower.</h3>
          <p className="lp-bento-media-copy">
            At Rotterdam Maasvlakte (above), live berth discharge scans flow
            straight into Control Tower—locking rail slots and storm buffers
            before your driver leaves the gate.
          </p>
          <div className="lp-bento-telemetry-strip">
            <div>
              <span>Lane Lock</span>
              <strong>RTM → DUI → MUC</strong>
            </div>
            <div>
              <span>On-Time Window</span>
              <strong>98.6% SLA</strong>
            </div>
            <div>
              <span>Tenant Scope</span>
              <strong>Org-Isolated</strong>
            </div>
          </div>
        </div>
      </div>

      {/* Card 2: Narrow 6-Factor Scoring Breakdown */}
      <div className="lp-bento-card lp-bento-span-5 lp-bento-panel">
        <div className="lp-bento-panel-head">
          <span className="lp-bento-eyebrow">Inspectable Bid Math</span>
          <h3>Six factors. Zero black-box guesswork.</h3>
          <p>
            Every carrier score is calculated in repeatable code—never guessed.
            Tune priority weights per lane and give finance a clear audit table
            showing why every winner won.
          </p>
        </div>

        <div className="lp-factor-list">
          {SCORING_FACTORS.map((factor) => (
            <div key={factor.label} className="lp-factor-row">
              <div className="lp-factor-meta">
                <span>{factor.label}</span>
                <strong>{factor.weight}</strong>
              </div>
              <div className="lp-factor-track" aria-hidden="true">
                <div className="lp-factor-fill" style={{ width: `${factor.fill}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Card 3: Narrow Governance & Air Freight Media Card */}
      <div className="lp-bento-card lp-bento-span-5 lp-bento-panel lp-bento-policy-card">
        <div className="lp-bento-mini-photo">
          <Image
            src="/images/landing/cargo-aircraft.jpg"
            alt="Wide-body cargo aircraft loading ULD freight containers on an illuminated tarmac"
            fill
            sizes="(max-width: 960px) 100vw, 40vw"
            className="lp-photo-img"
            referrerPolicy="no-referrer"
          />
        </div>

        <div className="lp-bento-policy-body">
          <span className="lp-bento-eyebrow">Pre-Award Budget Enforcement</span>
          <h3>Hard spend ceilings on every expedited recovery.</h3>
          <p className="lp-bento-body-copy">
            Widebody air charters (above) activate only when surface delays
            threaten an SLA window—and remain strictly bounded by your approved
            recovery policy.
          </p>
          <div className="lp-policy-rules">
            <div className="lp-policy-rule-row">
              <span>Autonomous Spend Cap</span>
              <strong>Enforced pre-award</strong>
            </div>
            <div className="lp-policy-rule-row">
              <span>SLA Deadline Floor</span>
              <strong>Auto-escalation</strong>
            </div>
            <div className="lp-policy-rule-row">
              <span>Decision Audit Trail</span>
              <strong>Versioned snapshot</strong>
            </div>
          </div>
        </div>
      </div>

      {/* Card 4: Wide Interactive 4-Stage Pipeline + Corridor Bridge Visual */}
      <div className="lp-bento-card lp-bento-span-7 lp-bento-panel lp-bento-pipeline-card">
        <div className="lp-bento-pipeline-banner">
          <Image
            src="/images/landing/freight-corridor.jpg"
            alt="Freight highway corridor crossing a cable-stayed river bridge under open daylight"
            fill
            sizes="(max-width: 960px) 100vw, 58vw"
            className="lp-photo-img"
            referrerPolicy="no-referrer"
          />
          <div className="lp-bento-scrim" aria-hidden="true" />
          <div className="lp-bento-banner-caption">
            <span>TEN-T Highway Corridor</span>
            <span aria-hidden="true">·</span>
            <span>Bridge clearance, tolls &amp; live weather scored</span>
          </div>
        </div>

        <div className="lp-bento-pipeline-head">
          <span className="lp-bento-eyebrow">Four-Gate Dispatch Pipeline</span>
          <h3>Four deterministic gates from order intake to dispatch</h3>
          <p className="lp-bento-body-copy">
            Every shipment clears four reproducible checkpoints before funds are
            committed or a carrier is tendered.
          </p>
        </div>

        <div className="lp-bento-stage-tabs" role="tablist" aria-label="Execution pipeline stages">
          {PIPELINE_STAGES.map((stage) => {
            const isActive = stage.id === activeStage.id;
            return (
              <button
                key={stage.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`lp-bento-stage-btn${isActive ? " is-active" : ""}`}
                onClick={() => setActiveStageId(stage.id)}
              >
                <span>{stage.step}</span>
                <strong>{stage.name}</strong>
              </button>
            );
          })}
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={activeStage.id}
            className="lp-bento-stage-detail"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="lp-bento-stage-spec">{activeStage.spec}</div>
            <p>{activeStage.summary}</p>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
