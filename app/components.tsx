import Link from "next/link";
import { toneFor } from "@/lib/format";

export function Pill({ state }: { state: string }) {
  return (
    <span className="pill" data-tone={toneFor(state)}>
      {state.replace(/_/g, " ")}
    </span>
  );
}

export function Panel({
  title,
  hint,
  children,
  flush,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  /** Tables run edge to edge; prose and lists get padding. */
  flush?: boolean;
}) {
  return (
    <section className="panel">
      <header>
        <h2>{title}</h2>
        {hint ? <span className="hint">{hint}</span> : null}
      </header>
      {flush ? children : <div className="body">{children}</div>}
    </section>
  );
}

export function Empty({
  message,
  hint,
  action,
}: {
  message: string;
  hint?: string;
  /** Somewhere in the product to go next.
   *
   *  Deliberately a link rather than a shell command. An empty screen should
   *  offer the person looking at it something they can actually do — printing
   *  a terminal command tells an operations manager to go and find a
   *  developer, which is not a feature. */
  action?: { label: string; href: string };
}) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M8 1.75L13.75 4.75V11.25L8 14.25L2.25 11.25V4.75L8 1.75Z" strokeLinejoin="round" />
          <path d="M2.25 4.75L8 7.75L13.75 4.75M8 7.75V14.25" strokeLinejoin="round" />
        </svg>
      </span>
      <strong>{message}</strong>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {action ? (
        <div>
          <Link href={action.href} className="empty-action">
            <span>{action.label}</span>
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export function Offline({ error }: { error?: string }) {
  return (
    <div className="banner" role="alert">
      <strong>This page could not load</strong>
      <div>
        The system is temporarily unreachable. It usually recovers on its own —
        try again in a moment. If it keeps happening, let your administrator
        know.
      </div>
      {/* The underlying fault names hosts, ports and database identifiers.
          Useful while developing, and no business being on an operator's
          screen — or in a screenshot they paste into a support thread. */}
      {process.env.NODE_ENV !== "production" && error ? (
        <div className="font-mono text-xs" style={{ marginTop: "0.5rem", opacity: 0.85 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function ShipmentLink({ reference }: { reference: string | null }) {
  if (!reference) return <span className="text-faint">—</span>;
  return <Link href={`/shipments/${reference}`}>{reference}</Link>;
}
