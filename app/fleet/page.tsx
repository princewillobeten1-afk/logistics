import { Empty, Offline, Panel, ShipmentLink } from "@/app/components";
import {
  FleetDispatchConsole,
  type DispatchShipmentOption,
} from "@/components/fleet-dispatch-console";
import { computeLogisticsReadiness, normalizeDutyStatus } from "@/lib/driver-dispatch";
import { relative } from "@/lib/format";
import {
  listConveyances,
  listDocuments,
  listDrivers,
  listLocations,
  listShipments,
} from "@/lib/queries";

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
  let vehicles, drivers, locations, shipments, documents;
  try {
    [vehicles, drivers, locations, shipments, documents] = await Promise.all([
      listConveyances(),
      listDrivers(),
      listLocations(),
      listShipments(),
      listDocuments(),
    ]);
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

  const readiness = computeLogisticsReadiness({
    drivers,
    shipments,
    documents,
  });

  const activeShipments: DispatchShipmentOption[] = shipments
    .filter(
      (s) =>
        !["CLOSED", "CANCELLED", "FAILED", "DELIVERED", "POD_VERIFIED"].includes(
          s.state,
        ),
    )
    .slice(0, 40)
    .map((s) => ({
      id: s.id,
      reference: s.reference,
      state: s.state,
      originCity: typeof s.origin?.city === "string" ? s.origin.city : null,
      destinationCity:
        typeof s.destination?.city === "string" ? s.destination.city : null,
      hazmat: Boolean(s.cargo?.hazmat),
      reefer: Boolean(s.cargo?.reefer || s.cargo?.temp_controlled),
      weightKg:
        s.cargo?.weight_kg !== undefined && Number.isFinite(Number(s.cargo.weight_kg))
          ? Number(s.cargo.weight_kg)
          : null,
      assignedDriverName:
        typeof (s.plan as Record<string, unknown> | null)?.assigned_driver_name ===
        "string"
          ? String((s.plan as Record<string, unknown>).assigned_driver_name)
          : null,
    }));

  return (
    <>
      <div className="page-head">
        <h1>Fleet &amp; Driver Dispatch</h1>
        <p>
          Locate nearby drivers by live GPS, verify Hours-of-Service (HOS)
          clocks and licence validity, and dispatch compliant drivers directly
          onto active shipments.
        </p>
      </div>

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
          <dt>Drivers ready</dt>
          <dd>
            {readiness.driversDispatchReady} / {drivers.length}
          </dd>
        </div>
        <div className="tile">
          <dt>Hazmat certified</dt>
          <dd>{drivers.filter((d) => d.hazmat_certified).length}</dd>
        </div>
      </dl>

      <FleetDispatchConsole
        initialDrivers={drivers}
        initialLocations={locations}
        initialShipments={activeShipments}
        initialReadiness={readiness}
      />

      <Panel title="Vehicles" hint={`${vehicles.length} on file`} flush>
        {vehicles.length === 0 ? (
          <Empty
            message="No vehicles yet"
            hint="Vehicles are registered against a carrier by an administrator or synced from fleet telematics."
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

      <Panel title="Drivers roster" hint={`${drivers.length} on file`} flush>
        {drivers.length === 0 ? (
          <Empty
            message="No drivers yet"
            hint="Use Register driver above or connect an ELD / TMS integration."
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
                  <th scope="col">Location / GPS</th>
                  <th scope="col">Status</th>
                  <th scope="col">HOS Clock</th>
                  <th scope="col">Equipment</th>
                  <th scope="col">Licence</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Assigned to</th>
                </tr>
              </thead>
              <tbody>
                {drivers.map((d) => {
                  const tone = licenceTone(d.days_to_expiry);
                  const duty = normalizeDutyStatus(d);
                  const hosDrive =
                    typeof d.hos_drive_remaining_hours === "number"
                      ? d.hos_drive_remaining_hours
                      : 9.5;
                  return (
                    <tr key={d.id}>
                      <td>
                        <div className="font-semibold">{d.name}</div>
                        <div className="font-mono text-xs text-faint">
                          {d.phone ?? d.carrier_code ?? "—"}
                        </div>
                      </td>
                      <td>
                        <div>{d.current_city ?? "—"}</div>
                        {d.current_lat && d.current_lon ? (
                          <div className="font-mono text-xs text-faint">
                            {Number(d.current_lat).toFixed(3)},{" "}
                            {Number(d.current_lon).toFixed(3)}
                          </div>
                        ) : (
                          <div className="text-xs text-faint">No GPS ping</div>
                        )}
                      </td>
                      <td>
                        <span
                          className="status-tag"
                          data-tone={
                            duty === "AVAILABLE"
                              ? "ok"
                              : duty === "ON_ROUTE"
                                ? "warn"
                                : "neutral"
                          }
                        >
                          {duty.replace(/_/g, " ").toLowerCase()}
                        </span>
                      </td>
                      <td className="num">
                        <span
                          className={
                            hosDrive < 2.5 ? "text-crit font-semibold" : undefined
                          }
                        >
                          {hosDrive.toFixed(1)}h drive
                        </span>
                      </td>
                      <td className="text-xs">
                        <span className="font-mono">
                          {d.vehicle_registration ?? d.equipment_type ?? "DRY_VAN"}
                        </span>
                        {d.hazmat_certified ? (
                          <span className="tag" style={{ marginLeft: 4 }}>
                            hazmat
                          </span>
                        ) : null}
                        {d.reefer_capable ? (
                          <span className="tag" style={{ marginLeft: 4 }}>
                            reefer
                          </span>
                        ) : null}
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
