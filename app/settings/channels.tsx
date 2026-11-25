import {
  disconnectChannel,
  saveChannel,
  syncTelegramChannel,
  toggleChannel,
  type ChannelRow,
} from "@/app/settings/channel-actions";
import { GmailConnect } from "@/app/settings/gmail-connect";
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
      "Connect your support Gmail mailbox directly with Google Sign-In to read incoming customer emails and send replies with permission.",
    fields: [],
    setup: [
      "Sign in with the Google account that hosts your support mailbox",
      "Grant permission to read incoming support mail and send replies",
      "Read and reply to customer emails directly from this workspace",
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
        <div className="banner" data-tone="warn" style={{ marginBottom: 0 }}>
          <strong>Optional token encryption key not set</strong>
          <div>
            Telegram and Gmail Sign-In work immediately. Set <code>CREDENTIALS_KEY</code>{" "}
            on this server to enable AES-256-GCM encryption at rest for saved channel secrets.
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
                {row.channel === "GMAIL" ? (
                  <Pill state="GOOGLE SIGN-IN" />
                ) : (
                  <Pill state={statusLabel(row.state, row.enabled)} />
                )}
              </div>
              {connected && row.channel !== "GMAIL" ? (
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

            {row.channel === "GMAIL" ? (
              <GmailConnect />
            ) : (
              <>
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
                    {row.channel === "TELEGRAM" && connected ? (
                      <div>
                        <dt>delivery</dt>
                        <dd>
                          {row.enabled ? "Live polling active" : "Paused"}
                        </dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>verified</dt>
                      <dd>{relative(row.verified_at)}</dd>
                    </div>
                    <div>
                      <dt>last message</dt>
                      <dd>
                        {row.last_inbound_at
                          ? relative(row.last_inbound_at)
                          : "none yet"}
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
                            f.secret
                              ? ""
                              : ((row.config?.[f.key] as string) ?? "")
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
                    <button
                      type="submit"
                      disabled={row.channel !== "TELEGRAM" && !keyConfigured}
                    >
                      {connected ? "Re-verify" : "Connect"}
                    </button>
                    {row.channel === "TELEGRAM" && connected ? (
                      <button type="submit" formAction={syncTelegramChannel}>
                        Check messages now
                      </button>
                    ) : null}
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
              </>
            )}

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
