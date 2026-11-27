"use client";

import { useEffect, useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, Menu, X } from "lucide-react";
import { ArchitectureBento } from "./architecture-bento";
import { DispatchEditorialSection } from "./dispatch-editorial";
import { FaqSection } from "./faq-section";
import { HeroBackdrop } from "./hero-backdrop";
import { HeroMetricsStrip } from "./hero-metrics";
import { HeroWorkflowShowcase } from "./hero-workflow-showcase";
import { IntegrationsShowcase } from "./integrations-showcase";
import { TransformationStory } from "./transformation-story";

interface LandingPageProps {
  isAuthenticated: boolean;
}

interface BriefingState {
  email: string;
  volume: string;
  stack: string;
}

const VOLUME_OPTIONS = [
  "Under 500 shipments per month",
  "500 to 2,500 shipments per month",
  "2,500 to 10,000 shipments per month",
  "10,000+ shipments per month",
];

export function LandingPage({ isAuthenticated }: LandingPageProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [form, setForm] = useState<BriefingState>({
    email: "",
    volume: VOLUME_OPTIONS[1],
    stack: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<BriefingState | null>(null);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    const onResize = () => {
      if (window.innerWidth > 860) setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [mobileNavOpen]);

  const handleBriefingSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanEmail = form.email.trim();
    const cleanStack = form.stack.trim();

    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError("Enter a valid work email address so we can prepare your rollout plan.");
      return;
    }

    if (cleanStack.length < 2) {
      setError("List at least one system you want to connect, such as SAP, Shopify, EDI, or CSV.");
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
            <span className="lp-brand-mark">
              <Image
                src="/images/landing/control-tower-logo.jpg"
                alt="Control Tower logo"
                width={32}
                height={32}
                priority
                className="lp-brand-mark-img"
                referrerPolicy="no-referrer"
              />
            </span>
            <span>Control Tower</span>
          </Link>

          <nav className="lp-nav" aria-label="Primary navigation">
            <a href="#transformation">Why Switch</a>
            <a href="#integrations">Integrations</a>
            <a href="#governance">Architecture</a>
            <a href="#dispatch">Dispatch</a>
            <a href="#faq">FAQ</a>
          </nav>

          <div className="lp-header-cta">
            <Link
              href={isAuthenticated ? "/" : "/signup"}
              className="lp-btn lp-btn-primary lp-header-primary-btn"
            >
              <span>{isAuthenticated ? "Open Console" : "Launch Workspace"}</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Link>

            <button
              type="button"
              className="lp-mobile-toggle"
              aria-expanded={mobileNavOpen}
              aria-controls="lp-mobile-menu"
              aria-label={mobileNavOpen ? "Close navigation menu" : "Open navigation menu"}
              onClick={() => setMobileNavOpen((prev) => !prev)}
            >
              {mobileNavOpen ? (
                <X size={20} aria-hidden="true" />
              ) : (
                <Menu size={20} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {mobileNavOpen ? (
            <motion.nav
              id="lp-mobile-menu"
              className="lp-mobile-drawer"
              aria-label="Mobile navigation"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="lp-container lp-mobile-drawer-inner">
                <div className="lp-mobile-links">
                  <a href="#workflows" onClick={() => setMobileNavOpen(false)}>
                    Live Workflows
                  </a>
                  <a href="#transformation" onClick={() => setMobileNavOpen(false)}>
                    Why Teams Switch
                  </a>
                  <a href="#integrations" onClick={() => setMobileNavOpen(false)}>
                    ERP &amp; Carrier Integrations
                  </a>
                  <a href="#governance" onClick={() => setMobileNavOpen(false)}>
                    Governance &amp; Architecture
                  </a>
                  <a href="#dispatch" onClick={() => setMobileNavOpen(false)}>
                    Operations &amp; Weekly Dispatch
                  </a>
                  <a href="#faq" onClick={() => setMobileNavOpen(false)}>
                    Frequently Asked Questions
                  </a>
                </div>

                <div className="lp-mobile-actions">
                  <Link
                    href={isAuthenticated ? "/" : "/signup"}
                    className="lp-btn lp-btn-primary lp-btn-full"
                    onClick={() => setMobileNavOpen(false)}
                  >
                    <span>{isAuthenticated ? "Open Console" : "Create Free Workspace"}</span>
                    <ArrowRight size={15} aria-hidden="true" />
                  </Link>
                  <Link
                    href={isAuthenticated ? "/integrations" : "/login"}
                    className="lp-mobile-secondary-link"
                    onClick={() => setMobileNavOpen(false)}
                  >
                    {isAuthenticated ? "Configure integrations" : "Sign in to existing console"}
                  </Link>
                </div>
              </div>
            </motion.nav>
          ) : null}
        </AnimatePresence>
      </header>

      <main>
        {/* Editorial Hero + Architectural Bezel Obsidian Product Stage */}
        <section id="workflows" className="lp-hero">
          <HeroBackdrop />

          <div className="lp-container">
            <motion.div
              className="lp-hero-intro"
              initial="hidden"
              animate="visible"
              variants={{
                hidden: {},
                visible: {
                  transition: {
                    staggerChildren: 0.065,
                  },
                },
              }}
            >
              <motion.p
                className="lp-eyebrow"
                variants={{
                  hidden: { opacity: 0, y: 10 },
                  visible: {
                    opacity: 1,
                    y: 0,
                    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
                  },
                }}
              >
                Enterprise Freight Orchestration · SAP, EDI X12 &amp; Fleet Telematics
              </motion.p>
              <motion.h1
                className="lp-h1"
                variants={{
                  hidden: { opacity: 0, y: 14 },
                  visible: {
                    opacity: 1,
                    y: 0,
                    transition: { duration: 0.56, ease: [0.22, 1, 0.36, 1] },
                  },
                }}
              >
                Never pay spot premiums{" "}
                <span className="lp-h1-muted">for a preventable delay.</span>
              </motion.h1>
              <motion.p
                className="lp-lead"
                variants={{
                  hidden: { opacity: 0, y: 14 },
                  visible: {
                    opacity: 1,
                    y: 0,
                    transition: { duration: 0.56, ease: [0.22, 1, 0.36, 1] },
                  },
                }}
              >
                Control Tower unifies your ERP orders, carrier rate cards, live
                GPS, and weather hazards on one operational plane—scoring
                contracted backup lanes in seconds and executing recoveries
                strictly inside your approved spend ceilings.
              </motion.p>

              <motion.div
                className="lp-hero-actions"
                variants={{
                  hidden: { opacity: 0, y: 12 },
                  visible: {
                    opacity: 1,
                    y: 0,
                    transition: { duration: 0.52, ease: [0.22, 1, 0.36, 1] },
                  },
                }}
              >
                <Link
                  href={isAuthenticated ? "/" : "/signup"}
                  className="lp-btn lp-btn-primary lp-btn-lg"
                >
                  <span>
                    {isAuthenticated ? "Open Live Console" : "Start Free Workspace"}
                  </span>
                  <ArrowRight size={16} aria-hidden="true" />
                </Link>

                <Link
                  href={isAuthenticated ? "/integrations" : "/login"}
                  className="lp-link-quiet"
                >
                  <span>{isAuthenticated ? "Configure Integrations" : "Sign In to Console"}</span>
                  <ArrowRight size={14} aria-hidden="true" />
                </Link>
              </motion.div>
            </motion.div>

            <HeroMetricsStrip />

            <motion.div
              className="lp-hero-stage-wrap"
              initial={{ opacity: 0, y: 24, scale: 0.988 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.65, delay: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <HeroWorkflowShowcase />
            </motion.div>
          </div>
        </section>

        {/* Section 01: Problem Agitation & Before/After Transformation Story */}
        <section id="transformation" className="lp-section lp-section-alt">
          <div className="lp-container">
            <div className="lp-section-head">
              <div className="lp-section-index">01. Operational &amp; Margin Impact</div>
              <div className="lp-section-head-grid">
                <h2 className="lp-h2">
                  The hidden cost of manual dispatch{" "}
                  <span className="lp-h2-muted">across high-stakes lanes.</span>
                </h2>
                <p className="lp-section-sub">
                  When weather closes a corridor or a vessel berths late,
                  disconnected portals push teams into reactive spot tenders and
                  missed receiving windows. Compare legacy exception handling
                  with Control Tower across three real lanes.
                </p>
              </div>
            </div>

            <TransformationStory isAuthenticated={isAuthenticated} />
          </div>
        </section>

        {/* Section 02: Tabbed ERP, EDI & Carrier Integration Showcase */}
        <section id="integrations" className="lp-section">
          <div className="lp-container">
            <div className="lp-section-head">
              <div className="lp-section-index">02. Enterprise System Integration</div>
              <div className="lp-section-head-grid">
                <h2 className="lp-h2">
                  Unify your existing logistics stack{" "}
                  <span className="lp-h2-muted">without replacing your ERP.</span>
                </h2>
                <p className="lp-section-sub">
                  Stream purchase orders, EDI load tenders, fleet telematics,
                  and dispatch channels through schema-validated adapters with
                  idempotent ingestion and full audit replay.
                </p>
              </div>
            </div>

            <IntegrationsShowcase isAuthenticated={isAuthenticated} />
          </div>
        </section>

        {/* Section 03: Deep Obsidian Multimodal Bento & Governance Showcase */}
        <section id="governance" className="lp-section lp-section-dark">
          <div className="lp-dark-section-glow" aria-hidden="true" />
          <div className="lp-container">
            <div className="lp-section-head">
              <div className="lp-section-index">03. Deterministic Core &amp; Governance</div>
              <div className="lp-section-head-grid">
                <h2 className="lp-h2">
                  Built for operational speed.{" "}
                  <span className="lp-h2-muted">Governed for financial audit.</span>
                </h2>
                <p className="lp-section-sub">
                  Corridor routing and carrier scoring run in reproducible
                  application code, while versioned pre-award spend ceilings
                  protect every dollar committed.
                </p>
              </div>
            </div>

            <ArchitectureBento />
          </div>
        </section>

        {/* Section 04: Field Operations Photography & Weekly Dispatch Newsletter */}
        <section id="dispatch" className="lp-section lp-section-alt">
          <div className="lp-container">
            <div className="lp-section-head">
              <div className="lp-section-index">04. Field Operations &amp; Weekly Dispatch</div>
              <div className="lp-section-head-grid">
                <h2 className="lp-h2">
                  Production corridor teardowns,{" "}
                  <span className="lp-h2-muted">documented every Tuesday.</span>
                </h2>
                <p className="lp-section-sub">
                  Our weekly operations briefing examines real port-to-rail
                  handovers, cold-chain compliance audits, contract-versus-spot
                  benchmarks, and enforceable spend rules.
                </p>
              </div>
            </div>

            <DispatchEditorialSection />
          </div>
        </section>

        {/* Section 05: Frequently Asked Questions */}
        <section id="faq" className="lp-section">
          <div className="lp-container">
            <FaqSection />
          </div>
        </section>

        {/* Section 06: Deployment & Briefing Conversion */}
        <section id="connect" className="lp-section lp-section-alt">
          <div className="lp-container">
            <div className="lp-connect-grid">
              <div className="lp-connect-copy">
                <div className="lp-section-index">06. Rapid Network Deployment</div>
                <h2 className="lp-h2">
                  Deploy across priority lanes{" "}
                  <span className="lp-h2-muted">in under two weeks.</span>
                </h2>
                <p className="lp-section-sub">
                  Start by shadow-scoring live tenders alongside your existing
                  TMS in a tenant-isolated workspace, or outline your stack to
                  generate a tailored connector rollout sequence.
                </p>

                <ol className="lp-rollout-steps">
                  <li>
                    <span className="lp-rollout-num">Step 1</span>
                    <div>
                      <strong>Connect order feeds &amp; rate cards</strong>
                      <p>
                        Provision scoped API credentials, validate CSV carrier
                        tariffs in dry-run mode, or bind your ERP webhooks.
                      </p>
                    </div>
                  </li>
                  <li>
                    <span className="lp-rollout-num">Step 2</span>
                    <div>
                      <strong>Establish policy ceilings &amp; escalation</strong>
                      <p>
                        Define lane-level spend caps, SLA deadline floors, and
                        operator approval gates before activating live tenders.
                      </p>
                    </div>
                  </li>
                  <li>
                    <span className="lp-rollout-num">Step 3</span>
                    <div>
                      <strong>Enable policy-gated recovery</strong>
                      <p>
                        Score backup carriers deterministically, intercept
                        corridor delays early, and maintain complete finance
                        auditability.
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
                      {isAuthenticated ? "Open Live Console" : "Start Free Workspace"}
                    </span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                  <Link href="/login" className="lp-link-quiet">
                    <span>Existing operator? Sign in</span>
                    <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                </div>
              </div>

              <div className="lp-briefing-card">
                {submitted ? (
                  <div className="lp-briefing-success" role="status">
                    <div className="lp-success-icon" aria-hidden="true">
                      <Check size={20} />
                    </div>
                    <span className="lp-sub-label">Rollout Checklist Ready</span>
                    <h3>Integration outline prepared for {submitted.email}</h3>
                    <p>
                      Configured for <strong>{submitted.volume}</strong> integrating{" "}
                      <strong>{submitted.stack}</strong>.
                    </p>

                    <ul className="lp-checklist">
                      <li>
                        <Check size={14} aria-hidden="true" />
                        <span>
                          Connector mapping and idempotency keys for {submitted.stack}
                        </span>
                      </li>
                      <li>
                        <Check size={14} aria-hidden="true" />
                        <span>
                          Spend-cap policy configuration matched to your shipment volume
                        </span>
                      </li>
                      <li>
                        <Check size={14} aria-hidden="true" />
                        <span>
                          Tenant-isolated workspace ready for live webhooks and channel bots
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
                            : "Create Workspace"}
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
                      <span className="lp-sub-label">Integration Architecture Plan</span>
                      <h3>Request your rollout checklist</h3>
                      <p>
                        Provide your monthly shipment volume and core logistics
                        systems to generate a scoped connector, idempotency, and
                        policy-cap sequence.
                      </p>
                    </div>

                    <div className="lp-field">
                      <label htmlFor="briefing-email">Work email</label>
                      <input
                        id="briefing-email"
                        type="email"
                        autoComplete="email"
                        placeholder="you@company.com"
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
                        placeholder="SAP, NetSuite, EDI X12, Samsara, Telegram"
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
                      <span>Request Integration Blueprint</span>
                      <ArrowRight size={15} aria-hidden="true" />
                    </button>

                    <p className="lp-form-foot">
                      Clean tenant-isolated workspace provisioned immediately upon signup.
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
              <span className="lp-brand-mark lp-brand-mark-sm">
                <Image
                  src="/images/landing/control-tower-logo.jpg"
                  alt="Control Tower logo"
                  width={26}
                  height={26}
                  className="lp-brand-mark-img"
                  referrerPolicy="no-referrer"
                />
              </span>
              <span>Control Tower</span>
            </Link>
            <p>Deterministic freight orchestration and policy-gated recovery.</p>
          </div>

          <div className="lp-footer-links">
            <a href="#workflows">Workflows</a>
            <a href="#transformation">Why Switch</a>
            <a href="#integrations">Integrations</a>
            <a href="#governance">Architecture</a>
            <a href="#dispatch">Dispatch</a>
            <a href="#faq">FAQ</a>
            <Link href="/login">Sign in</Link>
            <Link href="/signup">Create Workspace</Link>
          </div>

          <p className="lp-footer-copy">© 2026 Control Tower</p>
        </div>
      </footer>
    </div>
  );
}
