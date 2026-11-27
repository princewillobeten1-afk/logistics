"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, ShieldCheck } from "lucide-react";

type StoryScenarioId = "weather" | "port" | "spot";

interface TimelineBeat {
  time: string;
  title: string;
  detail: string;
}

interface TransformationScenario {
  id: StoryScenarioId;
  tabLabel: string;
  laneTitle: string;
  beforeSummary: string;
  afterSummary: string;
  beforeTimeline: TimelineBeat[];
  afterTimeline: TimelineBeat[];
  beforeMetrics: string[];
  afterMetrics: string[];
}

const SCENARIOS: TransformationScenario[] = [
  {
    id: "weather",
    tabLabel: "Highway Storm Reroute",
    laneTitle: "Rotterdam → Munich · 18-pallet cold-chain shipment",
    beforeSummary:
      "A wind advisory shuts two lanes on the A3. Because weather alerts and GPS live in separate tabs, nobody in dispatch hears about it until the driver calls from dead-stop traffic four hours later.",
    afterSummary:
      "Live GPS and weather corridor checks flag the A3 stall at 04:12 a.m., score a Duisburg rail bypass against your contracts, and lock in the detour in three minutes flat.",
    beforeTimeline: [
      {
        time: "04:12 AM",
        title: "TRK-19 commits directly into a closed corridor",
        detail:
          "Severe crosswinds halt A3 traffic near Cologne, while weather advisories remain isolated in an unmonitored external portal.",
      },
      {
        time: "07:45 AM",
        title: "Reactive broker outreach across stale rate tables",
        detail:
          "Morning coordinators locate the stalled vehicle, search outdated PDF rate sheets, and request emergency quotes from seven brokers.",
      },
      {
        time: "11:20 AM",
        title: "Unapproved spot premium and retail SLA penalty",
        detail:
          "An ad-hoc carrier is booked at $4,850 (+121% above contract) with no competing bid log—and the load still misses Munich receiving, incurring a $2,400 chargeback.",
      },
    ],
    afterTimeline: [
      {
        time: "04:12 AM",
        title: "Corridor scan detects A3 closure before Ruhr entry",
        detail:
          "Vehicle GPS coordinates correlate with Google Weather hazard polygons, projecting a +95 min SLA risk before departure window lock.",
      },
      {
        time: "04:14 AM",
        title: "Six-factor scoring selects contracted rail bypass",
        detail:
          "Deterministic evaluation ranks Duisburg rail shuttles against contracted backups and selects Nordic Intermodal Express at $2,430 (+$240 delta).",
      },
      {
        time: "04:15 AM",
        title: "Policy ceiling clears booking and syncs all parties",
        detail:
          "Policy v4.2 auto-approves the +$240 delta, dispatches Duisburg gate instructions to the driver via Telegram, and updates Munich receiving.",
      },
    ],
    beforeMetrics: [
      "4.5 hrs spent sourcing quotes",
      "+$2,660 spot overrun & fine",
      "No competing bid record",
    ],
    afterMetrics: [
      "3 min automated recovery",
      "Delivered inside SLA window",
      "Full bid audit archived",
    ],
  },
  {
    id: "port",
    tabLabel: "Port Berth Dwell",
    laneTitle: "Antwerp → Berlin · Short-sea container transfer",
    beforeSummary:
      "A feeder vessel discharges six hours late. Port EDI notices sit unread in shared inboxes, sending the contracted drayage truck to an empty quay.",
    afterSummary:
      "Control Tower ingests the EDI 315 berth update immediately, shifts the drayage pickup window in advance, and preserves the outbound Berlin rail reservation.",
    beforeTimeline: [
      {
        time: "06:30 AM",
        title: "Berth congestion pushes discharge back six hours",
        detail:
          "The terminal transmits an updated EDI timestamp, while drayage dispatch continues executing from yesterday's exported schedule.",
      },
      {
        time: "09:15 AM",
        title: "Unscheduled quay arrival triggers hourly detention",
        detail:
          "The contracted tractor arrives at Quay 4 while the container remains stowed aboard, accruing $145/hour in waiting fees during manual phone escalation.",
      },
      {
        time: "03:40 PM",
        title: "Missed rail cutoff and 24-hour delivery slip",
        detail:
          "The outbound train departs without the container, adding overnight terminal storage fees and delaying Berlin assembly by one full day.",
      },
    ],
    afterTimeline: [
      {
        time: "06:30 AM",
        title: "EDI 315 milestone updates lane timing immediately",
        detail:
          "The incoming berth delay flows straight into the active shipment record and recalculates downstream rail cutoff margins.",
      },
      {
        time: "06:32 AM",
        title: "Drayage slot aligns before vehicle dispatch",
        detail:
          "Control Tower shifts truck pickup to verified crane release and locks capacity on the 14:10 electric rail shuttle.",
      },
      {
        time: "06:33 AM",
        title: "Carrier and consignee confirm synchronized schedule",
        detail:
          "The driver acknowledges the revised window on Telegram and Berlin receiving adjusts its dock calendar—zero detention, zero yard fees.",
      },
    ],
    beforeMetrics: [
      "$890 detention & yard fees",
      "24-hour downstream delay",
      "12 manual status calls",
    ],
    afterMetrics: [
      "$0 idle driver detention",
      "4.2 hrs dwell eliminated",
      "Dock calendar synced early",
    ],
  },
  {
    id: "spot",
    tabLabel: "Spot Rate Overrun",
    laneTitle: "Hamburg → Zurich · Urgent medical supply replenishment",
    beforeSummary:
      "A primary carrier cancels at 4:50 p.m. on Friday. Under deadline pressure, dispatch accepts an uncontracted $6,400 charter—leaving finance with an unapproved variance Monday morning.",
    afterSummary:
      "Deterministic rate-card scoring surfaces a $2,780 road-and-rail hybrid inside policy bounds, while escalating any above-cap quote for single-click executive sign-off.",
    beforeTimeline: [
      {
        time: "04:50 PM",
        title: "Late Friday tender rejection hits shared inbox",
        detail:
          "The primary carrier drops the load via email ten minutes before shift handover, leaving 12 temperature-controlled medical pallets unassigned.",
      },
      {
        time: "05:15 PM",
        title: "Emergency spot booking bypasses contract backups",
        detail:
          "Without time to reconcile six carrier PDFs, dispatch accepts a $6,400 dedicated charter from the first broker to respond.",
      },
      {
        time: "Monday AM",
        title: "Finance flags a $4,100 variance without audit support",
        detail:
          "Accounting identifies a steep margin overrun with no record of competing bids, carrier scores, or pre-award authorization.",
      },
    ],
    afterTimeline: [
      {
        time: "04:50 PM",
        title: "Contracted backups ranked in milliseconds",
        detail:
          "Control Tower evaluates every pre-negotiated carrier across six weighted factors, surfacing a $2,780 road-and-rail express option.",
      },
      {
        time: "04:51 PM",
        title: "Policy ceiling validates recovery spend",
        detail:
          "Because $2,780 clears the $3,500 recovery ceiling and meets Monday's 08:00 a.m. delivery cutoff, the system awards the tender automatically.",
      },
      {
        time: "04:52 PM",
        title: "Immutable decision snapshot archived for finance",
        detail:
          "Every competing quote, factor weight, and Policy v4.2 threshold is stored on the shipment record for effortless financial reconciliation.",
      },
    ],
    beforeMetrics: [
      "+$4,100 unapproved spot spend",
      "Zero competing bid history",
      "Unreconciled P&L variance",
    ],
    afterMetrics: [
      "$3,620 saved vs. spot charter",
      "2 min policy-cleared award",
      "100% bid audit preserved",
    ],
  },
];

