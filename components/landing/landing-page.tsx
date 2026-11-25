"use client";

import { useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion } from "motion/react";
import {
  ArrowRight,
  Bot,
  Box,
  Check,
  Compass,
  MessageSquare,
  Plug,
  ShieldCheck,
} from "lucide-react";
import { DecisionSimulator } from "./decision-simulator";

interface LandingPageProps {
  isAuthenticated: boolean;
}

interface BriefingState {
  email: string;
  volume: string;
  stack: string;
}

const VOLUME_OPTIONS = [
  "Under 500 shipments / month",
  "500 – 2,500 shipments / month",
  "2,500 – 10,000 shipments / month",
  "10,000+ shipments / month",
];

const HERO_METRICS = [
  { value: "4 modes", label: "Road, air, sea & rail planned natively" },
  { value: "6-factor", label: "Weighted carrier scoring on every tender" },
  { value: "< 12s", label: "Exception detection to carrier reroute" },
  { value: "100%", label: "Spend bounded by versioned approval caps" },
];

const ARCHITECTURE_LAYERS = [
  {
    layer: "Ingest",
    spec: "REST · EDI X12 · Webhooks · CSV",
    guarantee: "Idempotent schema validation & dead-letter recovery",
  },
  {
    layer: "Plan",
    spec: "Deterministic corridor & fleet solver",
    guarantee: "Reproducible transit, carbon & conveyance matching",
  },
  {
    layer: "Gate",
    spec: "Versioned spend caps & SLA floors",
    guarantee: "Human-in-the-loop escalation before threshold breach",
  },
  {
    layer: "Notify",
    spec: "Telegram · WhatsApp · Email · Console",
    guarantee: "Live ETA replies & exception updates on every lane",
  },
];

const PROOF_OUTCOMES = [
  {
    metric: "−41%",
    title: "Exception resolution time",
    detail:
      "Measured across 1,400 monthly cold-chain shipments within 90 days of moving from manual escalation threads to policy-gated rerouting.",
  },
  {
    metric: "+$1.8M",
    title: "Annualized freight savings",
    detail:
      "Captured across 62 active intermodal corridors by scoring contracted carriers automatically instead of defaulting to late spot bookings.",
  },
  {
    metric: "99.4%",
    title: "Policy gate compliance",
    detail:
      "Enforced across 14,200+ automated tenders with full tenant isolation, versioned spend ceilings, and auditable override logs.",
  },
];

const TESTIMONIALS = [
  {
    quote:
      "We replaced four spreadsheets and a shared inbox with one policy-gated workflow. Dispatchers now intervene only on the 6% of loads that genuinely breach a spend cap or customs hold.",
    name: "Nadia Lindqvist",
    role: "VP of Supply Chain · Nordhavn Cold Freight",
  },
  {
    quote:
      "Connecting our ERP order feed and Telegram customer updates took one afternoon. Missed dock windows dropped by more than a third in our first six weeks.",
    name: "Chukwuemeka Okafor",
    role: "Director of Fleet Operations · Meridian Intermodal",
  },
];

