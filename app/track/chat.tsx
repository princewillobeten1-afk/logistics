"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  askQuestion,
  conversation,
  lookupShipment,
  type ChatTurn,
  type TrackResult,
} from "@/app/track/actions";

const TRACK_SUGGESTIONS = [
  "Where is my shipment right now?",
  "Why is it delayed and what is the updated ETA?",
  "Please expedite and optimize the route for faster delivery",
  "Who is the assigned carrier?",
];

const BOOKING_SUGGESTIONS = [
  "Book 45 cartons of electronics (450 kg) from Lagos to Abuja by Friday",
  "Where is shipment LG-82931?",
];

type ChannelMode = "WEBSITE_CHAT" | "WHATSAPP" | "TELEGRAM";

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
  const [channel, setChannel] = useState<ChannelMode>("WEBSITE_CHAT");
  const [reference, setReference] = useState(initialReference ?? "");
  const [shipment, setShipment] = useState<TrackResult | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [workNotice, setWorkNotice] = useState<{
    shipmentReference: string | null;
    orderReference: string | null;
  } | null>(null);
  const [pending, startTransition] = useTransition();
  const [sessionKey] = useState(
    () => `portal:${Math.random().toString(36).slice(2, 10)}`,
  );
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns, pending]);

  useEffect(() => {
    if (!initialReference) return;
    let active = true;
    (async () => {
      const found = await lookupShipment(initialReference);
      if (active && found) {
        setShipment(found);
        const conv = await conversation(found.reference, sessionKey, channel);
        if (active) setTurns(conv.turns);
      }
    })();
    return () => {
      active = false;
    };
  }, [initialReference, sessionKey, channel]);

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
      const conv = await conversation(found.reference, sessionKey, channel);
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
        `${channel.toLowerCase()}:${sessionKey}`,
        channel,
      );
      if (!result.ok) {
        setError(result.error ?? "Could not send that.");
        return;
      }

      if (result.reply) {
        setTurns((prev) => [
          ...prev,
          { role: "agent", text: result.reply!, at: new Date().toISOString() },
        ]);
      }

      if (result.reference) {
        const refreshed = await lookupShipment(result.reference);
        if (refreshed) {
          setShipment(refreshed);
          setReference(refreshed.reference);
        }
      }

      if (result.autonomousStarted || result.orderReference || result.reference) {
        setWorkNotice({
          shipmentReference: result.reference ?? null,
          orderReference: result.orderReference ?? null,
        });
      }
    });
  }

  const activeSuggestions = shipment ? TRACK_SUGGESTIONS : BOOKING_SUGGESTIONS;

  return (
    <div className="track">
      <div className="support-channel-bar" role="group" aria-label="Customer channel">
        <span className="support-channel-label">Channel</span>
        {(
          [
            ["WEBSITE_CHAT", "Website chat"],
            ["WHATSAPP", "WhatsApp"],
            ["TELEGRAM", "Telegram"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="support-channel-btn"
            aria-pressed={channel === key}
            onClick={() => setChannel(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={track} className="track-form">
        <label htmlFor="track-reference" className="visually-hidden">
          Shipment reference
        </label>
        <input
          id="track-reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Shipment reference (e.g. LG-82931) — or chat with AI Customer Support below"
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

      {workNotice?.shipmentReference || workNotice?.orderReference ? (
        <div className="intake-status" data-tone="ok" role="status">
          <span>
            Operations workflow started automatically
            {workNotice.orderReference ? ` · Order ${workNotice.orderReference}` : ""}
            {workNotice.shipmentReference
              ? ` · Shipment ${workNotice.shipmentReference}`
              : ""}
          </span>
          {workNotice.shipmentReference ? (
            <Link
              href={`/shipments/${encodeURIComponent(workNotice.shipmentReference)}`}
              className="auth-link"
            >
              Open shipment
            </Link>
          ) : null}
        </div>
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

      <section className="chat" aria-label="AI Customer Support Agent conversation">
        <div className="chat-log">
          {turns.length === 0 ? (
            <p className="chat-hint">
              {shipment
                ? "Ask anything about this shipment, request rerouting, or report a delivery issue."
                : "Chat with our AI Customer Support Agent to track cargo, book a new shipment, request route updates, or report issues across Website Chat, WhatsApp, and Telegram."}
            </p>
          ) : (
            turns.map((turn, i) => (
              <div key={i} className="bubble" data-role={turn.role}>
                {turn.text}
              </div>
            ))
          )}
          {pending ? (
            <div className="bubble" data-role="agent" data-waiting="true">
              Replying…
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
                ? "Ask about status, ETA, or request a route update…"
                : "Book a shipment (origin, destination, cargo, weight) or ask a question…"
            }
            maxLength={1500}
          />
          <button type="submit" disabled={pending || !question.trim()}>
            Send
          </button>
        </form>
      </section>
    </div>
  );
}
