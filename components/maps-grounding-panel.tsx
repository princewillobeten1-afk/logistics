"use client";

import { ExternalLink, Loader2, MapPin, MessageSquareQuote, Navigation, Send } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import { dispatchQuotaExceeded } from "@/components/maps-quota-banner";
import type { GroundedMapsSource } from "@/lib/maps-grounding";

export interface MapsGroundingContext {
  label: string;
  lat?: number;
  lng?: number;
  originCity?: string;
  destinationCity?: string;
  hubName?: string;
  modes?: string[];
}

export function MapsGroundingPanel({
  context,
  presets,
  title = "Corridor & Place Intelligence",
}: {
  context: MapsGroundingContext;
  presets?: string[];
  title?: string;
}) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<GroundedMapsSource[]>([]);
  const [lastQuery, setLastQuery] = useState<string | null>(null);

  const defaultPresets =
    presets && presets.length > 0
      ? presets
      : context.originCity && context.destinationCity
        ? [
            `Heavy truck fuel stops and rest staging yards between ${context.originCity} and ${context.destinationCity}`,
            `Major highway junctions and logistics hubs along the ${context.originCity} to ${context.destinationCity} corridor`,
            `Customs clearance offices and freight terminals near ${context.destinationCity}`,
          ]
        : [
            `Freight terminals, container yards, and customs hubs near ${context.hubName ?? context.label}`,
            `Heavy-duty diesel refueling and truck staging areas around ${context.hubName ?? context.label}`,
            `Cold-chain warehousing and bonded cargo facilities near ${context.hubName ?? context.label}`,
          ];

  async function runQuery(promptText: string) {
    const trimmed = promptText.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    setLastQuery(trimmed);

    try {
      const res = await fetch("/api/maps-grounding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: trimmed,
          originCity: context.originCity,
          destinationCity: context.destinationCity,
          hubName: context.hubName ?? context.label,
          modes: context.modes,
          lat: context.lat,
          lng: context.lng,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        text?: string;
        sources?: GroundedMapsSource[];
        error?: string;
        quotaSource?: "maps" | "gemini";
      };

      if (data.quotaSource === "maps") {
        dispatchQuotaExceeded();
      }

      if (!res.ok) {
        setError(data.error || "Unable to retrieve Google Maps insights.");
        return;
      }

      setAnswer(data.text ?? "");
      setSources(Array.isArray(data.sources) ? data.sources : []);
      setQuestion("");
    } catch {
      setError("Network error while querying Google Maps Grounding.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="grounding-panel" aria-label={title}>
      <header className="grounding-head">
        <div>
          <strong>
            <Navigation size={15} strokeWidth={2} aria-hidden="true" />
            <span>{title}</span>
          </strong>
          <span className="grounding-subtitle">
            Focus: <span className="font-mono">{context.label}</span>
            {typeof context.lat === "number" && typeof context.lng === "number"
              ? ` (${context.lat.toFixed(3)}, ${context.lng.toFixed(3)})`
              : ""}
          </span>
        </div>
        <span className="tag">Google Maps Grounded</span>
      </header>

      <div className="grounding-presets" role="group" aria-label="Suggested corridor queries">
        {defaultPresets.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={loading}
            onClick={() => void runQuery(preset)}
          >
            {preset}
          </button>
        ))}
      </div>

      <form
        className="grounding-form"
        onSubmit={(e) => {
          e.preventDefault();
          void runQuery(question);
        }}
      >
        <label htmlFor={`grounding-input-${title.replace(/\s+/g, "-")}`} className="visually-hidden">
          Ask about real-world places or routes near {context.label}
        </label>
        <input
          id={`grounding-input-${title.replace(/\s+/g, "-")}`}
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={`Ask about ports, truck stops, customs hubs, or roads near ${context.label}...`}
          disabled={loading}
          maxLength={600}
        />
        <button type="submit" disabled={loading || !question.trim()}>
          {loading ? (
            <>
              <Loader2 size={14} strokeWidth={2} className="spin" aria-hidden="true" />
              <span>Checking</span>
            </>
          ) : (
            <>
              <Send size={14} strokeWidth={2} aria-hidden="true" />
              <span>Lookup</span>
            </>
          )}
        </button>
      </form>

      {error ? (
        <p className="grounding-error" role="alert">
          {error}
        </p>
      ) : null}

      {answer ? (
        <div className="grounding-result">
          {lastQuery ? (
            <div className="grounding-query-echo">
              <span className="font-mono text-xs text-faint">Query:</span> {lastQuery}
            </div>
          ) : null}

          <div className="markdown-body">
            <Markdown>{answer}</Markdown>
          </div>

          {sources.length > 0 ? (
            <div className="grounding-sources">
              <div className="grounding-sources-title">
                <MapPin size={13} strokeWidth={2} aria-hidden="true" />
                <span>Grounded Google Maps Places ({sources.length})</span>
              </div>
              <ul className="grounding-links" role="list">
                {sources.map((src) => (
                  <li key={src.uri} className="grounding-source-card">
                    <a
                      href={src.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="grounding-source-link"
                    >
                      <span>{src.title}</span>
                      <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
                    </a>
                    {src.reviewSnippets.length > 0 ? (
                      <div className="grounding-snippets">
                        {src.reviewSnippets.slice(0, 2).map((snip, idx) => (
                          <div key={idx} className="grounding-snippet">
                            <MessageSquareQuote size={12} strokeWidth={2} aria-hidden="true" />
                            <span>
                              {snip.text ? `“${snip.text}”` : "Place review"}
                              {snip.author ? ` — ${snip.author}` : ""}
                              {snip.uri ? (
                                <>
                                  {" "}
                                  <a
                                    href={snip.uri}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    Read review
                                  </a>
                                </>
                              ) : null}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