const PAIN_SOLUTIONS = [
  {
    number: "01",
    painTitle: "Disruptions surface four hours too late",
    painDetail:
      "GPS beacons, port EDI updates, and highway weather alerts sit in separate tabs—so your team hears about a stalled lane when an angry buyer calls.",
    solutionTitle: "GPS, EDI, and weather fused on one live clock",
    solutionDetail:
      "Control Tower watches vehicle telemetry, berth notices, and storm polygons together—flagging SLA risks hours before dock cutoffs break.",
  },
  {
    number: "02",
    painTitle: "Frantic broker emails inflate every spot quote",
    painDetail:
      "When a carrier cancels, coordinators scramble through outdated spreadsheets and hand the load to whoever replies first—paying peak spot markups.",
    solutionTitle: "Contracted carriers ranked in code in milliseconds",
    solutionDetail:
      "Deterministic math scores every backup on cost, on-time history, speed, capacity, CO₂e, and compliance—no favoritism, no guesswork.",
  },
  {
    number: "03",
    painTitle: "Unchecked spot spend—or approval gridlock",
    painDetail:
      "Open checkbooks wreck freight margins, while forcing directors to sign off on routine $200 detours slows dispatch to a crawl.",
    solutionTitle: "Spend caps auto-clear safe fixes and hold outliers",
    solutionDetail:
      "Versioned policy guardrails book compliant recoveries on the spot and pause above-budget quotes for one-tap human sign-off.",
  },
  {
    number: "04",
    painTitle: "Half the shift lost chasing status updates",
    painDetail:
      "Coordinators burn hours copying tracking links between driver WhatsApp threads, carrier emails, and ERP order screens.",
    solutionTitle: "Drivers and buyers sync straight over Telegram & WhatsApp",
    solutionDetail:
      "Drivers log gate delays in two taps from their messaging app while buyers check live ETAs backed directly by shipment state.",
  },
];

