"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BrainCircuit,
  Calculator,
  Loader2,
  Send,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { BiDynamicChart, ProvenanceTag } from "@/components/intelligence/bi-charts";
import type { BiPeriodDays, BiQueryResponse } from "@/lib/intelligence/types";

const EXECUTIVE_STARTER_PROMPTS = [
  "Give me an executive briefing across all 9 departments with top risks and cost-saving actions.",
  "Why is freight cost or spend trending this way, and which corridors cost the most?",
  "Compare our branches and warehouses on utilization, stockout risk, and dispatch lead time.",
  "Which customer accounts have the highest volume and active SLA delay risk?",
  "How are fleet utilization, driver HOS clocks, and CDL compliance performing?",
  "What is our 7-day predictive forecast for shipment volume, spend, and CO₂e emissions?",
];

export function BiNlqWorkspace({
  periodDays,
  queuedQuestion,
  onClearQueuedQuestion,
}: {
  periodDays: BiPeriodDays;
  queuedQuestion: string | null;
  onClearQueuedQuestion: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<BiQueryResponse[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const runQuery = async (promptText: string) => {
    const cleaned = promptText.trim();
    if (cleaned.length < 3 || loading) return;

    setLoading(true);
    setError(null);
    setQuestion(cleaned);

    try {
      const res = await fetch("/api/intelligence/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "ControlTowerBI",
        },
        body: JSON.stringify({ question: cleaned, periodDays }),
      });

      const payload = (await res.json()) as BiQueryResponse & { error?: string };
      if (!res.ok) {
        setError(payload.error ?? "Unable to process your business question.");
        return;
      }

      setHistory((prev) => [payload, ...prev].slice(0, 6));
      setQuestion("");
    } catch {
      setError("Network error while contacting Business Intelligence analyst.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (queuedQuestion) {
      const q = queuedQuestion;
      onClearQueuedQuestion();
      void runQuery(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedQuestion]);

  const latest = history[0] ?? null;

  return (
    <section
      id="bi-ai-analyst"
      className="bi-panel bi-nlq-section"
      aria-labelledby="bi-nlq-heading"
    >
      <div className="bi-panel-head">
        <div className="bi-panel-title-group">
          <div className="bi-title-with-icon">
            <BrainCircuit size={17} strokeWidth={2} className="bi-title-icon" aria-hidden="true" />
            <h2 id="bi-nlq-heading">Natural-Language AI Business Analyst</h2>
          </div>
          <p className="bi-panel-sub">
            Ask any cross-departmental business question in plain English. Every answer is grounded
            strictly in your live workspace records, enforces your role permissions, and separates
            verified facts from estimates and forecasts.
          </p>
        </div>
      </div>

      <form
        className="bi-nlq-form"
        onSubmit={(e) => {
          e.preventDefault();
          void runQuery(question);
        }}
      >
        <label htmlFor="bi-nlq-input" className="visually-hidden">
          Ask a business intelligence question
        </label>
        <input
          ref={inputRef}
          id="bi-nlq-input"
          type="text"
          className="bi-nlq-input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask e.g. Which corridors have the highest freight cost per load and SLA risk?"
          maxLength={600}
          disabled={loading}
        />
        <button
          type="submit"
          className="bi-btn-primary"
          disabled={loading || question.trim().length < 3}
        >
          {loading ? (
            <>
              <Loader2 size={15} className="bi-spin" aria-hidden="true" />
              <span>Analyzing…</span>
            </>
          ) : (
            <>
              <Send size={15} aria-hidden="true" />
              <span>Ask Analyst</span>
            </>
          )}
        </button>
      </form>

      <div className="bi-starter-grid" aria-label="Suggested executive questions">
        {EXECUTIVE_STARTER_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="bi-starter-btn"
            disabled={loading}
            onClick={() => void runQuery(prompt)}
          >
            <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
            <span>{prompt}</span>
          </button>
        ))}
      </div>

      {error ? (
        <div className="bi-error-banner" role="alert">
          <ShieldAlert size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {latest ? (
        <article className="bi-answer-card" aria-live="polite">
          <div className="bi-answer-header">
            <div className="bi-answer-q">
              <span className="bi-answer-kicker">Question</span>
              <h3>{latest.question}</h3>
            </div>
            <div className="bi-answer-badges">
              <span className="bi-engine-tag">
                {latest.answeredBy === "GEMINI_AI"
                  ? `AI Analyst${latest.modelUsed ? ` · ${latest.modelUsed}` : ""}`
                  : "Deterministic Analytics Engine"}
              </span>
              {latest.provenanceTags.map((tag) => (
                <ProvenanceTag key={tag} provenance={tag} />
              ))}
            </div>
          </div>

          <div className="bi-answer-summary">
            <p className="bi-summary-lead">{latest.summary}</p>
            <p className="bi-summary-body">{latest.explanation}</p>
          </div>

          {latest.accessNote ? (
            <div className="bi-access-note">
              <ShieldAlert size={14} aria-hidden="true" />
              <span>{latest.accessNote}</span>
            </div>
          ) : null}

          {latest.chart || latest.table ? (
            <div
              className={`bi-answer-visuals${latest.chart && latest.table ? " has-both" : ""}`}
            >
              {latest.chart ? <BiDynamicChart chart={latest.chart} /> : null}

              {latest.table ? (
                <div className="bi-dyn-table-wrap">
                  <div className="bi-dyn-chart-head">
                    <h4>{latest.table.title}</h4>
                    <ProvenanceTag provenance={latest.table.provenance} />
                  </div>
                  <div className="scroller" tabIndex={0} role="region" aria-label={latest.table.title}>
                    <table className="bi-table">
                      <thead>
                        <tr>
                          {latest.table.columns.map((col, idx) => (
                            <th key={idx} scope="col">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {latest.table.rows.map((row, rIdx) => (
                          <tr key={rIdx}>
                            {row.map((cell, cIdx) => (
                              <td key={cIdx}>{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {latest.formulasUsed.length > 0 ? (
            <div className="bi-formulas-block">
              <div className="bi-subhead-row">
                <Calculator size={14} aria-hidden="true" />
                <strong>Transparent calculations used</strong>
              </div>
              <ul>
                {latest.formulasUsed.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {latest.recommendations.length > 0 ? (
            <div className="bi-recs-block">
              <strong>Actionable recommendations</strong>
              <div className="bi-recs-list">
                {latest.recommendations.map((rec, i) => (
                  <div key={i} className="bi-rec-item">
                    <div className="bi-rec-head">
                      <span className={`bi-prio bi-prio-${rec.priority.toLowerCase()}`}>
                        {rec.priority}
                      </span>
                      <span className="bi-dept-tag">{rec.department}</span>
                      <ProvenanceTag provenance={rec.provenance} />
                      {rec.deepLink ? (
                        <Link href={rec.deepLink} className="bi-rec-link">
                          <span>Take action</span>
                          <ArrowUpRight size={13} aria-hidden="true" />
                        </Link>
                      ) : null}
                    </div>
                    <p className="bi-rec-action">{rec.action}</p>
                    <p className="bi-rec-impact">Expected impact: {rec.expectedImpact}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {latest.followUpQuestions.length > 0 ? (
            <div className="bi-followups">
              <span>Follow-up questions:</span>
              <div className="bi-followup-list">
                {latest.followUpQuestions.map((fq) => (
                  <button
                    key={fq}
                    type="button"
                    className="bi-followup-btn"
                    disabled={loading}
                    onClick={() => void runQuery(fq)}
                  >
                    <span>{fq}</span>
                    <ArrowRight size={13} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </article>
      ) : null}

      {history.length > 1 ? (
        <div className="bi-history-strip">
          <span>Recent queries:</span>
          {history.slice(1).map((item, idx) => (
            <button
              key={`${item.generatedAt}-${idx}`}
              type="button"
              className="bi-text-btn"
              onClick={() =>
                setHistory((prev) => [item, ...prev.filter((x) => x !== item)])
              }
            >
              {item.question.length > 58
                ? `${item.question.slice(0, 58)}…`
                : item.question}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
