import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { OptimizeFleetButton } from "@/app/planning/optimize-button";
import { RoutingRequestForm } from "@/app/planning/routing-request-form";
import { RunConsolidationButton } from "@/components/lifecycle-panels";
import { city, money } from "@/lib/format";
import { legStats, listConsolidationGroups, listShipments } from "@/lib/queries";

export const dynamic = "force-dynamic";

const OBJECTIVES = [
  ["Cost", "carrier base rate plus cargo weight surcharge"],
  ["Delivery time", "warehouse dispatch lead plus transit matrix against deadline"],
  ["Consolidation", "pre-sourcing pooling of matching LTL/LCL orders into high-utilization loads"],
  ["Fleet routing", "capacity and time-window optimisation across active vehicles"],
  ["Corridor advisory", "automated waypoint, weather, and border risk evaluation"],
  ["Carbon footprint", "mode-weighted emissions estimate (kg CO2e per tonne-km)"],
];

export default async function Planning() {
  let toPlan, planned, sourcing, legs, consolidations;
  try {
    [toPlan, planned, sourcing, legs, consolidations] = await Promise.all([
      listShipments("ALLOCATED"),
      listShipments("PLANNED"),
      listShipments("SOURCING"),
      legStats(),
      listConsolidationGroups(),
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
            Multimodal corridor selection, pre-sourcing LTL/LCL shipment
            consolidation, vehicle routing across active fleet capacity, and
            automated corridor risk advisory.
          </p>
        </div>
        <div className="row-center" style={{ gap: 10, flexWrap: "wrap" }}>
          <RunConsolidationButton />
          <OptimizeFleetButton />
        </div>
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
        title="Pre-sourcing freight consolidation pools"
        hint={`${consolidations.length} consolidated load(s)`}
        flush
      >
        {consolidations.length === 0 ? (
          <Empty
            message="No consolidation pools yet"
            hint="When 2+ LTL/LCL shipments share the same lane and mode in ALLOCATED/PLANNED state, Pool LTL / LCL Shipments merges them to cut freight cost."
          />
        ) : (
          <div className="scroller" tabIndex={0} role="region" aria-label="Consolidation pools">
            <table>
              <thead>
                <tr>
                  <th scope="col">Pool Ref</th>
                  <th scope="col">Status</th>
                  <th scope="col">Corridor</th>
                  <th scope="col">Mode / Load</th>
                  <th scope="col">Shipments</th>
                  <th scope="col">Weight / Vol</th>
                  <th scope="col">Utilisation</th>
                  <th scope="col">Est. Savings</th>
                </tr>
              </thead>
              <tbody>
                {consolidations.map((g) => {
                  const util = Number(g.utilization_pct ?? 0);
                  return (
                    <tr key={g.id}>
                      <td className="ref">{g.reference}</td>
                      <td>
                        <Pill state={g.status} />
                      </td>
                      <td>
                        {g.origin_city} → {g.destination_city}
                      </td>
                      <td className="num">
                        {g.mode} · {g.load_type}
                      </td>
                      <td className="ref">
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {(g.shipment_refs ?? []).map((ref) => (
                            <ShipmentLink key={ref} reference={ref} />
                          ))}
                        </div>
                      </td>
                      <td className="num">
                        {Number(g.total_weight_kg).toLocaleString()} kg · {Number(g.total_volume_cbm).toFixed(2)} cbm
                      </td>
                      <td style={{ width: 130 }}>
                        <div className="text-xs text-muted">{util.toFixed(1)}%</div>
                        <span className="bar">
                          <span style={{ width: `${Math.min(100, util)}%` }} />
                        </span>
                      </td>
                      <td className="num">{money(g.estimated_savings_minor, g.currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

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
