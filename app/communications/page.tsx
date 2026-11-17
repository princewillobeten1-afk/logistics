import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { GmailConnect } from "@/app/settings/gmail-connect";
import { relative } from "@/lib/format";
import { listCommunications } from "@/lib/queries";

export const dynamic = "force-dynamic";

const CHANNELS = [
  ["TELEGRAM", "customers and carriers message your bot directly"],
  ["WHATSAPP", "message templates must be approved by Meta before you can start a conversation"],
  ["GMAIL", "connect with Google Sign-In to read support mail and send replies"],
  ["PORTAL", "the tracking page customers use to check on a delivery"],
];

export default async function Communications() {
  let messages;
  try {
    messages = await listCommunications();
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Customer communications</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const inbound = messages.filter((m) => m.direction === "INBOUND");
  const unscreened = inbound.filter((m) => !m.safety_checked);

  return (
    <>
      <div className="page-head">
        <h1>Customer communications</h1>
        <p>
          Outbound updates and inbound questions. Inbound bodies are untrusted
          input reaching an agent that can propose spending money, so every one
          records whether the guardrail pass ran.
        </p>
      </div>

      <dl className="tiles">
        <div className="tile">
          <dt>Messages</dt>
          <dd>{messages.length}</dd>
        </div>
        <div className="tile">
          <dt>Inbound</dt>
          <dd>{inbound.length}</dd>
          <small>untrusted by default</small>
        </div>
        <div className="tile alert">
          <dt>Unscreened inbound</dt>
          <dd>{unscreened.length}</dd>
          <small>no guardrail verdict recorded</small>
        </div>
      </dl>

      <Panel
        title="Gmail support mailbox"
        hint="sign in with Google to read inbox messages and send replies"
      >
        <GmailConnect compact />
      </Panel>

      <Panel title="Channels" flush>
        <div
          className="scroller"
          tabIndex={0}
          role="region"
          aria-label="Communication channels"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Status</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {CHANNELS.map(([channel, note]) => (
                <tr key={channel}>
                  <td className="ref">{channel}</td>
                  <td>
                    <Pill state="PENDING" />
                  </td>
                  <td className="text-muted">{note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Message log" hint={`${messages.length} recorded`} flush>
        {messages.length === 0 ? (
          <Empty
            message="No messages yet"
            hint="Customer notifications and support replies appear here as shipments progress."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Message log"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Shipment</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Direction</th>
                  <th scope="col">Recipient</th>
                  <th scope="col">Screened</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id}>
                    <td className="num text-faint">
                      {relative(m.created_at)}
                    </td>
                    <td className="ref">
                      <ShipmentLink reference={m.reference} />
                    </td>
                    <td>
                      <Pill state={m.channel} />
                    </td>
                    <td className="num">{m.direction.toLowerCase()}</td>
                    <td className="num">{m.recipient ?? "—"}</td>
                    <td>
                      {m.direction === "INBOUND" ? (
                        <Pill state={m.safety_checked ? "OK" : "ALERT"} />
                      ) : (
                        <span className="text-faint">n/a</span>
                      )}
                    </td>
                    <td>
                      <Pill state={m.state} />
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
