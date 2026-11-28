"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { ClientWhen } from "@/components/client-time";
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

type ChannelMode = "WEBSITE_CHAT" | "WHATSAPP" | "TELEGRAM";

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
  const [followUpTicks, setFollowUpTicks] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns, pending]);

  // Auto-load shipment details when linked via `/track?ref=...`
  useEffect(() => {
    if (!initialReference?.trim()) return;
    let active = true;
    void (async () => {
      const found = await lookupShipment(initialReference);
      if (active && found) {
        setShipment(found);
        const conv = await conversation(
          found.reference,
          `${channel.toLowerCase()}:${sessionKey}`,
          channel,
        );
        if (active) setTurns(conv.turns);
      }
    })();
    return () => {
      active = false;
    };
  }, [initialReference, sessionKey, channel]);

  // Quietly catch delegated `support.create_shipment` / WPCargo confirmations after reply.
  useEffect(() => {
    if (followUpTicks <= 0 || pending) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const latest = await conversation(
        shipment?.reference ?? "",
        `${channel.toLowerCase()}:${sessionKey}`,
        channel,
      );
      if (cancelled) return;
      const gotNewTurn = latest.turns.length > turns.length;
      if (gotNewTurn) {
        setTurns(latest.turns);
      }
      if (
        latest.activeReference &&
        (!shipment || shipment.reference !== latest.activeReference)
      ) {
        const created = await lookupShipment(latest.activeReference);
        if (!cancelled && created) {
          setShipment(created);
          setReference(created.reference);
          if (gotNewTurn) {
            setFollowUpTicks(0);
            return;
          }
        }
      }
      setFollowUpTicks((n) => Math.max(0, n - 1));
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [followUpTicks, pending, shipment, turns.length, sessionKey, channel]);

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
      const conv = await conversation(
        found.reference,
        `${channel.toLowerCase()}:${sessionKey}`,
        channel,
      );
      setTurns(conv.turns);
    });
  }

  function send(text: string) {
    if (!text.trim()) return;
    const asked = text.trim();
    setQuestion("");
    setError(null);
    setFollowUpTicks(0);
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

      let refreshed: TrackResult | null = null;
      if (result.reference) {
        refreshed = await lookupShipment(result.reference);
        if (refreshed) {
          setShipment(refreshed);
          setReference(refreshed.reference);
        }
      }

      const workflowStarted =
        Boolean(result.orderReference) ||
        (Boolean(result.autonomousStarted) && result.intent !== "TRACKING_INQUIRY");

      if (workflowStarted && (refreshed || result.orderReference)) {
        setWorkNotice({
          shipmentReference: refreshed?.reference ?? null,
          orderReference: result.orderReference ?? null,
        });
        setFollowUpTicks(8);
      } else if (workflowStarted) {
        setWorkNotice(null);
        setFollowUpTicks(8);
      } else {
        setWorkNotice(null);
        setFollowUpTicks(0);
      }
    });
  }

  const activeSuggestions = shipment ? TRACK_SUGGESTIONS : [];

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
          placeholder="Enter a shipment reference, or chat with AI Customer Support below"
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
              <dd>
                {shipment.promised_by ? (
                  <ClientWhen date={shipment.promised_by} />
                ) : (
                  "not yet confirmed"
                )}
              </dd>
            </div>
            <div>
              <dt>Estimated</dt>
              <dd>
                {shipment.estimated_arrival ? (
                  <ClientWhen date={shipment.estimated_arrival} />
                ) : (
                  "not yet confirmed"
                )}
              </dd>
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
