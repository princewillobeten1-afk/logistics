import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { relative } from "@/lib/format";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

type Conversation = {
  id: string;
  channel: string;
  external_id: string;
  display_name: string | null;
  escalated_at: Date | null;
  escalation_reason: string | null;
  draft: Record<string, unknown> | null;
  last_seen_at: Date;
  reference: string | null;
  messages: string;
  last_message: string | null;
  last_direction: string | null;
};

async function conversations() {
  return query<Conversation>(
    `SELECT c.id, c.channel, c.external_id, c.display_name, c.escalated_at,
            c.escalation_reason, c.draft, c.last_seen_at, s.reference,
            (SELECT count(*)::text FROM communications m WHERE m.contact_id = c.id)
              AS messages,
            (SELECT m.body FROM communications m WHERE m.contact_id = c.id
              ORDER BY m.created_at DESC LIMIT 1) AS last_message,
            (SELECT m.direction FROM communications m WHERE m.contact_id = c.id
              ORDER BY m.created_at DESC LIMIT 1) AS last_direction
       FROM channel_contacts c
       LEFT JOIN shipments s ON s.id = c.last_shipment_id
      ORDER BY c.escalated_at DESC NULLS LAST, c.last_seen_at DESC
      LIMIT 50`,
  );
}

async function agentActions() {
  return query<{
    kind: string;
    state: string;
    created_at: Date;
    reference: string | null;
    last_error: string | null;
  }>(
    `SELECT w.kind, w.state, w.created_at, w.last_error, s.reference
       FROM work_items w
       LEFT JOIN shipments s ON s.id = w.shipment_id
      WHERE w.kind LIKE 'support.%'
      ORDER BY w.created_at DESC
      LIMIT 25`,
  );
}

function draftSummary(draft: Record<string, unknown> | null): string | null {
  if (!draft) return null;
  const parts = Object.entries(draft)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  return parts.length ? parts.join(" · ") : null;
}

export default async function Support() {
  let threads, actions;
  try {
    [threads, actions] = await Promise.all([conversations(), agentActions()]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Support inbox</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const escalated = threads.filter((t) => t.escalated_at);
  const drafting = threads.filter((t) => !t.escalated_at && t.draft);
  const rest = threads.filter((t) => !t.escalated_at && !t.draft);

  return (
    <>
      <div className="page-head">
        <h1>Support inbox</h1>
        <p>
          Every conversation the agent is handling, and what it delegated. The
          agent replies and starts work; it never books, spends, or applies a
          change — those go through the policy gate like anything else.
        </p>
      </div>

      <dl className="tiles">
        <div className="tile alert">
          <dt>Needs a person</dt>
          <dd>{escalated.length}</dd>
          <small>escalated by the agent</small>
        </div>
        <div className="tile warn">
          <dt>Mid-booking</dt>
          <dd>{drafting.length}</dd>
          <small>order details still being collected</small>
        </div>
        <div className="tile">
          <dt>Conversations</dt>
          <dd>{threads.length}</dd>
        </div>
      </dl>

      {escalated.length > 0 ? (
        <Panel title="Escalated" hint="the agent handed these over" flush>
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Escalated support threads"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Contact</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Shipment</th>
                  <th scope="col">Why</th>
                  <th scope="col">Escalated</th>
                </tr>
              </thead>
              <tbody>
                {escalated.map((t) => (
                  <tr key={t.id}>
                    <td>{t.display_name ?? t.external_id}</td>
                    <td>
                      <Pill state={t.channel} />
                    </td>
                    <td className="ref">
                      <ShipmentLink reference={t.reference} />
                    </td>
                    <td className="text-crit">{t.escalation_reason}</td>
                    <td className="num text-faint">
                      {relative(t.escalated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {drafting.length > 0 ? (
        <Panel
          title="Bookings in progress"
          hint="the agent is still collecting details"
          flush
        >
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Bookings in progress"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Contact</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Collected so far</th>
                  <th scope="col">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {drafting.map((t) => (
                  <tr key={t.id}>
                    <td>{t.display_name ?? t.external_id}</td>
                    <td>
                      <Pill state={t.channel} />
                    </td>
                    <td className="num text-xs">
                      {draftSummary(t.draft)}
                    </td>
                    <td className="num text-faint">
                      {relative(t.last_seen_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel title="Conversations" hint={`${rest.length} active`} flush>
        {rest.length === 0 ? (
          <Empty
            message="No conversations yet"
            hint="Customer messages arrive here from the channels you connect — Telegram, WhatsApp, email or your website."
            action={{ label: "Connect a channel", href: "/settings" }}
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Active support conversations"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Contact</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Shipment</th>
                  <th scope="col">Messages</th>
                  <th scope="col">Last exchange</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {rest.map((t) => (
                  <tr key={t.id}>
                    <td>{t.display_name ?? t.external_id}</td>
                    <td>
                      <Pill state={t.channel} />
                    </td>
                    <td className="ref">
                      <ShipmentLink reference={t.reference} />
                    </td>
                    <td className="num">{t.messages}</td>
                    <td className="text-xs" style={{ maxWidth: 340 }}>
                      <span className="text-faint">
                        {t.last_direction === "INBOUND" ? "them: " : "agent: "}
                      </span>
                      {t.last_message?.slice(0, 90)}
                    </td>
                    <td className="num text-faint">
                      {relative(t.last_seen_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="What the agent delegated"
        hint="support steps handed to the orchestrator"
        flush
      >
        {actions.length === 0 ? (
          <Empty
            message="Nothing delegated yet"
            hint="Bookings, change requests and escalations appear here as the agent creates them."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Delegated support actions"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Step</th>
                  <th scope="col">State</th>
                  <th scope="col">Shipment</th>
                  <th scope="col">When</th>
                  <th scope="col">Error</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a, i) => (
                  <tr key={`${a.kind}-${i}`}>
                    <td className="num">{a.kind}</td>
                    <td>
                      <Pill state={a.state} />
                    </td>
                    <td className="ref">
                      <ShipmentLink reference={a.reference} />
                    </td>
                    <td className="num text-faint">
                      {relative(a.created_at)}
                    </td>
                    <td className="text-crit text-xs">
                      {a.last_error?.slice(0, 70)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
