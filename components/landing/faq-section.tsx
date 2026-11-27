"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "lucide-react";

type FaqCategory = "All" | "Autonomous Technology" | "Spend Policies" | "System Integrations";

interface FaqItem {
  id: string;
  category: Exclude<FaqCategory, "All">;
  question: string;
  answer: string;
}

const CATEGORIES: FaqCategory[] = [
  "All",
  "Autonomous Technology",
  "Spend Policies",
  "System Integrations",
];

const FAQ_ITEMS: FaqItem[] = [
  {
    id: "deterministic-vs-ai",
    category: "Autonomous Technology",
    question: "Will AI ever invent freight rates or hallucinate a route?",
    answer:
      "Never. Route legs, fleet fit, and six-factor carrier scoring always run in deterministic code so quotes and ETAs are 100% repeatable. AI correlates incoming disruption signals and drafts communications strictly from those verified outputs.",
  },
  {
    id: "reroute-speed",
    category: "Autonomous Technology",
    question: "How fast does Control Tower catch and reroute a stalled load?",
    answer:
      "Within seconds of a GPS stall, EDI 214 delay notice, or driver check-in. The solver evaluates alternate modes and scores your contracted backup carriers immediately—booking any recovery that clears your spend and SLA rules.",
  },
  {
    id: "spend-caps",
    category: "Spend Policies",
    question: "Can an automated reroute ever book freight above our budget?",
    answer:
      "No. Every recovery tender passes through versioned spend ceilings and deadline floors before funds commit. If the winning quote costs a dollar over cap, Control Tower pauses execution and routes it to an approver.",
  },
  {
    id: "audit-trail",
    category: "Spend Policies",
    question: "What audit record does Finance get on every booking or override?",
    answer:
      "Every award and manual override saves the active policy version, all competing carrier quotes, the six-factor score breakdown, and who approved it—giving finance and procurement zero mystery invoices.",
  },
  {
    id: "tenant-isolation",
    category: "Spend Policies",
    question: "Are our carrier contracts and lane rates isolated from other shippers?",
    answer:
      "Yes. Row-level tenant isolation keeps your shipments, contracted rate cards, spend rules, and webhook logs strictly private to your organization.",
  },
  {
    id: "erp-integrations",
    category: "System Integrations",
    question: "Which ERPs, EDI feeds, and telematics tools connect out of the box?",
    answer:
      "Connect SAP S/4HANA, NetSuite, Shopify, Samsara, or custom back-office stacks via signed REST webhooks, native EDI X12 204/214 parsers, or dry-run validated CSV rate sheets.",
  },
  {
    id: "messaging-channels",
    category: "System Integrations",
    question: "How do drivers and buyers actually use Telegram and WhatsApp?",
    answer:
      "Drivers report gate congestion or temperature issues in two taps from Telegram or WhatsApp, while buyers pull live ETAs backed straight by shipment state—cutting routine status calls out of your shift.",
  },
  {
    id: "onboarding-timeline",
    category: "System Integrations",
    question: "How quickly can we test Control Tower without disrupting live lanes?",
    answer:
      "Connect one order feed or CSV rate card on day one and shadow-score live tenders alongside your current TMS. Most teams switch on policy-gated autonomous recovery within two weeks.",
  },
];

export function FaqSection() {
  const [selectedCategory, setSelectedCategory] = useState<FaqCategory>("All");
  const [openId, setOpenId] = useState<string | null>(FAQ_ITEMS[0].id);

  const visibleItems =
    selectedCategory === "All"
      ? FAQ_ITEMS
      : FAQ_ITEMS.filter((item) => item.category === selectedCategory);

  const handleCategoryChange = (category: FaqCategory) => {
    setSelectedCategory(category);
    const nextList =
      category === "All"
        ? FAQ_ITEMS
        : FAQ_ITEMS.filter((item) => item.category === category);
    if (nextList.length > 0 && !nextList.some((item) => item.id === openId)) {
      setOpenId(nextList[0].id);
    }
  };

  return (
    <div className="lp-faq-grid">
      <div className="lp-faq-intro">
        <div className="lp-section-index">05. Frequently Asked Questions</div>
        <h2 className="lp-h2">
          Technical and governance answers{" "}
          <span className="lp-h2-muted">before deployment.</span>
        </h2>
        <p className="lp-section-sub">
          What heads of operations, finance, and systems engineering evaluate
          before activating policy-gated recovery.
        </p>

        <div className="lp-faq-filters" role="tablist" aria-label="Filter questions by topic">
          {CATEGORIES.map((category) => {
            const active = selectedCategory === category;
            return (
              <motion.button
                key={category}
                type="button"
                role="tab"
                aria-selected={active}
                className={`lp-faq-filter-btn${active ? " is-active" : ""}`}
                initial={false}
                animate={{ opacity: active ? 1 : 0.88 }}
                whileHover={{ scale: 1.025, opacity: 1 }}
                whileTap={{ scale: 0.98 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                onClick={() => handleCategoryChange(category)}
              >
                {category}
              </motion.button>
            );
          })}
        </div>
      </div>

      <div className="lp-faq-list">
        {visibleItems.map((item) => {
          const isOpen = openId === item.id;
          const panelId = `faq-panel-${item.id}`;
          const buttonId = `faq-trigger-${item.id}`;

          return (
            <div
              key={item.id}
              className={`lp-faq-item${isOpen ? " is-open" : ""}`}
            >
              <button
                id={buttonId}
                type="button"
                className="lp-faq-trigger"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenId(isOpen ? null : item.id)}
              >
                <div className="lp-faq-question-wrap">
                  <span className="lp-faq-topic">{item.category}</span>
                  <span className="lp-faq-question">{item.question}</span>
                </div>
                <span className="lp-faq-chevron" aria-hidden="true">
                  <ChevronDown size={18} />
                </span>
              </button>

              <AnimatePresence initial={false}>
                {isOpen ? (
                  <motion.div
                    id={panelId}
                    role="region"
                    aria-labelledby={buttonId}
                    className="lp-faq-panel"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <div className="lp-faq-answer">
                      <p>{item.answer}</p>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}
