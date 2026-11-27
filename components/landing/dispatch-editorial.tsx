"use client";

import { useState, type FormEvent } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, Mail } from "lucide-react";

type DigestTabId = "corridors" | "benchmarks" | "playbooks";

interface DigestIssueSection {
  id: DigestTabId;
  tabLabel: string;
  issueLabel: string;
  headline: string;
  description: string;
  takeaways: { title: string; detail: string }[];
}

const DIGEST_SECTIONS: DigestIssueSection[] = [
  {
    id: "corridors",
    tabLabel: "Corridor Briefs",
    issueLabel: "Issue #42 · Weekly Corridor Digest",
    headline: "Real lane bottlenecks—and the exact detours that beat them",
    description:
      "Every Tuesday opens with three live lane teardowns showing how storms, port queues, and rail cutoffs moved freight across Europe and North America.",
    takeaways: [
      {
        title: "Rotterdam → Munich Rail Bypass",
        detail: "Shifted 18 reefer pallets onto Duisburg rail during A3 high winds, clawing back 3.2 hours against stalled highway lanes.",
      },
      {
        title: "Antwerp → Berlin Quay Turnaround",
        detail: "Automated EDI 315 triggers compressed short-sea rail transfer idle windows from 9.4 hours down to 5.2 hours.",
      },
      {
        title: "Alpine Pass Weather Buffers",
        detail: "Pre-scored winter axle detours added 45 minutes of margin automatically before morning dispatch rolled.",
      },
    ],
  },
  {
    id: "benchmarks",
    tabLabel: "Rate Benchmarks",
    issueLabel: "Issue #42 · Contract & Spot Variance",
    headline: "Where spot premiums spiked—and how contract scoring held margin",
    description:
      "See real contract-vs-spot spreads across modes alongside our six-factor bid math—built so procurement and finance catch rate drift early.",
    takeaways: [
      {
        title: "Reefer Spot vs. Contract Spread",
        detail: "Pre-scored EU cold-chain backups priced 11.4% below ad-hoc spot tenders whenever booked 14+ hours ahead.",
      },
      {
        title: "On-Time Weighting Impact",
        detail: "Shifting reliability weight from 25% to 40% cut late retail dock penalties by 28% on tight delivery windows.",
      },
      {
        title: "Carbon-Adjusted Rail Parity",
        detail: "Electric intermodal shuttles matched road pricing above 620 km while slashing CO₂e by 64%.",
      },
    ],
  },
  {
    id: "playbooks",
    tabLabel: "Policy Playbooks",
    issueLabel: "Issue #42 · Governance & Automation",
    headline: "Copy-paste spend caps and driver messaging rules from live teams",
    description:
      "Battle-tested approval ceilings, escalation rules, and Telegram/WhatsApp dispatch prompts ready to drop straight into your workspace.",
    takeaways: [
      {
        title: "Pre-Award Spend Guardrails",
        detail: "Cap templates that auto-clear recovery quotes within 12% of contract while pausing outliers for manager review.",
      },
      {
        title: "Two-Tap Driver Exception Flows",
        detail: "Telegram and WhatsApp check-ins that stamp gate delays straight onto live shipment timelines.",
      },
      {
        title: "Audit-Ready Override Logs",
        detail: "Clean score-comparison snapshots built for quarterly carrier QBRs and finance reconciliation.",
      },
    ],
  },
];

interface PhotoStory {
  id: string;
  image: string;
  alt: string;
  photoLabel: string;
  title: string;
  body: string;
  meta: string;
}

const PHOTO_STORIES: PhotoStory[] = [
  {
    id: "port-rail",
    image: "/images/landing/port-rail-interchange.jpg",
    alt: "Aerial view of automated gantry cranes transferring deep-sea containers onto electric railcars at a coastal freight terminal",
    photoLabel: "Port-to-Rail Quay · Morning Berth Transfer",
    title: "Cutting 4.2 hours of port rail dwell with live berth triggers",
    body: "Above: ship-to-shore cranes transferring deep-sea boxes straight onto electric railcars. The moment an EDI 315 discharge notice lands, Control Tower holds the rail slot and syncs drayage—wiping out the overnight yard fees profiled in Issue #41.",
    meta: "Short-Sea & Rail · Issue #41 · 4.2h average dwell saved",
  },
  {
    id: "cold-chain",
    image: "/images/landing/cold-chain-inspection.jpg",
    alt: "Logistics operations supervisor inspecting refrigerated cargo telemetry on a rugged tablet at a sunlit loading dock",
    photoLabel: "Cold-Chain Dock · Pre-Departure Inspection",
    title: "Catching a 0.8°C reefer drift before the trailer leaves the bay",
    body: "Above: a dock lead checks trailer probe telemetry on a rugged tablet before sealing outbound freight. Any drift past 0.8°C fires an immediate policy check, alerts the buyer on WhatsApp, and cues recovery capacity in dispatch.",
    meta: "Cold-Chain SLA · Issue #40 · 100% pre-departure audit",
  },
];

