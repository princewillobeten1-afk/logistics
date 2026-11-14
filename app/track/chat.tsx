"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  askQuestion,
  conversation,
  lookupShipment,
  type ChatTurn,
  type TrackResult,
} from "@/app/track/actions";

const TRACK_SUGGESTIONS = [
  "Where is my shipment?",
  "Why is it delayed?",
  "When will it arrive?",
  "Who is delivering it?",
];

const BOOKING_SUGGESTIONS = [
  "I want to book a new shipment",
  "Send 50 cartons of electronics (450 kg) from Ikeja, Lagos to Garki, Abuja",
];

function when(iso: string | null): string {
  if (!iso) return "not yet confirmed";
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TrackChat({ initialReference }: { initialReference?: string }) {
  const [reference, setReference] = useState(initialReference ?? "");
  const [shipment, setShipment] = useState<TrackResult | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [pending, startTransition] = useTransition();
  const [sessionKey] = useState(
    () => `portal:${Math.random().toString(36).slice(2, 10)}`,
  );
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns, waiting]);

  // Poll for the Python worker's support.reply and any delegated support.create_shipment
  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    let attempts = 0;

    const tick = async () => {
      attempts += 1;
      const latest = await conversation(shipment?.reference ?? "", sessionKey);
      if (cancelled) return;

      if (latest.activeReference && (!shipment || shipment.reference !== latest.activeReference)) {
        const created = await lookupShipment(latest.activeReference);
        if (!cancelled && created) {
          setShipment(created);
          setReference(created.reference);
        }
      }

      const replied =
        latest.turns.length > turns.length &&
        latest.turns.at(-1)?.role === "agent";
      if (replied) {
        setTurns(latest.turns);
        setWaiting(false);
        return;
      }
      if (attempts > 25) {
        setWaiting(false);
        setError(
          "No reply yet. Make sure the background worker (`logistics worker`) is running so the Customer Support Agent can process the message.",
        );
        return;
      }
      setTimeout(tick, 1000);
    };

    const timer = setTimeout(tick, 800);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [waiting, shipment, turns.length, sessionKey]);

  function track(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const found = await lookupShipment(reference);
      if (!found) {
        setShipment(null);
        setError("We could not find that reference. Check it and try again.");
        return;
      }
      setShipment(found);
      const conv = await conversation(found.reference, sessionKey);
      setTurns(conv.turns);
    });
  }

  function send(text: string) {
    if (!text.trim()) return;
    const asked = text.trim();
    setQuestion("");
    setError(null);
    setTurns((prev) => [
      ...prev,
      { role: "customer", text: asked, at: new Date().toISOString() },
    ]);

    startTransition(async () => {
      const result = await askQuestion(
        shipment?.reference ?? "",
        asked,
        sessionKey,
      );
      if (!result.ok) {
        setError(result.error ?? "Could not send that.");
        return;
      }
      setWaiting(true);
    });
  }

  const activeSuggestions = shipment ? TRACK_SUGGESTIONS : BOOKING_SUGGESTIONS;

  return (
    <div className="track">
      <form onSubmit={track} className="track-form">
        <label htmlFor="track-reference" className="visually-hidden">
          Shipment reference
        </label>
        <input
          id="track-reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Shipment reference (e.g. 0576420 or DEMO-001) — or chat below to book a new shipment"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button type="submit" disabled={pending}>
          {pending && !shipment ? "Looking…" : "Track"}
        </button>
      </form>

      {error ? (
        <p className="track-error" role="alert">
          {error}
        </p>
      ) : null}

      {shipment ? (
        <section className="track-card" data-delayed={shipment.delayed}>
          <header>
            <span className="ref">{shipment.reference}</span>
            <span className="status">{shipment.status}</span>
          </header>
          <dl>
            <div>
              <dt>From</dt>
              <dd>{shipment.origin ?? "—"}</dd>
            </div>
            <div>
              <dt>To</dt>
              <dd>{shipment.destination ?? "—"}</dd>
            </div>
            <div>
              <dt>Promised</dt>
              <dd>{when(shipment.promised_by)}</dd>
            </div>
            <div>
              <dt>Estimated</dt>
              <dd>{when(shipment.estimated_arrival)}</dd>
            </div>
            <div>
              <dt>Carrier</dt>
              <dd>{shipment.carrier ?? "not yet assigned"}</dd>
            </div>
            {shipment.quantity ? (
              <div>
                <dt>Items</dt>
                <dd>{shipment.quantity}</dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}

      <section className="chat">
        <div className="chat-log">
          {turns.length === 0 ? (
            <p className="chat-hint">
              {shipment
                ? "Ask anything about this shipment. Answers come from live tracking data."
                : "Chat with the Customer Support Agent to book a new shipment (registered automatically on WPCargo and delegated to the Orchestrator) or inquire about an existing order."}
            </p>
          ) : (
            turns.map((turn, i) => (
              <div key={i} className="bubble" data-role={turn.role}>
                {turn.text}
              </div>
            ))
          )}
          {waiting ? (
            <div className="bubble" data-role="agent" data-waiting="true">
              typing…
            </div>
          ) : null}
          <div ref={endRef} />
        </div>

        {turns.length === 0 ? (
          <div className="suggestions">
            {activeSuggestions.map((s) => (
              <button key={s} type="button" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        ) : null}

        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            send(question);
          }}
        >
          <label htmlFor="track-question" className="visually-hidden">
            Your message
          </label>
          <input
            id="track-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={
              shipment
                ? "Ask about your shipment…"
                : "Describe your shipment (sender, receiver, addresses, cargo, weight)…"
            }
            maxLength={1500}
          />
          <button type="submit" disabled={pending || waiting || !question.trim()}>
            Send
          </button>
        </form>
      </section>
    </div>
  );
}
