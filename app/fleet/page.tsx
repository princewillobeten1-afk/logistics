import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { AddFleetForms, StarterNetworkButton } from "@/components/network-crud";
import { relative } from "@/lib/format";
import { listConveyances, listDrivers } from "@/lib/queries";

export const dynamic = "force-dynamic";

/** A licence that expires this month is a dispatch problem, not paperwork:
 *  assigning that driver produces a load they cannot legally take. */
function licenceTone(days: string | null): string | null {
  if (days === null) return null;
  const n = Number(days);
  if (n < 0) return "crit";
  if (n <= 30) return "warn";
  return null;
}

export default async function Fleet() {
  let vehicles, drivers;
  try {
    [vehicles, drivers] = await Promise.all([listConveyances(), listDrivers()]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Fleet</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const working = vehicles.filter((v) => v.assigned_to).length;
  const expiring = drivers.filter((d) => {
    const t = licenceTone(d.days_to_expiry);
    return t === "warn" || t === "crit";
  });

  return (
    <>
      <div
        className="page-head"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1>Fleet</h1>
          <p>
            Vehicles and drivers, with what each is currently committed to. An
            assignment here comes from a shipment leg rather than from the vehicle
            record — a conveyance row says a truck exists, not that anyone can
            dispatch it today.
          </p>
        </div>
        {vehicles.length === 0 ? <StarterNetworkButton /> : <StarterNetworkButton compact />}
      </div>

      <Panel title="Register vehicle & driver" hint="available immediately to cuOpt fleet optimization">
        <AddFleetForms />
      </Panel>

      {expiring.length > 0 ? (
        <div className="banner" data-tone="warn">
          <strong>{expiring.length}</strong>{" "}
          {expiring.length === 1 ? "driver licence" : "driver licences"} expiring
          within 30 days or already expired:{" "}
          {expiring.map((d) => d.name).join(", ")}
        </div>
      ) : null}

      <dl className="tiles">
        <div className="tile">
          <dt>Vehicles</dt>
          <dd>{vehicles.length}</dd>
        </div>
        <div className="tile">
          <dt>On a job</dt>
          <dd>{working}</dd>
        </div>
        <div className="tile">
          <dt>Drivers</dt>
          <dd>{drivers.length}</dd>
        </div>
        <div className="tile">
          <dt>Hazmat certified</dt>
          <dd>{drivers.filter((d) => d.hazmat_certified).length}</dd>
        </div>
      </dl>

      <Panel title="Vehicles" hint={`${vehicles.length} on file`} flush>
        {vehicles.length === 0 ? (
          <Empty
            message="No vehicles yet"
            hint="Vehicles are registered against a carrier by an administrator."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Vehicles"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Registration</th>
                  <th scope="col">Carrier</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Type</th>
                  <th scope="col">Capacity</th>
                  <th scope="col">Handling</th>
                  <th scope="col">Assigned to</th>
                  <th scope="col">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => (
                  <tr key={v.id}>
                    <td className="ref">{v.registration ?? "—"}</td>
                    <td className="text-muted">
                      {v.carrier_code ?? "unassigned"}
                    </td>
                    <td className="num">{v.mode}</td>
                    <td className="num text-muted">
                      {v.kind ?? "—"}
                    </td>
                    <td className="num">
                      {v.capacity_kg
                        ? `${Number(v.capacity_kg).toLocaleString()} kg`
                        : "—"}
                    </td>
                    <td className="text-xs">
                      {v.reefer ? <span className="tag">reefer</span> : null}
                      {v.hazmat_certified ? (
                        <span className="tag">hazmat</span>
                      ) : null}
                      {!v.reefer && !v.hazmat_certified ? (
                        <span className="text-faint">general</span>
                      ) : null}
                    </td>
                    <td className="ref">
                      {v.assigned_to ? (
                        <ShipmentLink reference={v.assigned_to} />
                      ) : (
                        <span className="text-faint">idle</span>
                      )}
                    </td>
                    <td className="num text-faint">
                      {v.last_seen_at ? relative(v.last_seen_at) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Drivers" hint={`${drivers.length} on file`} flush>
        {drivers.length === 0 ? (
          <Empty
            message="No drivers yet"
            hint="Drivers are registered against a carrier by an administrator."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Drivers"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Carrier</th>
                  <th scope="col">Phone</th>
                  <th scope="col">Licence</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Hazmat</th>
                  <th scope="col">Assigned to</th>
                </tr>
              </thead>
              <tbody>
                {drivers.map((d) => {
                  const tone = licenceTone(d.days_to_expiry);
                  return (
                    <tr key={d.id}>
                      <td>{d.name}</td>
                      <td className="text-muted">
                        {d.carrier_code ?? "unassigned"}
                      </td>
                      <td className="num text-muted">
                        {d.phone ?? "—"}
                      </td>
                      <td className="num">{d.licence_number ?? "—"}</td>
                      <td className="num">
                        {d.licence_expiry ? (
                          <span
                            className={
                              tone
                                ? `text-${tone} font-semibold`
                                : undefined
                            }
                          >
                            {Number(d.days_to_expiry) < 0
                              ? "expired"
                              : `${d.days_to_expiry} days`}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {d.hazmat_certified ? (
                          <span className="tag">yes</span>
                        ) : (
                          <span className="text-faint">no</span>
                        )}
                      </td>
                      <td className="ref">
                        {d.assigned_to ? (
                          <ShipmentLink reference={d.assigned_to} />
                        ) : (
                          <span className="text-faint">idle</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
