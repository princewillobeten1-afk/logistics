"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import {
  askAssistant,
  assistantThread,
  clearThread,
  type AssistantTurn,
} from "./assistant-actions";

// Questions worth putting in front of someone who has not used this before.
// Chosen because each one needs joining up several tables — which is the whole
// case for asking rather than reading the panels below.
const SUGGESTIONS = [
  "Why is this delayed?",
  "What alternatives do we have?",
  "Has the customer been told?",
  "What is this waiting on?",
];

export function Assistant({ reference }: { reference: string }) {
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);

  const waiting = turns.some((t) => t.state === "PENDING");

  const refresh = useCallback(async () => {
    try {
      setTurns(await assistantThread(reference));
    } catch {
      // A failed poll is not worth interrupting anyone over; the next one
      // will most likely succeed, and the visible state is unchanged.
    }
  }, [reference]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only while an answer is outstanding. The worker picks the item up on
  // its own schedule, so there is nothing to watch once it has replied — and a
  // permanent interval on a page people leave open would be a slow leak of
  // queries all day.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns.length, waiting]);

  function send(question: string) {
    const text = question.trim();
    if (!text || pending) return;
    setError(null);
    setDraft("");
    startTransition(async () => {
      const result = await askAssistant(reference, text);
      if (!result.ok) setError(result.error ?? "Could not send that.");
      await refresh();
    });
  }

  return (
    <section className="assistant">
      <header>
        <div>
          <strong>Ask about this shipment</strong>
          <span>
            Reads the full internal picture — quotes, gate decisions, stuck work.
            It explains; it cannot change anything.
          </span>
        </div>
        {turns.length > 0 ? (
          <button
            type="button"
            className="assistant-clear"
            onClick={() =>
              startTransition(async () => {
                await clearThread(reference);
                await refresh();
              })
            }
          >
            Clear
          </button>
        ) : null}
      </header>

      <div className="assistant-log">
        {turns.length === 0 ? (
          <div className="assistant-empty">
            <p>Nothing asked yet. For example:</p>
            <div className="assistant-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn) => (
            <div key={turn.id} className="assistant-turn" data-role={turn.role}>
              {turn.state === "PENDING" ? (
                <p className="assistant-thinking">Reading the case notes…</p>
              ) : (
                <>
                  <p>{turn.body}</p>
                  {turn.next_step ? (
                    <p className="assistant-next">
                      <span>Suggested next step</span>
                      {turn.next_step}
                    </p>
                  ) : null}
                  {/* Low confidence is worth seeing. An answer the model is
                      unsure of reads exactly like one it is sure of. */}
                  {turn.role === "assistant" &&
                  turn.confidence !== null &&
                  Number(turn.confidence) < 0.6 ? (
                    <p className="assistant-caveat">
                      Low confidence ({Math.round(Number(turn.confidence) * 100)}%)
                      — check this against the panels below.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      {error ? (
        <p className="assistant-error" role="alert">
          {error}
        </p>
      ) : null}

      <form
        className="assistant-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <label htmlFor="assistant-question" className="visually-hidden">
          Question about shipment {reference}
        </label>
        <input
          id="assistant-question"
          name="question"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Why is this delayed?"
          disabled={pending}
          maxLength={1000}
          enterKeyHint="send"
        />
        <button type="submit" disabled={pending || !draft.trim()}>
          {pending ? "…" : "Ask"}
        </button>
      </form>
    </section>
  );
}