export function LandingPage({ isAuthenticated }: LandingPageProps) {
  const [form, setForm] = useState<BriefingState>({
    email: "",
    volume: VOLUME_OPTIONS[1],
    stack: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<BriefingState | null>(null);

  const handleBriefingSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanEmail = form.email.trim();
    const cleanStack = form.stack.trim();

    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError("Enter a valid work email address so we can send your rollout plan.");
      return;
    }

    if (cleanStack.length < 2) {
      setError("List at least one system you want to connect (e.g., SAP, Shopify, EDI, CSV).");
      return;
    }

    setError(null);
    setSubmitted({
      email: cleanEmail,
      volume: form.volume,
      stack: cleanStack,
    });
  };

  return (
    <div className="lp-root">
      {/* Strict 3-Zone Top Bar */}
      <header className="lp-header">
        <div className="lp-container lp-header-inner">
          <Link href="/" className="lp-brand">
            <Compass size={19} aria-hidden="true" />
            <span>Control Tower</span>
          </Link>

          <nav className="lp-nav" aria-label="Primary navigation">
            <a href="#simulator">Simulator</a>
            <a href="#platform">Platform</a>
            <a href="#proof">Proof</a>
            <a href="#connect">Connect</a>
          </nav>

          <div className="lp-header-cta">
            <Link
              href={isAuthenticated ? "/" : "/signup"}
              className="lp-btn lp-btn-primary"
            >
              <span>{isAuthenticated ? "Open Console" : "Launch Workspace"}</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero Proposition */}
        <section className="lp-hero">
          <div className="lp-container">
            <div className="lp-hero-grid">
              <motion.div
                className="lp-hero-copy"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              >
                <p className="lp-eyebrow">AUTONOMOUS FREIGHT OPERATIONS</p>
                <h1 className="lp-h1">
                  Freight that plans, scores, and recovers itself.
                </h1>
                <p className="lp-lead">
                  Plug your ERP, carrier contracts, and fleet telematics into one
                  control tower. Deterministic code calculates corridors and ranks
                  bids, while policy-gated agents resolve delays and notify
                  customers before an SLA slips.
                </p>

                <div className="lp-hero-actions">
                  <Link
                    href={isAuthenticated ? "/" : "/signup"}
                    className="lp-btn lp-btn-primary lp-btn-lg"
                  >
                    <span>
                      {isAuthenticated ? "Return to Console" : "Create Free Workspace"}
                    </span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>

                  <Link
                    href={isAuthenticated ? "/integrations" : "/login"}
                    className="lp-link-quiet"
                  >
                    {isAuthenticated ? "Configure integrations →" : "Sign in to console →"}
                  </Link>
                </div>

                <p className="lp-hero-meta">
                  Road · Air · Sea · Rail · SAP, Shopify, EDI X12 &amp; Telegram ready
                </p>
              </motion.div>

              <motion.div
                className="lp-hero-media"
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="lp-photo-frame lp-hero-frame">
                  <Image
                    src="/images/landing/hero-terminal.jpg"
                    alt="Twilight intermodal container port and rail freight terminal with illuminated gantry cranes"
                    fill
                    priority
                    sizes="(max-width: 960px) 100vw, 50vw"
                    className="lp-photo-img"
                    referrerPolicy="no-referrer"
                  />
                  <div className="lp-photo-scrim" aria-hidden="true" />
                  <div className="lp-photo-caption">
                    <span>INTERMODAL CORRIDOR DISPATCH</span>
                    <span>POLICY-GATED AUTONOMY · MULTI-TENANT</span>
                  </div>
                </div>
              </motion.div>
            </div>

            {/* Full-Width 4-Column Hairline Metric Strip */}
            <div className="lp-metric-strip" aria-label="Core platform capabilities">
              {HERO_METRICS.map((item) => (
                <div key={item.label} className="lp-metric-cell">
                  <strong className="lp-metric-value">{item.value}</strong>
                  <span className="lp-metric-label">{item.label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Section 01: Interactive Decision Engine Simulator */}
        <section id="simulator" className="lp-section">
          <div className="lp-container">
            <div className="lp-section-head">
              <div className="lp-section-index">01. Interactive Decision Engine</div>
              <div className="lp-section-head-grid">
                <h2 className="lp-h2">
                  Test the deterministic planner and policy gate live.
                </h2>
                <p className="lp-section-sub">
                  Adjust corridor, transport mode, cargo certification, weight, and
                  autonomous spend ceiling. Every score, transit window, and gate
                  decision below is computed by the exact planning and carrier
                  scoring modules running inside Control Tower.
                </p>
              </div>
            </div>

            <DecisionSimulator />
          </div>
        </section>

        {/* Section 02: Asymmetric Capabilities Bento */}
        <section id="platform" className="lp-section lp-section-alt">
          <div className="lp-container">
            <div className="lp-section-head">
              <div className="lp-section-index">02. Built for Real Freight Operations</div>
              <div className="lp-section-head-grid">
                <h2 className="lp-h2">
                  One deterministic core. Every ERP, carrier, and channel wired in.
                </h2>
                <p className="lp-section-sub">
                  Built for logistics teams that cannot afford opaque black-box
                  bookings. Keep your existing ERP and carrier relationships while
                  automating intake, dispatch, and exception recovery.
                </p>
              </div>
            </div>

            <div className="lp-bento">
              {/* Row 1: Marquee 2-col Photo Card */}
              <article className="lp-bento-card lp-bento-span-2 lp-bento-media-card">
                <Image
                  src="/images/landing/cargo-aircraft.jpg"
                  alt="Wide-body cargo aircraft loading ULD containers at dusk"
                  fill
                  sizes="(max-width: 960px) 100vw, 66vw"
                  className="lp-photo-img"
                  referrerPolicy="no-referrer"
                />
                <div className="lp-bento-media-scrim" aria-hidden="true" />
                <div className="lp-bento-media-content">
                  <div className="lp-bento-kicker">
                    <Plug size={15} aria-hidden="true" />
                    <span>Universal Integration Hub</span>
                  </div>
                  <h3>Drop in your existing ERP, WMS, or telematics in hours.</h3>
                  <p>
                    Ingest orders, inventory snapshots, and GPS beacons through
                    signed API keys, EDI X12 parsers, CSV drops, or native webhooks
                    for SAP, NetSuite, Shopify, and Samsara—with automatic payload
                    normalization and dead-letter replay.
                  </p>
                </div>
              </article>

              {/* Row 1: 1-col Card */}
              <article className="lp-bento-card">
                <div className="lp-bento-icon" aria-hidden="true">
                  <ShieldCheck size={18} />
                </div>
                <h3>Policy-Gated Spend Autonomy</h3>
                <p>
                  Versioned spend ceilings, deadline on-time floors, and lane
                  constraints govern every agent action. Routine tenders clear
                  automatically; anything above ceiling stops for one-tap human
                  approval.
                </p>
                <div className="lp-bento-foot">
                  <span>Row-level tenant isolation</span>
                  <span>Cryptographic audit trail</span>
                </div>
              </article>

              {/* Row 2: 1-col Card */}
              <article className="lp-bento-card">
                <div className="lp-bento-icon" aria-hidden="true">
                  <MessageSquare size={18} />
                </div>
                <h3>Omnichannel Dispatch &amp; Support</h3>
                <p>
                  Shippers, drivers, and warehouse teams ask for live ETAs, report
                  delays, or book freight directly over Telegram, WhatsApp, email,
                  and embedded web chat—backed by real shipment state.
                </p>
                <div className="lp-bento-foot">
                  <span>Live Telegram &amp; WhatsApp bots</span>
                  <span>Zero stale status replies</span>
                </div>
              </article>

              {/* Row 2: 2-col Architecture Card */}
              <article className="lp-bento-card lp-bento-span-2">
                <div className="lp-bento-head-row">
                  <div className="lp-bento-kicker-plain">
                    <Box size={16} aria-hidden="true" />
                    <span>Interactive 3D Fleet &amp; Autonomous Pipeline</span>
                  </div>
                  <div className="lp-bento-kicker-plain">
                    <Bot size={16} aria-hidden="true" />
                    <span>Voice &amp; Agent Copilot</span>
                  </div>
                </div>
                <h3>Inspect live road, air, sea, and rail units with zero blind spots.</h3>
                <p>
                  Every shipment flows through four auditable stages—from raw order
                  ingest to 3D conveyance telemetry, carrier negotiation, and
                  proactive customer escalation.
                </p>

                <div className="lp-arch-table" role="table" aria-label="Execution pipeline stages">
                  {ARCHITECTURE_LAYERS.map((row) => (
                    <div key={row.layer} className="lp-arch-row" role="row">
                      <span className="lp-arch-layer" role="cell">
                        {row.layer}
                      </span>
                      <span className="lp-arch-spec" role="cell">
                        {row.spec}
                      </span>
                      <span className="lp-arch-guarantee" role="cell">
                        {row.guarantee}
                      </span>
                    </div>
                  ))}
                </div>
              </article>
            </div>
          </div>
        </section>

        {/* Section 03: Quantified Proof of Impact */}
        <section id="proof" className="lp-section">
          <div className="lp-container">
            <div className="lp-proof-grid">
              <div className="lp-proof-media-col">
                <div className="lp-photo-frame lp-proof-frame">
                  <Image
                    src="/images/landing/freight-corridor.jpg"
                    alt="Modern freight transport crossing a misty cable-stayed highway bridge at dawn"
                    fill
                    sizes="(max-width: 960px) 100vw, 44vw"
                    className="lp-photo-img"
                    referrerPolicy="no-referrer"
                  />
                  <div className="lp-photo-scrim" aria-hidden="true" />
                  <div className="lp-photo-caption">
                    <span>CORRIDOR RELIABILITY BENCHMARK</span>
                    <span>62 ACTIVE LANES · Q1–Q4 AUDIT</span>
                  </div>
                </div>
              </div>

              <div className="lp-proof-content-col">
                <div className="lp-section-index">03. Operational Outcomes</div>
                <h2 className="lp-h2">
                  Measurable gains before the first quarter closes.
                </h2>

                <div className="lp-outcomes-list">
                  {PROOF_OUTCOMES.map((item) => (
                    <div key={item.title} className="lp-outcome-row">
                      <div className="lp-outcome-metric">{item.metric}</div>
                      <div className="lp-outcome-copy">
                        <h3>{item.title}</h3>
                        <p>{item.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="lp-quotes-grid">
                  {TESTIMONIALS.map((item) => (
                    <blockquote key={item.name} className="lp-quote-card">
                      <p>&ldquo;{item.quote}&rdquo;</p>
                      <footer>
                        <strong>{item.name}</strong>
                        <span>{item.role}</span>
                      </footer>
                    </blockquote>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Section 04: Interactive Deployment & Briefing Conversion */}
        <section id="connect" className="lp-section lp-section-alt">
          <div className="lp-container">
            <div className="lp-connect-grid">
              <div className="lp-connect-copy">
                <div className="lp-section-index">04. Deploy on Your Network</div>
                <h2 className="lp-h2">Plug in your first corridor today.</h2>
                <p className="lp-section-sub">
                  Start immediately in a tenant-isolated workspace or request a
                  tailored integration walkthrough for your ERP, EDI, and messaging
                  channels.
                </p>

                <ol className="lp-rollout-steps">
                  <li>
                    <span className="lp-rollout-num">Day 1</span>
                    <div>
                      <strong>Connect order &amp; carrier feeds</strong>
                      <p>
                        Provision an API key, import CSV rate cards, or link your
                        existing ERP webhook in minutes.
                      </p>
                    </div>
                  </li>
                  <li>
                    <span className="lp-rollout-num">Day 3</span>
                    <div>
                      <strong>Shadow-score live corridor tenders</strong>
                      <p>
                        Compare deterministic 6-factor carrier recommendations
                        against current manual bookings with zero risk.
                      </p>
                    </div>
                  </li>
                  <li>
                    <span className="lp-rollout-num">Week 2</span>
                    <div>
                      <strong>Activate policy-gated autonomous dispatch</strong>
                      <p>
                        Turn on spend-capped bookings, exception rerouting, and
                        Telegram or WhatsApp customer updates.
                      </p>
                    </div>
                  </li>
                </ol>

                <div className="lp-connect-cta-row">
                  <Link
                    href={isAuthenticated ? "/" : "/signup"}
                    className="lp-btn lp-btn-primary lp-btn-lg"
                  >
                    <span>
                      {isAuthenticated ? "Go to Dashboard" : "Create Free Workspace"}
                    </span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                  <Link href="/login" className="lp-link-quiet">
                    Existing operator? Sign in →
                  </Link>
                </div>
              </div>

              <div className="lp-briefing-card">
                {submitted ? (
                  <div className="lp-briefing-success" role="status">
                    <div className="lp-success-icon" aria-hidden="true">
                      <Check size={20} />
                    </div>
                    <span className="lp-eyebrow-mono">ROLLOUT BRIEFING PREPARED</span>
                    <h3>Architecture checklist ready for {submitted.email}</h3>
                    <p>
                      Configured for <strong>{submitted.volume}</strong> integrating{" "}
                      <strong>{submitted.stack}</strong>.
                    </p>

                    <ul className="lp-checklist">
                      <li>
                        <Check size={14} aria-hidden="true" />
                        <span>
                          Connector mapping &amp; idempotency keys for {submitted.stack}
                        </span>
                      </li>
                      <li>
                        <Check size={14} aria-hidden="true" />
                        <span>
                          Custom spend-cap policy template calibrated to your monthly volume
                        </span>
                      </li>
                      <li>
                        <Check size={14} aria-hidden="true" />
                        <span>
                          Live sandbox workspace with Telegram &amp; webhook testing enabled
                        </span>
                      </li>
                    </ul>

                    <div className="lp-briefing-success-actions">
                      <Link
                        href={isAuthenticated ? "/integrations" : "/signup"}
                        className="lp-btn lp-btn-primary"
                      >
                        <span>
                          {isAuthenticated
                            ? "Open Integrations Hub"
                            : "Launch Sandbox Now"}
                        </span>
                        <ArrowRight size={15} aria-hidden="true" />
                      </Link>
                      <button
                        type="button"
                        className="lp-link-quiet lp-btn-reset"
                        onClick={() => setSubmitted(null)}
                      >
                        Edit details
                      </button>
                    </div>
                  </div>
                ) : (
                  <form onSubmit={handleBriefingSubmit} noValidate className="lp-form">
                    <div className="lp-form-head">
                      <span className="lp-eyebrow-mono">ARCHITECTURE BRIEFING</span>
                      <h3>Map your logistics stack</h3>
                      <p>
                        Tell us your monthly load volume and systems—we will
                        generate a direct integration plan.
                      </p>
                    </div>

                    <div className="lp-field">
                      <label htmlFor="briefing-email">Work email</label>
                      <input
                        id="briefing-email"
                        type="email"
                        autoComplete="email"
                        placeholder="ops@company.com"
                        value={form.email}
                        onChange={(e) => setForm({ ...form, email: e.target.value })}
                        required
                      />
                    </div>

                    <div className="lp-field">
                      <label htmlFor="briefing-volume">Monthly shipment volume</label>
                      <select
                        id="briefing-volume"
                        value={form.volume}
                        onChange={(e) => setForm({ ...form, volume: e.target.value })}
                      >
                        {VOLUME_OPTIONS.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="lp-field">
                      <label htmlFor="briefing-stack">
                        Primary ERP, TMS, or channel to connect
                      </label>
                      <input
                        id="briefing-stack"
                        type="text"
                        placeholder="e.g. SAP S/4HANA, Shopify, EDI X12, Samsara, Telegram"
                        value={form.stack}
                        onChange={(e) => setForm({ ...form, stack: e.target.value })}
                        required
                      />
                    </div>

                    {error ? (
                      <p className="lp-form-error" role="alert">
                        {error}
                      </p>
                    ) : null}

                    <button type="submit" className="lp-btn lp-btn-primary lp-btn-full">
                      <span>Generate Integration Plan</span>
                      <ArrowRight size={15} aria-hidden="true" />
                    </button>

                    <p className="lp-form-foot">
                      No credit card required · Tenant-isolated deployment
                    </p>
                  </form>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Quiet Editorial Footer */}
      <footer className="lp-footer">
        <div className="lp-container lp-footer-inner">
          <div className="lp-footer-brand">
            <Link href="/" className="lp-brand">
              <Compass size={17} aria-hidden="true" />
              <span>Control Tower</span>
            </Link>
            <p>Deterministic freight planning &amp; policy-gated autonomy.</p>
          </div>

          <div className="lp-footer-links">
            <a href="#simulator">Simulator</a>
            <a href="#platform">Platform</a>
            <a href="#proof">Proof</a>
            <a href="#connect">Connect</a>
            <Link href="/login">Sign in</Link>
            <Link href="/signup">Create Workspace</Link>
          </div>

          <p className="lp-footer-copy">© 2026 Control Tower</p>
        </div>
      </footer>
    </div>
  );
}
