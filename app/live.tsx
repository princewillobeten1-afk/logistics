"use client";

import { useLiveEvents } from "@/lib/use-live-events";
import { relative } from "@/lib/format";

/**
 * Drop into any server-rendered page to make it update itself.
 *
 * Renders a small status line rather than nothing, because a page that
 * silently refreshes is unsettling — numbers change while you are reading
 * them and there is no explanation. Saying "live, last update 12s ago" turns
 * that into something the operator expects.
 */
export function Live({ label = "shipment events" }: { label?: string }) {
  const { status, last, count } = useLiveEvents();

  return (
    <div className="live" data-status={status} role="status" aria-live="polite">
      <span className="live-dot" aria-hidden="true" />
      <span className="live-label">
        {status === "live"
          ? `Live · ${label}`
          : status === "connecting"
            ? "Connecting…"
            : "Reconnecting…"}
      </span>
      {last ? (
        <span className="live-last">
          {last.reference ? `${last.reference} ` : ""}
          {last.type}
          {last.state ? ` → ${last.state}` : ""} · {relative(last.at)}
        </span>
      ) : status === "live" ? (
        <span className="live-last">awaiting new events</span>
      ) : null}
      {count > 0 ? <span className="live-count">{count}</span> : null}
    </div>
  );
}
