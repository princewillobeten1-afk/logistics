import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { OptimizeFleetButton } from "@/app/planning/optimize-button";
import { RoutingRequestForm } from "@/app/planning/routing-request-form";
import { city, money } from "@/lib/format";
import { legStats, listShipments } from "@/lib/queries";

export const dynamic = "force-dynamic";

const OBJECTIVES = [
  ["Cost", "carrier base rate plus cargo weight surcharge"],
  ["Delivery time", "warehouse dispatch lead plus transit matrix against deadline"],
  ["Fleet routing", "capacity and time-window optimisation across active vehicles"],
  ["Corridor advisory", "automated waypoint, weather, and border risk evaluation"],
  ["Carbon footprint", "mode-weighted emissions estimate (kg CO2e per tonne-km)"],
];

export default async function Planning() {
  let toPlan, planned, sourcing, legs;
  try {
    [toPlan, planned, sourcing, legs] = await Promise.all([
      listShipments("ALLOCATED"),
      listShipments("PLANNED"),
      listShipments("SOURCING"),
      legStats(),
    ]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Planning workspace</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const queue = [...toPlan, ...planned, ...sourcing];

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
          <h1>Planning workspace</h1>
          <p>
            Multimodal corridor selection, vehicle routing across active fleet
            capacity, and automated corridor risk advisory.
          </p>
        </div>
        <OptimizeFleetButton />
      </div>

      <Panel
        title="Custom route & planning intake"
        hint="submit a new lane or reroute request"
      >
        <RoutingRequestForm />
      </Panel>

      <div className="grid-2">
        <Panel
          title="Optimisation objectives"
          hint="routing & corridor constraints"
        >
          <dl className="kv">
            {OBJECTIVES.map(([name, detail]) => (
              <div key={name} className="contents">
                <dt>{name}</dt>
                <dd className="text-muted">{detail}</dd>
              </div>
            ))}
          </dl>
          <p className="prose-note">
            Road legs and fleet dispatches are balanced across vehicle capacity,
            time windows, and border clearance lead times before carrier
            sourcing opens.
          </p>
        </Panel>

        <Panel title="Legs by mode" hint="everything planned so far" flush>
          {legs.length === 0 ? (
            <Empty message="No legs planned yet" />
          ) : (
            <div
              className="scroller"
              tabIndex={0}
              role="region"
              aria-label="Legs by transport mode"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Mode</th>
                    <th scope="col">Legs</th>
                    <th scope="col">Distance</th>
                    <th scope="col">CO2e</th>
                  </tr>
                </thead>
                <tbody>
                  {legs.map((l) => (
                    <tr key={l.mode}>
                      <td>
                        <Pill state={l.mode} />
                      </td>
                      <td className="num">{l.legs}</td>
                      <td className="num">{l.total_km ?? "—"} km</td>
                      <td className="num">{l.total_co2e ?? "—"} kg</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Planning queue"
        hint={`${toPlan.length} to plan · ${planned.length} planned · ${sourcing.length} sourcing`}
        flush
      >
        {queue.length === 0 ? (
          <Empty
            message="Nothing in the planning queue"
            hint="Shipments arrive here once stock is allocated."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Planning queue"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">State</th>
                  <th scope="col">Lane &amp; Waypoints</th>
                  <th scope="col">Vehicle / Solver</th>
                  <th scope="col">Modes</th>
                  <th scope="col">Distance</th>
                  <th scope="col">Estimated</th>
                  <th scope="col">CO2e</th>
                  <th scope="col">Deadline</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((s) => {
                  const plan = s.plan as Record<string, unknown> | null;
                  const meets = plan?.meets_deadline;
                  const waypoints = Array.isArray(plan?.waypoints)
                    ? (plan.waypoints as string[])
                    : null;
                  const vehicle =
                    (plan?.assigned_vehicle as string) ||
                    (plan?.recommended_vehicle as string) ||
                    (plan?.vehicle as string) ||
                    null;
                  const solver = (plan?.routing_solver as string) || null;
                  return (
                    <tr key={s.id}>
                      <td className="ref">
                        <ShipmentLink reference={s.reference} />
                      </td>
                      <td>
                        <Pill state={s.state} />
                      </td>
                      <td className="num">
                        <div>
                          {city(s.origin)} → {city(s.destination)}
                        </div>
                        {waypoints && waypoints.length > 2 ? (
                          <div className="text-faint text-xs">
                            via {waypoints.slice(1, -1).join(" → ")}
                          </div>
                        ) : null}
                      </td>
                      <td className="num">
                        <div>{vehicle ?? "—"}</div>
                        {solver ? (
                          <div className="text-faint text-xs">{solver}</div>
                        ) : null}
                      </td>
                      <td className="num">
                        {(plan?.modes as string[])?.join(" → ") ?? "—"}
                      </td>
                      <td className="num">
                        {plan?.distance_km ? `${plan.distance_km} km` : "—"}
                      </td>
                      <td className="num">
                        {plan?.estimated_cost_minor
                          ? money(
                              plan.estimated_cost_minor as number,
                              (plan.currency as string) ?? "NGN",
                            )
                          : "—"}
                        {plan?.priced_legs ? (
                          <span className="text-faint">
                            {" "}
                            {String(plan.priced_legs)}
                          </span>
                        ) : null}
                      </td>
                      <td className="num">
                        {plan?.co2e_kg ? `${plan.co2e_kg} kg` : "—"}
                      </td>
                      <td>
                        {meets === undefined || meets === null ? (
                          <span className="text-faint">—</span>
                        ) : (
                          <Pill state={meets ? "OK" : "ALERT"} />
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
