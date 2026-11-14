"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type LiveEvent = {
  id: string;
  type: string;
  actor: string;
  state: string | null;
  reference: string | null;
  at: string;
};

export type LiveState = {
  status: "connecting" | "live" | "offline";
  last: LiveEvent | null;
  /** Events seen since this page mounted. */
  count: number;
};

// A burst of events — a shipment moving through four states in a second —
// should cause one re-read, not four. Long enough to coalesce a burst, short
// enough that a single event still feels immediate.
const COALESCE_MS = 400;

/**
 * Subscribes to the shipment event stream and re-reads the page when
 * something happens.
 *
 * The refresh is the point. `router.refresh()` re-runs the server components,
 * so every panel gets its data from the same queries it always used — the
 * stream never becomes a second, subtly different source of truth for what is
 * on screen. It also means a skipped event id is harmless: the next refresh
 * reads current state regardless of which events prompted it.
 */
export function useLiveEvents(enabled = true): LiveState {
  const router = useRouter();
  const [state, setState] = useState<LiveState>({
    status: "connecting",
    last: null,
    count: 0,
  });
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    // EventSource reconnects on its own and replays `Last-Event-ID`, so there
    // is no retry logic here — adding one would fight the browser's.
    const source = new EventSource("/api/events/stream");

    source.onopen = () => {
      setState((s) => ({ ...s, status: "live" }));
    };

    source.addEventListener("shipment", (raw) => {
      let event: LiveEvent;
      try {
        event = JSON.parse((raw as MessageEvent).data);
      } catch {
        return;
      }

      setState((s) => ({
        status: "live",
        last: event,
        count: s.count + 1,
      }));

      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        pending.current = null;
        router.refresh();
      }, COALESCE_MS);
    });

    source.onerror = () => {
      // Fires on a dropped connection *and* while reconnecting. Reporting it
      // is honest — a stale page that looks live is worse than one that says
      // it is offline — but nothing is torn down, because the browser is
      // already retrying.
      setState((s) => ({ ...s, status: "offline" }));
    };

    return () => {
      if (pending.current) clearTimeout(pending.current);
      source.close();
    };
  }, [enabled, router]);

  return state;
}
