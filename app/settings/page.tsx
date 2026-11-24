import Link from "next/link";
import { headers } from "next/headers";
import { Empty, Offline, Panel, Pill } from "@/app/components";
import { ChannelCards } from "@/app/settings/channels";
import { listChannels } from "@/app/settings/channel-actions";
import { currentUser } from "@/lib/auth";
import { money, relative, when } from "@/lib/format";
import { listOrgConnectors } from "@/lib/integrations/store";
import { activePolicy, currencies, latestRates, migrations } from "@/lib/queries";

export const dynamic = "force-dynamic";

// Where the assistant is used, in the terms of the business rather than the
// system. Which model serves each job is a deployment decision made outside
// this dashboard — an administrator cannot change it here, and a model
// identifier tells the person running a haulage company nothing useful.
//
// The flag is whether that job takes time to reason before answering. It is
// worth surfacing: it explains why investigating a delay takes a moment while
// a customer reply comes back instantly.
const AI_USES: [string, string, boolean][] = [
  ["Reading new orders", "Pulls addresses, quantities and deadlines out of a customer's message.", true],
  ["Investigating delays", "Works out why a shipment is late and what can still be done.", true],
  ["Difficult cases", "A second, more careful look when the first answer is not confident.", true],
  ["Understanding carrier replies", "Turns a haulier's freeform message into a comparable quote.", false],
  ["Answering customers", "Replies to tracking questions and booking requests.", false],
  ["Delay notifications", "Writes the message that tells a customer something has changed.", false],
  ["Screening messages", "Checks incoming messages for abuse before anyone replies.", false],
  ["Reading paperwork", "Extracts details from delivery notes and scanned documents.", false],
  ["Weekly analysis", "Explains what the numbers did and what changed.", true],
];

// Integration status flags are evaluated dynamically per deployment and
// verified channel connector state inside the Settings page component.

