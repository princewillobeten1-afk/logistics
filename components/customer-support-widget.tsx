"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MessageSquare, Send, X } from "lucide-react";

type ChannelMode = "WEBSITE_CHAT" | "WHATSAPP" | "TELEGRAM";

interface WidgetTurn {
  role: "customer" | "agent";
  text: string;
  at: string;
}

export function CustomerSupportWidget() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<ChannelMode>("WEBSITE_CHAT");
  const [reference, setReference] = useState("");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<WidgetTurn[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRef, setCreatedRef] = useState<string | null>(null);
  const [orderRef, setOrderRef] = useState<string | null>(null);
  const [sessionKey] = useState(
    () => `widget:${Math.random().toString(36).slice(2, 10)}`,
  );
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns, sending, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (pathname === "/track") {
    return null;
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setInput("");
    setError(null);
    setTurns((prev) => [
      ...prev,
      { role: "customer", text: trimmed, at: new Date().toISOString() },
    ]);
    setSending(true);

    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "SUPPORT_MESSAGE",
          payload: {
            message: trimmed,
            reference: reference.trim() || undefined,
            sessionKey: `${channel.toLowerCase()}:${sessionKey}`,
            channel,
          },
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        reply?: string;
        reference?: string | null;
        shipmentReference?: string | null;
        orderReference?: string | null;
        startedWork?: boolean;
        autonomousStarted?: boolean;
        error?: string;
      };

      if (!res.ok || !data.ok) {
        setError(data.error ?? "Unable to send message right now.");
        setSending(false);
        return;
      }

      const resolvedRef = data.shipmentReference ?? data.reference ?? null;

      if (data.reply) {
        setTurns((prev) => [
          ...prev,
          { role: "agent", text: data.reply!, at: new Date().toISOString() },
        ]);
      }
      if (resolvedRef) {
        setReference(resolvedRef);
        setCreatedRef(resolvedRef);
      }
      if (data.orderReference) {
        setOrderRef(data.orderReference);
      }
      if (data.startedWork || data.autonomousStarted || data.orderReference || resolvedRef) {
        router.refresh();
      }
    } catch {
      setError("Network error contacting AI Customer Support.");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {!open ? (
        <button
          type="button"
          className="support-launcher"
          onClick={() => setOpen(true)}
          aria-label="Open AI Customer Support Agent"
        >
          <MessageSquare size={16} strokeWidth={2} aria-hidden="true" />
          <span>AI Customer Support</span>
        </button>
      ) : null}

      <AnimatePresence>
        {open ? (
          <motion.section
            className="support-drawer"
            role="dialog"
            aria-label="AI Customer Support Agent"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            <header className="support-drawer-head">
              <div>
                <strong>AI Customer Support</strong>
                <span>Website chat, WhatsApp &amp; Telegram intake</span>
              </div>
              <button
                type="button"
                className="support-drawer-close"
                aria-label="Close AI Customer Support"
                onClick={() => setOpen(false)}
              >
                <X size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            </header>

            <div className="support-drawer-controls">
              <div className="support-channel-bar" role="group" aria-label="Support channel">
                {(
                  [
                    ["WEBSITE_CHAT", "Web chat"],
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
              <input
                className="support-ref-input"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Optional shipment ref (e.g. LG-82931)"
                aria-label="Shipment reference"
              />
            </div>

            <div className="support-drawer-log">
              {turns.length === 0 ? (
                <div className="support-empty">
                  <p>
                    Ask about a shipment, place a new order, request a route
                    change, or report an issue. Actionable requests start
                    fulfillment automatically.
                  </p>
                  <div className="support-quick-prompts">
                    <button
                      type="button"
                      onClick={() =>
                        sendMessage(
                          "Book 30 cartons of medical supplies (280 kg) from Lagos to Abuja",
                        )
                      }
                    >
                      Book new shipment (Lagos → Abuja)
                    </button>
                    <button
                      type="button"
                      onClick={() => sendMessage("Where is shipment LG-82931?")}
                    >
                      Track shipment LG-82931
                    </button>
                  </div>
                </div>
              ) : (
                turns.map((turn, idx) => (
                  <div key={idx} className="bubble" data-role={turn.role}>
                    {turn.text}
                  </div>
                ))
              )}
              {sending ? (
                <div className="bubble" data-role="agent" data-waiting="true">
                  Replying…
                </div>
              ) : null}
              <div ref={logEndRef} />
            </div>

            {error ? (
              <p className="support-drawer-error" role="alert">
                {error}
              </p>
            ) : null}

            {createdRef || orderRef ? (
              <div className="support-drawer-handoff">
                <span>
                  Started {orderRef ? `${orderRef} / ` : ""}
                  {createdRef ?? ""}
                </span>
                {createdRef ? (
                  <Link
                    href={`/shipments/${encodeURIComponent(createdRef)}`}
                    onClick={() => setOpen(false)}
                  >
                    Open shipment
                  </Link>
                ) : null}
              </div>
            ) : null}

            <form
              className="support-drawer-form"
              onSubmit={(e) => {
                e.preventDefault();
                sendMessage(input);
              }}
            >
              <label htmlFor="support-widget-input" className="visually-hidden">
                Message AI Customer Support
              </label>
              <input
                id="support-widget-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask tracking or describe an order…"
                maxLength={1500}
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                aria-label="Send message"
              >
                <Send size={15} strokeWidth={2} aria-hidden="true" />
              </button>
            </form>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </>
  );
}
