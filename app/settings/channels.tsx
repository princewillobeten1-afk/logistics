import {
  disconnectChannel,
  saveChannel,
  toggleChannel,
  type ChannelRow,
} from "@/app/settings/channel-actions";
import { Pill } from "@/app/components";
import { relative } from "@/lib/format";

type Field = {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  help?: string;
};

/** Mirrors the `fields` on each provider in channels/providers.py. Kept in
 *  sync by hand rather than fetched, because this is a form layout — the
 *  authority on what a credential *is* remains the Python provider. */
const CHANNELS: Record<
  string,
  { blurb: string; fields: Field[]; setup: string[] }
> = {
  TELEGRAM: {
    blurb:
      "Customers message your bot. No business verification and no template approval — a token from @BotFather works immediately. A bot cannot start a conversation, so the customer messages first.",
    fields: [
      {
        key: "bot_token",
        label: "Bot token",
        secret: true,
        placeholder: "123456:ABC-DEF…",
        help: "From @BotFather: send /newbot, then copy the token it gives you.",
      },
    ],
    setup: [
      "Open @BotFather on Telegram and send /newbot",
      "Choose a name and username for your support bot",
      "Paste the token here and press Connect",
      "Share your t.me link with customers",
    ],
  },
  WHATSAPP: {
    blurb:
      "Meta Cloud API. Replies within 24 hours of a customer message are free-form; outside that window Meta requires an approved template, which has real lead time.",
    fields: [
      { key: "access_token", label: "Access token", secret: true },
      {
        key: "phone_number_id",
        label: "Phone number ID",
        placeholder: "1234567890",
        help: "The numeric ID from Meta, not the phone number itself.",
      },
      {
        key: "verify_token",
        label: "Webhook verify token",
        secret: true,
        help: "Any string you choose; Meta echoes it when registering the webhook.",
      },
    ],
    setup: [
      "Create a Meta app and add the WhatsApp product",
      "Copy the permanent access token and phone number ID",
      "Point the webhook at /api/webhooks/whatsapp on this server",
      "Start template approval early — it is the slow part",
    ],
  },
  GMAIL: {
    blurb:
      "Reads your support inbox over IMAP and replies over SMTP using a Google app password. Works immediately — no Google Cloud project and no verification review.",
    fields: [
      {
        key: "address",
        label: "Email address",
        placeholder: "support@yourcompany.com",
      },
      {
        key: "app_password",
        label: "App password",
        secret: true,
        placeholder: "abcd efgh ijkl mnop",
        help: "Google Account → Security → App passwords. Not your normal password.",
      },
    ],
    setup: [
      "Turn on 2-step verification for the Google account",
      "Generate an app password under Security → App passwords",
      "Paste the address and app password here",
      "Forward your public support address to this mailbox",
    ],
  },
  WIDGET: {
    blurb:
      "A chat bubble on your own website. Customers ask without leaving your page, and messages arrive here like any other channel.",
    fields: [
      {
        key: "allowed_origins",
        label: "Allowed website origins",
        placeholder: "https://yourcompany.com",
        help: "Comma-separated. Only these sites may embed the widget.",
      },
    ],
    setup: [
      "Add the origins your site is served from",
      "Press Connect to generate a site key",
      "Paste the snippet before </body> on your site",
    ],
  },
};

function statusTone(state: string, enabled: boolean): string {
  if (state === "ERROR") return "ALERT";
  if (state === "VERIFIED") return enabled ? "OK" : "PENDING";
  return "PENDING";
}

function statusLabel(state: string, enabled: boolean): string {
  if (state === "ERROR") return "ERROR";
  if (state === "VERIFIED") return enabled ? "LIVE" : "CONNECTED";
  return "NOT CONNECTED";
}