export default async function Settings() {
  // The widget snippet must point at wherever this dashboard is actually
  // served from, not a hardcoded localhost.
  const head = await headers();
  const origin = `${head.get("x-forwarded-proto") ?? "http"}://${
    head.get("host") ?? "localhost:3000"
  }`;
  const keyConfigured = Boolean(process.env.CREDENTIALS_KEY);

  const user = await currentUser();
  let policy, currencyList, rates, applied, channels, connectedSystems;
  try {
    [policy, currencyList, rates, applied, channels, connectedSystems] = await Promise.all([
      activePolicy(),
      currencies(),
      latestRates(),
      migrations(),
      listChannels(),
      user ? listOrgConnectors(user.orgId) : Promise.resolve([]),
    ]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Settings and integrations</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const rules = (policy?.rules ?? {}) as Record<string, any>;
  const actions = (rules.actions ?? {}) as Record<string, any>;
  const triggers = (rules.require_approval_when ?? {}) as Record<string, unknown>;
  const base = (rules.base_currency as string) ?? "NGN";
  const maxAge = Number(rules.fx_max_age_hours ?? 24);
  const activeConnectors = connectedSystems.filter((c) => c.status === "ACTIVE");

  const integrations: [string, string, boolean][] = [
    [
      "AI assistant",
      "Handles exceptions, customer replies and document reading",
      Boolean(process.env.GEMINI_API_KEY),
    ],
    [
      "External ERP / TMS / WMS connectors",
      activeConnectors.length > 0
        ? `${activeConnectors.length} active company system connector(s) feeding the autonomous agent`
        : "Connect SAP, NetSuite, CargoWise, Shopify, EDI X12, CSV, or custom APIs",
      activeConnectors.length > 0,
    ],
    [
      "Telegram",
      "Carriers and customers message your bot directly",
      channels.some((c) => c.channel === "TELEGRAM" && c.state === "VERIFIED"),
    ],
    [
      "WhatsApp Business",
      "Meta must approve your message templates first",
      channels.some((c) => c.channel === "WHATSAPP" && c.state === "VERIFIED"),
    ],
    [
      "Vehicle tracking",
      "Live positions fed from your carriers' tracking systems",
      Boolean(process.env.TELEMETRY_WEBHOOK_SECRET) ||
        activeConnectors.some((c) => c.category === "TELEMATICS"),
    ],
    [
      "Address lookup",
      "Turns written addresses into map positions automatically",
      Boolean(process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY),
    ],
  ];

  return (
    <>
      <div className="page-head">
        <h1>Settings and integrations</h1>
        <p>
          Configure customer support channels, versioned spending thresholds,
          supported currencies, and FX staleness rules. To connect external company
          ERP, TMS, WMS, EDI, or webhook feeds, open{" "}
          <Link href="/integrations" className="auth-link">
            System integrations
          </Link>
          .
        </p>
      </div>

      <Panel
        title="Customer channels"
        hint="how customers reach your support agent"
      >
        <p className="prose" style={{ marginBottom: 16 }}>
          Customers never see this dashboard. They message one of these
          channels, and the support agent answers on whichever one they used —
          from live shipment data, and only ever about their own shipment.
        </p>
        <ChannelCards
          channels={channels}
          keyConfigured={keyConfigured}
          origin={origin}
        />
      </Panel>

      <Panel
        title="Active policy"
        hint={policy ? `version ${policy.version} · ${policy.name}` : "none"}
      >
        {!policy ? (
          <Empty
            message="No spending rules configured"
            hint="Until rules exist, nothing that costs money is allowed to proceed on its own — every booking waits for a person. Ask your administrator to configure them."
          />
        ) : (
          <dl className="kv">
            <dt>Base currency</dt>
            <dd>
              {base}{" "}
              <span className="text-faint">
                — all amounts convert here before comparison
              </span>
            </dd>
            <dt>Max FX age</dt>
            <dd>
              {maxAge} h{" "}
              <span className="text-faint">
                — rates older than this require manual review
              </span>
            </dd>
            <dt>Auto-execute tiers</dt>
            <dd className="num">
              {(rules.auto_execute_tiers as number[])?.join(", ") ?? "—"}
            </dd>
            <dt>Default rule</dt>
            <dd>
              <Pill state={String(rules.default_decision ?? "REQUIRE_APPROVAL")} />
            </dd>
            <dt>Effective since</dt>
            <dd>{when(policy.created_at)}</dd>
          </dl>
        )}
      </Panel>

      <div className="grid-2">
        <Panel title="Spend caps" hint="per action" flush>
          {Object.keys(actions).length === 0 ? (
            <Empty
              message="No spend caps configured"
              hint="Per-action spending limits will appear once an active policy is published."
            />
          ) : (
            <div
              className="scroller"
              tabIndex={0}
              role="region"
              aria-label="Spend caps"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Action</th>
                    <th scope="col">Auto-approve below</th>
                    <th scope="col">Hard ceiling</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(actions).map(([action, rule]) => (
                    <tr key={action}>
                      <td className="ref">{action}</td>
                      <td className="num">
                        {rule.auto_approve_below_minor === null ? (
                          <span className="text-warn">never automatic</span>
                        ) : rule.auto_approve_below_minor === 0 ? (
                          <span className="text-warn">always approved by a human</span>
                        ) : (
                          money(rule.auto_approve_below_minor, base)
                        )}
                      </td>
                      <td className="num">
                        {rule.hard_deny_above_minor
                          ? money(rule.hard_deny_above_minor, base)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Non-monetary approval triggers" hint="apply regardless of amount">
          {Object.keys(triggers).length === 0 ? (
            <Empty
              message="No approval triggers configured"
              hint="Rule-based escalation triggers appear here once a policy is active."
            />
          ) : (
            <dl className="kv">
              {Object.entries(triggers).map(([key, value]) => (
                <div key={key} style={{ display: "contents" }}>
                  <dt>{key.replace(/_/g, " ")}</dt>
                  <dd>
                    {typeof value === "boolean" ? (
                      <Pill state={value ? "OK" : "PENDING"} />
                    ) : (
                      <span className="num">{money(Number(value), base)}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="Currencies" hint="minor units are per-currency" flush>
          {currencyList.length === 0 ? (
            <Empty
              message="No currencies configured"
              hint="Supported operating currencies appear once configured in the database."
            />
          ) : (
            <div
              className="scroller"
              tabIndex={0}
              role="region"
              aria-label="Currencies"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Minor units</th>
                  </tr>
                </thead>
                <tbody>
                  {currencyList.map((c) => (
                    <tr key={c.code}>
                      <td className="ref">{c.code}</td>
                      <td>{c.name}</td>
                      <td className="num">10^{c.minor_unit_exponent}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="FX rates" hint={`stale after ${maxAge}h`} flush>
          {rates.length === 0 ? (
            <Empty
              message="No FX rates"
              hint="Any non-base amount will be denied until a rate exists."
            />
          ) : (
            <div
              className="scroller"
              tabIndex={0}
              role="region"
              aria-label="FX rates"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Pair</th>
                    <th scope="col">Rate</th>
                    <th scope="col">As of</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {rates.map((r) => {
                    const ageH =
                      (Date.now() - new Date(r.as_of).getTime()) / 3_600_000;
                    return (
                      <tr key={`${r.base}${r.quote}`}>
                        <td className="ref">
                          {r.base}/{r.quote}
                        </td>
                        <td className="num">{Number(r.rate).toLocaleString()}</td>
                        <td
                          className={`num${ageH > maxAge ? " text-crit" : ""}`}
                        >
                          {relative(r.as_of)}
                          {ageH > maxAge ? " — stale" : ""}
                        </td>
                        <td className="num text-faint">
                          {r.source}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Where AI is used"
        hint="every use is recorded under Activity"
        flush
      >
        <div
          className="scroller"
          tabIndex={0}
          role="region"
          aria-label="Where AI is used"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Used for</th>
                <th scope="col">What it does</th>
                <th scope="col">Speed</th>
              </tr>
            </thead>
            <tbody>
              {AI_USES.map(([use, what, deliberates]) => (
                <tr key={use}>
                  <td>{use}</td>
                  <td className="text-muted">{what}</td>
                  <td className="text-muted">
                    {deliberates ? "Considers before answering" : "Immediate"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid-2">
        <Panel title="Integrations" flush>
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Integrations"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Service</th>
                  <th scope="col">Status</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {integrations.map(([name, note, live]) => (
                  <tr key={name}>
                    <td className="ref">{name}</td>
                    <td>
                      <Pill state={live ? "OK" : "PENDING"} />
                    </td>
                    <td className="text-muted">{note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Schema" hint={`${applied.length} migrations applied`} flush>
          {applied.length === 0 ? (
            <Empty
              message="No migrations recorded"
              hint="Database migration history appears once connected to PostgreSQL."
            />
          ) : (
            <div
              className="scroller"
              tabIndex={0}
              role="region"
              aria-label="Schema migrations"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Migration</th>
                    <th scope="col">Applied</th>
                  </tr>
                </thead>
                <tbody>
                  {applied.map((m) => (
                    <tr key={m.version}>
                      <td className="ref">{m.version}</td>
                      <td className="num text-faint">
                        {relative(m.applied_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
