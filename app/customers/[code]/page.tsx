import { notFound, unstable_rethrow } from "next/navigation";
import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { city, relative, when } from "@/lib/format";
import { customerMessages, customerShipments, getCustomer } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function CustomerDetail({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const decodedCode = decodeURIComponent(code);

  let customer;
  try {
    customer = await getCustomer(decodedCode);
  } catch (error) {
    unstable_rethrow(error);
    return (
      <>
        <div className="page-head">
          <h1>{decodedCode}</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  if (!customer) notFound();

  let shipments, messages;
  try {
    [shipments, messages] = await Promise.all([
      customerShipments(customer.id),
      customerMessages(customer.id),
    ]);
  } catch (error) {
    unstable_rethrow(error);
    return (
      <>
        <div className="page-head">
          <h1>{customer.code}</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const contact = customer.contacts?.[0];

  return (
    <>
      <div className="page-head">
        <h1>
          <span className="font-mono">{customer.code}</span>
          <span style={{ fontWeight: 400 }}>{customer.name}</span>
          {Number(customer.late) > 0 ? <Pill state="ALERT" /> : null}
        </h1>
        <p>
          {customer.total} shipments · {customer.open} open ·{" "}
          {customer.sla_hours
            ? `${customer.sla_hours}-hour SLA`
            : "no contractual SLA"}
        </p>
      </div>

      <div className="grid-2">
        <Panel title="Account">
          <dl className="kv">
            <dt>SLA</dt>
            <dd>
              {customer.sla_hours ? (
                `${customer.sla_hours} hours`
              ) : (
                <span className="text-faint">
                  none agreed — deadlines come from the order
                </span>
              )}
            </dd>
            <dt>Payment terms</dt>
            <dd>{customer.payment_terms ?? "—"}</dd>
            <dt>Currency</dt>
            <dd>{customer.default_currency}</dd>
            <dt>Status</dt>
            <dd>
              <Pill state={customer.active ? "ACTIVE" : "INACTIVE"} />
            </dd>
            <dt>Last shipment</dt>
            <dd>
              {customer.last_shipment_at
                ? relative(customer.last_shipment_at)
                : "never"}
            </dd>
          </dl>
        </Panel>

        <Panel title="Contact">
          {contact ? (
            <dl className="kv">
              <dt>Name</dt>
              <dd>{contact.name ?? "—"}</dd>
              <dt>Email</dt>
              <dd>{contact.email ?? "—"}</dd>
              <dt>Phone</dt>
              <dd>{contact.phone ?? "—"}</dd>
            </dl>
          ) : (
            <Empty
              message="No contact recorded"
              hint="Inbound email cannot be matched to this customer without one."
            />
          )}
        </Panel>
      </div>

      <Panel
        title="Shipments"
        hint={`${shipments.length} most recent`}
        flush
      >
        {shipments.length === 0 ? (
          <Empty
            message="No shipments for this customer"
            hint="A shipment links here when its order names this code or exact name."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Customer shipments"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">State</th>
                  <th scope="col">Route</th>
                  <th scope="col">Promised</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {shipments.map((s) => (
                  <tr key={s.reference}>
                    <td className="ref">
                      <ShipmentLink reference={s.reference} />
                    </td>
                    <td>
                      <Pill state={s.state} />
                    </td>
                    <td className="text-muted">
                      {city(s.origin)} → {city(s.destination)}
                    </td>
                    <td
                      className={`num${s.overdue ? " text-crit" : ""}`}
                    >
                      {when(s.deadline)}
                      {s.overdue ? " · overdue" : ""}
                    </td>
                    <td className="num text-faint">
                      {relative(s.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Communications"
        hint="everything said to and from this customer"
        flush
      >
        {messages.length === 0 ? (
          <Empty message="Nothing has been sent to or received from this customer" />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Customer communications"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Direction</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Shipment</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m, i) => (
                  <tr key={`${m.created_at}-${i}`}>
                    <td className="num text-faint">
                      {relative(m.created_at)}
                    </td>
                    <td>
                      <Pill state={m.direction} />
                    </td>
                    <td className="num">{m.channel}</td>
                    <td className="ref">
                      <ShipmentLink reference={m.reference} />
                    </td>
                    <td className="text-xs" style={{ maxWidth: 420 }}>
                      {(m.body ?? "").slice(0, 180)}
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