export function DispatchEditorialSection() {
  const [activeTab, setActiveTab] = useState<DigestTabId>("corridors");
  const [newsletterEmail, setNewsletterEmail] = useState("");
  const [newsletterError, setNewsletterError] = useState<string | null>(null);
  const [subscribedEmail, setSubscribedEmail] = useState<string | null>(null);

  const currentDigest =
    DIGEST_SECTIONS.find((section) => section.id === activeTab) ?? DIGEST_SECTIONS[0];

  const handleSubscribe = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = newsletterEmail.trim();
    if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      setNewsletterError("Enter a valid work email address to receive the weekly Dispatch.");
      return;
    }
    setNewsletterError(null);
    setSubscribedEmail(clean);
  };

  return (
    <div className="lp-dispatch-editorial">
      {/* Top 12-Col Spread: Large Feature Photo + Annotated Caption & Interactive Newsletter Preview */}
      <div className="lp-editorial-spread">
        <article className="lp-editorial-feature-card">
          <div className="lp-editorial-photo-wrap lp-editorial-photo-wide">
            <Image
              src="/images/landing/dispatch-operations.jpg"
              alt="Logistics coordinators at timber and steel desks reviewing multimodal corridor maps on dual monitors overlooking a container port at sunset"
              fill
              sizes="(max-width: 1024px) 100vw, 58vw"
              className="lp-photo-img"
              referrerPolicy="no-referrer"
            />
          </div>

          <div className="lp-editorial-feature-body">
            <div className="lp-photo-caption-kicker">
              Rotterdam Operations Desk · Sunset Shift Handover
            </div>
            <h3>
              Coordinating multi-leg handovers on verified telemetry, not inbox
              guesswork
            </h3>
            <p>
              In the operations room above, evening coordinators review live rail
              and highway corridors as deep-sea vessels berth. Rather than chasing
              fragmented broker emails, operators inspect scored reroutes, verify
              carrier rankings, and authorize above-cap exceptions in seconds.
            </p>
            <p>
              Every Tuesday, <strong>The Control Tower Dispatch</strong> distills
              production shift handovers like this one into concise, visual field
              briefings for operations and supply chain leaders.
            </p>
            <div className="lp-editorial-meta">
              <span>Inside Issue #42</span>
              <span aria-hidden="true">·</span>
              <span>Shift Handover Protocol</span>
              <span aria-hidden="true">·</span>
              <span>6 min read</span>
            </div>
          </div>
        </article>

        {/* Right Column: Interactive Newsletter Issue Preview + Subscription */}
        <aside
          className="lp-newsletter-panel"
          aria-label="Inside the Control Tower Dispatch newsletter"
        >
          <div className="lp-newsletter-head">
            <span className="lp-sub-label">Inside Issue #42</span>
            <h3>Weekly intelligence for freight leaders</h3>
            <p>
              Preview the three operational briefings inside every Tuesday
              edition—grounded in live corridor metrics and enforceable policy
              math.
            </p>
          </div>

          <div
            className="lp-newsletter-tabs"
            role="tablist"
            aria-label="Newsletter briefing sections"
          >
            {DIGEST_SECTIONS.map((section) => {
              const isActive = section.id === activeTab;
              return (
                <button
                  key={section.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`lp-newsletter-tab${isActive ? " is-active" : ""}`}
                  onClick={() => setActiveTab(section.id)}
                >
                  {section.tabLabel}
                </button>
              );
            })}
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={currentDigest.id}
              className="lp-newsletter-preview"
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="lp-newsletter-issue-meta">{currentDigest.issueLabel}</div>
              <h4>{currentDigest.headline}</h4>
              <p className="lp-newsletter-issue-desc">{currentDigest.description}</p>

              <ul className="lp-newsletter-takeaways">
                {currentDigest.takeaways.map((item) => (
                  <li key={item.title}>
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          </AnimatePresence>

          <div className="lp-newsletter-subscribe">
            {subscribedEmail ? (
              <div className="lp-newsletter-confirmed" role="status">
                <div className="lp-newsletter-confirmed-icon" aria-hidden="true">
                  <Check size={16} />
                </div>
                <div>
                  <strong>Subscribed to Control Tower Dispatch</strong>
                  <p>
                    Issue #43 will be delivered to <span>{subscribedEmail}</span> with
                    full {currentDigest.tabLabel.toLowerCase()} coverage.
                  </p>
                </div>
                <button
                  type="button"
                  className="lp-link-quiet lp-btn-reset"
                  onClick={() => {
                    setSubscribedEmail(null);
                    setNewsletterEmail("");
                  }}
                >
                  Change email
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubscribe} noValidate className="lp-newsletter-form">
                <label htmlFor="dispatch-newsletter-email" className="lp-newsletter-label">
                  Subscribe to the Tuesday Operations Briefing
                </label>
                <div className="lp-newsletter-input-row">
                  <div className="lp-newsletter-input-wrap">
                    <Mail size={15} className="lp-newsletter-input-icon" aria-hidden="true" />
                    <input
                      id="dispatch-newsletter-email"
                      type="email"
                      autoComplete="email"
                      placeholder="ops@company.com"
                      value={newsletterEmail}
                      onChange={(e) => setNewsletterEmail(e.target.value)}
                      required
                    />
                  </div>
                  <button type="submit" className="lp-btn lp-btn-primary">
                    <span>Subscribe to Dispatch</span>
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                </div>
                {newsletterError ? (
                  <p className="lp-form-error" role="alert">
                    {newsletterError}
                  </p>
                ) : (
                  <p className="lp-newsletter-note">
                    Published every Tuesday for freight and supply chain teams. Unsubscribe anytime.
                  </p>
                )}
              </form>
            )}
          </div>
        </aside>
      </div>

      {/* Bottom 2-Column Supporting Photographic Dispatches */}
      <div className="lp-photo-stories">
        {PHOTO_STORIES.map((story) => (
          <article key={story.id} className="lp-photo-story-card">
            <div className="lp-editorial-photo-wrap lp-editorial-photo-story">
              <Image
                src={story.image}
                alt={story.alt}
                fill
                sizes="(max-width: 760px) 100vw, 48vw"
                className="lp-photo-img"
                referrerPolicy="no-referrer"
              />
            </div>

            <div className="lp-photo-story-body">
              <div className="lp-photo-caption-kicker">{story.photoLabel}</div>
              <h3>{story.title}</h3>
              <p>{story.body}</p>
              <div className="lp-editorial-meta">{story.meta}</div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