export function ChannelCards({
  channels,
  keyConfigured,
  origin,
}: {
  channels: ChannelRow[];
  keyConfigured: boolean;
  origin: string;
}) {
  return (
    <div className="channels">
      {!keyConfigured ? (
        <div className="banner" style={{ marginBottom: 0 }}>
          <strong>Channels cannot be connected yet</strong>
          <div>
            The tokens and passwords you enter here are encrypted before they
            are stored, and the encryption has not been set up on this server
            yet — so nothing can be saved. Ask your administrator to finish
            setting it up. Nothing is ever stored unencrypted.
          </div>
        </div>
      ) : null}

      {channels.map((row) => {
        const spec = CHANNELS[row.channel];
        if (!spec) return null;
        const connected = row.state === "VERIFIED";
        const siteKey = row.config?.site_key as string | undefined;

        return (
          <section key={row.channel} className="channel" data-state={row.state}>
            <header>
              <div>
                <h3>{row.display_name}</h3>
                <Pill state={statusLabel(row.state, row.enabled)} />
              </div>
              {connected ? (
                <form action={toggleChannel} className="toggle">
                  <input type="hidden" name="channel" value={row.channel} />
                  <input
                    type="hidden"
                    name="enable"
                    value={String(!row.enabled)}
                  />
                  <button type="submit">
                    {row.enabled ? "Pause" : "Go live"}
                  </button>
                </form>
              ) : null}
            </header>

            <p className="blurb">{spec.blurb}</p>

            {row.last_error ? (
              <p className="channel-error">{row.last_error}</p>
            ) : null}

            {connected ? (
              <dl className="connected-facts">
                {row.config?.username ? (
                  <div>
                    <dt>bot</dt>
                    <dd>
                      <a
                        href={`https://t.me/${row.config.username}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        @{String(row.config.username)}
                      </a>
                    </dd>
                  </div>
                ) : null}
                {row.config?.phone_number ? (
                  <div>
                    <dt>number</dt>
                    <dd>{String(row.config.phone_number)}</dd>
                  </div>
                ) : null}
                {row.config?.address ? (
                  <div>
                    <dt>mailbox</dt>
                    <dd>{String(row.config.address)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>verified</dt>
                  <dd>{relative(row.verified_at)}</dd>
                </div>
                <div>
                  <dt>last message</dt>
                  <dd>
                    {row.last_inbound_at ? relative(row.last_inbound_at) : "none yet"}
                  </dd>
                </div>
              </dl>
            ) : (
              <ol className="setup">
                {spec.setup.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            )}

            <form action={saveChannel} className="channel-form">
              <input type="hidden" name="channel" value={row.channel} />
              {spec.fields.map((f) => {
                const inputId = `channel-${row.channel.toLowerCase()}-${f.key}`;
                const helpId = f.help ? `${inputId}-help` : undefined;
                return (
                  <label key={f.key} htmlFor={inputId}>
                    <span>{f.label}</span>
                    <input
                      id={inputId}
                      name={f.key}
                      type={f.secret ? "password" : "text"}
                      placeholder={
                        f.secret && row.has_credentials
                          ? "•••••••• (leave blank to keep)"
                          : (f.placeholder ?? "")
                      }
                      defaultValue={
                        f.secret ? "" : ((row.config?.[f.key] as string) ?? "")
                      }
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      aria-describedby={helpId}
                    />
                    {f.help ? <em id={helpId}>{f.help}</em> : null}
                  </label>
                );
              })}
              <div className="channel-buttons">
                <button type="submit" disabled={!keyConfigured}>
                  {connected ? "Re-verify" : "Connect"}
                </button>
                {row.has_credentials ? (
                  <button
                    type="submit"
                    formAction={disconnectChannel}
                    className="danger"
                  >
                    Disconnect
                  </button>
                ) : null}
              </div>
            </form>

            {row.channel === "WIDGET" && siteKey ? (
              <div className="snippet">
                <span className="snippet-label">
                  Paste before <code>&lt;/body&gt;</code> on your site
                </span>
                <pre className="json">{`<script
  src="${origin}/widget.js"
  data-site-key="${siteKey}"
  defer
></script>`}</pre>
              </div>
            ) : null}

            {row.channel === "WHATSAPP" && row.has_credentials ? (
              <div className="snippet">
                <span className="snippet-label">Webhook URL for Meta</span>
                <pre className="json">{`${origin}/api/webhooks/whatsapp`}</pre>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