export function TransformationStory({ isAuthenticated }: { isAuthenticated: boolean }) {
  const [activeId, setActiveId] = useState<StoryScenarioId>("weather");
  const scenario = SCENARIOS.find((item) => item.id === activeId) ?? SCENARIOS[0];

  return (
    <div className="lp-transform-shell">
      {/* Scenario Selector Bar */}
      <div className="lp-transform-toolbar">
        <div className="lp-transform-tabs" role="tablist" aria-label="Operational transformation stories">
          {SCENARIOS.map((item) => {
            const active = item.id === scenario.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`lp-transform-tab${active ? " is-active" : ""}`}
                onClick={() => setActiveId(item.id)}
              >
                {item.tabLabel}
              </button>
            );
          })}
        </div>

        <span className="lp-transform-lane">{scenario.laneTitle}</span>
      </div>

      {/* Vivid Before & After Story Split */}
      <AnimatePresence mode="wait">
        <motion.div
          key={scenario.id}
          className="lp-story-grid"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* BEFORE: Problem Agitation */}
          <article className="lp-story-card is-before">
            <div className="lp-story-card-head">
              <div className="lp-story-state-label is-warn">
                <AlertTriangle size={15} aria-hidden="true" />
                <span>Legacy Dispatch · Fragmented Portals &amp; Spreadsheets</span>
              </div>
              <h3>Late exception discovery, reactive quoting, and unbudgeted spot spend</h3>
              <p>{scenario.beforeSummary}</p>
            </div>

            <ol className="lp-story-timeline">
              {scenario.beforeTimeline.map((beat) => (
                <li key={beat.time}>
                  <span className="lp-story-time">
                    <Clock size={12} aria-hidden="true" />
                    {beat.time}
                  </span>
                  <div className="lp-story-beat-body">
                    <strong>{beat.title}</strong>
                    <p>{beat.detail}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="lp-story-outcomes is-before">
              {scenario.beforeMetrics.map((metric) => (
                <span key={metric}>{metric}</span>
              ))}
            </div>
          </article>

          {/* AFTER: Transformation with Control Tower */}
          <article className="lp-story-card is-after">
            <div className="lp-story-card-head">
              <div className="lp-story-state-label is-ok">
                <ShieldCheck size={15} aria-hidden="true" />
                <span>Control Tower · Deterministic &amp; Policy-Gated</span>
              </div>
              <h3>Proactive hazard detection, auditable scoring, and capped recovery</h3>
              <p>{scenario.afterSummary}</p>
            </div>

            <ol className="lp-story-timeline">
              {scenario.afterTimeline.map((beat) => (
                <li key={beat.time}>
                  <span className="lp-story-time is-after">
                    <Clock size={12} aria-hidden="true" />
                    {beat.time}
                  </span>
                  <div className="lp-story-beat-body">
                    <strong>{beat.title}</strong>
                    <p>{beat.detail}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="lp-story-outcomes is-after">
              {scenario.afterMetrics.map((metric) => (
                <span key={metric}>
                  <CheckCircle2 size={13} aria-hidden="true" />
                  {metric}
                </span>
              ))}
            </div>
          </article>
        </motion.div>
      </AnimatePresence>

      {/* 4 Explicit Pain Points -> Product Solutions Matrix */}
      <div className="lp-pain-solution-block">
        <div className="lp-pain-solution-head">
          <div>
            <span className="lp-sub-label">Operational Bottlenecks Resolved</span>
            <h3>Four margin leaks in freight dispatch—and the controls that close them</h3>
          </div>
          <Link
            href={isAuthenticated ? "/" : "/signup"}
            className="lp-btn lp-btn-primary"
          >
            <span>{isAuthenticated ? "Open Live Console" : "Standardize Exception Recovery"}</span>
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>

        <div className="lp-pain-rows">
          {PAIN_SOLUTIONS.map((row) => (
            <div key={row.number} className="lp-pain-row">
              <div className="lp-pain-col">
                <span className="lp-pain-tag">Pain Point {row.number}</span>
                <h4>{row.painTitle}</h4>
                <p>{row.painDetail}</p>
              </div>
              <div className="lp-solution-col">
                <span className="lp-solution-tag">How Control Tower Solves It</span>
                <h4>{row.solutionTitle}</h4>
                <p>{row.solutionDetail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
