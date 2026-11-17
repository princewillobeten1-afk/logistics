import Link from "next/link";
import { AlertTriangle, ArrowRight, PackageOpen } from "lucide-react";
import { toneFor } from "@/lib/format";
import { formatStateLabel } from "@/lib/view-helpers";

export function Pill({ state }: { state: string }) {
  return (
    <span className="status-tag" data-tone={toneFor(state)}>
      {formatStateLabel(state)}
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
  action?: { label: string; href: string };
}) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">
        <PackageOpen size={18} strokeWidth={1.75} />
      </span>
      <strong>{message}</strong>
      {hint ? <div className="empty-hint">{hint}</div> : null}
      {action ? (
        <div>
          <Link href={action.href} className="empty-action">
            <span>{action.label}</span>
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export function Offline({ error }: { error?: string }) {
  return (
    <div className="banner" role="alert">
      <strong className="row-center">
        <AlertTriangle size={16} strokeWidth={2} aria-hidden="true" />
        <span>This page could not load</span>
      </strong>
      <div>
        The system is temporarily unreachable. Try again in a moment, or
        contact your workspace administrator if the issue persists.
      </div>
      {process.env.NODE_ENV !== "production" && error ? (
        <div
          className="font-mono text-xs"
          style={{ marginTop: "0.5rem", opacity: 0.85 }}
        >
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
