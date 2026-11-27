import { notFound, unstable_rethrow } from "next/navigation";
import { Assistant } from "./assistant";
import { Empty, Offline, Panel, Pill } from "@/app/components";
import { ShipmentCorridorSection } from "@/components/shipment-corridor-section";
import { city, labelFor, money, relative, when } from "@/lib/format";
import { getServerMapsApiKey } from "@/lib/maps-config";
import { extractPointFromAddress, resolveLocationCoordinates } from "@/lib/maps-grounding";
import { getEvents, getLegs, getQuotes, getShipment, listLocations } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function ShipmentDetail({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const { reference } = await params;
  const decodedReference = decodeURIComponent(reference);

  let shipment;
  try {
    shipment = await getShipment(decodedReference);
  } catch (error) {
    unstable_rethrow(error);
    return (
      <>
        <div className="page-head">
          <h1>{decodedReference}</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  if (!shipment) notFound();

  let events, legs, quotes, locations;
  try {
    [events, legs, quotes, locations] = await Promise.all([
      getEvents(shipment.id),
      getLegs(shipment.id),
      getQuotes(shipment.id),
      listLocations(),
    ]);
  } catch (error) {
    unstable_rethrow(error);
    return (
      <>
        <div className="page-head">
          <h1>{shipment.reference}</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const plan = shipment.plan as Record<string, unknown> | null;
  const allocation = shipment.allocation as Record<string, unknown> | null;
  const originCity = city(shipment.origin);
  const destinationCity = city(shipment.destination);
  const originPoint =
    extractPointFromAddress(shipment.origin) ??
    resolveLocationCoordinates(originCity, locations);
  const destinationPoint =
    extractPointFromAddress(shipment.destination) ??
    resolveLocationCoordinates(destinationCity, locations);
  const mapsApiKey = getServerMapsApiKey();
  const isAlert = ["EXCEPTION", "NEEDS_INFO", "AWAITING_APPROVAL"].includes(shipment.state);

  const rawPlanDist = plan?.distance_km !== undefined ? Number(plan.distance_km) : NaN;
  const legDistSum = legs.reduce((acc, l) => acc + (Number(l.distance_km) || 0), 0);
  const plannedDistanceKm =
    Number.isFinite(rawPlanDist) && rawPlanDist > 0
      ? rawPlanDist
      : legDistSum > 0
        ? legDistSum
        : null;
  const rawPlanTransit = plan?.transit_hours !== undefined ? Number(plan.transit_hours) : NaN;
  const plannedTransitHours =
    Number.isFinite(rawPlanTransit) && rawPlanTransit > 0 ? rawPlanTransit : null;
  const plannedModes = Array.isArray(plan?.modes)
    ? plan.modes.map((m) => String(m))
    : legs.map((l) => l.mode).filter(Boolean);
  const rawLegsCount = plan?.legs !== undefined ? Number(plan.legs) : NaN;
  const plannedLegsCount =
    Number.isFinite(rawLegsCount) && rawLegsCount > 0
      ? rawLegsCount
      : legs.length > 0
        ? legs.length
        : null;
  const plannedVehicle = plan?.vehicle ? String(plan.vehicle) : null;
  const rawCo2e = plan?.co2e_kg !== undefined ? Number(plan.co2e_kg) : NaN;
  const plannedCo2eKg = Number.isFinite(rawCo2e) && rawCo2e > 0 ? rawCo2e : null;
  const meetsDeadline =
    typeof plan?.meets_deadline === "boolean" ? plan.meets_deadline : null;

  return (
    <>
      <div className="page-head">
        <h1>
          <span className="font-mono">{shipment.reference}</span>
          <Pill state={shipment.state} />
        </h1>
        <p>
          {originCity} → {destinationCity} · version{" "}
          {shipment.version} · updated {relative(shipment.updated_at)}
        </p>
      </div>

      <Assistant reference={shipment.reference} />

      <Panel
        title="Corridor map & route summary"
        hint={`${originCity} → ${destinationCity}`}
      >
        <ShipmentCorridorSection
          apiKey={mapsApiKey}
          origin={originPoint}
          destination={destinationPoint}
          originCity={originCity}
          destinationCity={destinationCity}
          originLabel={String(shipment.origin?.address ?? originCity)}
          destinationLabel={String(shipment.destination?.address ?? destinationCity)}
          alert={isAlert}
          plannedDistanceKm={plannedDistanceKm}
          plannedTransitHours={plannedTransitHours}
          plannedModes={plannedModes}
          plannedLegsCount={plannedLegsCount}
          plannedVehicle={plannedVehicle}
          plannedCo2eKg={plannedCo2eKg}
          meetsDeadline={meetsDeadline}
        />
      </Panel>

      <div className="grid-2">
        <Panel title="Order">
          <dl className="kv">
            <dt>customer</dt>
            <dd>{shipment.customer_ref ?? "—"}</dd>
            <dt>origin</dt>
            <dd>
              <div>
                {(shipment.origin?.address as string) ?? city(shipment.origin)}
                {shipment.origin?.country ? `, ${String(shipment.origin.country)}` : ""}
              </div>
              {shipment.origin?.contact_name ||
              shipment.origin?.contact_phone ||
              shipment.origin?.contact_email ? (
                <div className="text-faint text-xs">
                  {[
                    shipment.origin?.contact_name as string | undefined,
                    shipment.origin?.contact_phone as string | undefined,
                    shipment.origin?.contact_email as string | undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              ) : null}
            </dd>
            <dt>destination</dt>
            <dd>
              <div>
                {(shipment.destination?.address as string) ??
                  city(shipment.destination)}
                {shipment.destination?.country
                  ? `, ${String(shipment.destination.country)}`
                  : ""}
              </div>
              {shipment.destination?.contact_name ||
              shipment.destination?.contact_phone ||
              shipment.destination?.contact_email ? (
                <div className="text-faint text-xs">
                  {[
                    shipment.destination?.contact_name as string | undefined,
                    shipment.destination?.contact_phone as string | undefined,
                    shipment.destination?.contact_email as string | undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              ) : null}
            </dd>
            <dt>cargo</dt>
            <dd>
              <div>
                {(shipment.cargo?.quantity as number) ?? "—"} ×{" "}
                {(shipment.cargo?.weight_kg as number) ?? "—"} kg
                {shipment.cargo?.description
                  ? ` — ${shipment.cargo.description}`
                  : ""}
              </div>
              {shipment.cargo?.hs_code ||
              shipment.cargo?.incoterm ||
              shipment.cargo?.preferred_mode ? (
                <div className="text-faint text-xs">
                  {[
                    shipment.cargo?.preferred_mode
                      ? `Mode: ${String(shipment.cargo.preferred_mode)}`
                      : null,
                    shipment.cargo?.hs_code
                      ? `HS: ${String(shipment.cargo.hs_code)}`
                      : null,
                    shipment.cargo?.incoterm
                      ? `Incoterm: ${String(shipment.cargo.incoterm)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              ) : null}
            </dd>
            {shipment.origin?.wpcargo_reference ? (
              <>
                <dt>wpcargo portal</dt>
                <dd className="font-mono">
                  <a
                    href="https://test.swiftparcelcourier.com/track/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="auth-link"
                  >
                    {String(shipment.origin.wpcargo_reference)}
                  </a>
                  {shipment.origin?.wpcargo_edit_url ? (
                    <>
                      {" "}
                      <a
                        href={String(shipment.origin.wpcargo_edit_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-faint text-xs"
                      >
                        (admin post #{String(shipment.origin.wpcargo_post_id ?? "")})
                      </a>
                    </>
                  ) : null}
                </dd>
              </>
            ) : null}
            <dt>deadline</dt>
            <dd>
              {when(shipment.deadline)}{" "}
              <span className="text-faint">
                ({relative(shipment.deadline)})
              </span>
            </dd>
            <dt>created</dt>
            <dd>{when(shipment.created_at)}</dd>
          </dl>
        </Panel>

        <Panel title="Plan" hint={plan ? `${plan.legs} leg(s)` : undefined}>
          {!plan ? (
            <Empty
              message="Not planned yet"
              hint="Route planning runs once inventory stock is allocated."
            />
          ) : (
            <dl className="kv">
              <dt>modes</dt>
              <dd>{(plan.modes as string[])?.join(" → ") ?? "—"}</dd>
              <dt>distance</dt>
              <dd className="font-mono">{String(plan.distance_km ?? "—")} km</dd>
              <dt>transit</dt>
              <dd className="font-mono">{String(plan.transit_hours ?? "—")} h</dd>
              <dt>vehicle</dt>
              <dd>{String(plan.vehicle ?? "—")}</dd>
              {plan.routing_solver ? (
                <>
                  <dt>routing solver</dt>
                  <dd className="font-mono">{String(plan.routing_solver)}</dd>
                </>
              ) : null}
              {Array.isArray(plan.waypoints) && plan.waypoints.length > 0 ? (
                <>
                  <dt>waypoints</dt>
                  <dd>{(plan.waypoints as string[]).join(" → ")}</dd>
                </>
              ) : null}
              <dt>estimated cost</dt>
              <dd className="font-mono">
                {money(
                  (plan.estimated_cost_minor as number) ?? null,
                  (plan.currency as string) ?? "NGN",
                )}
                {plan.priced_legs ? (
                  <span className="text-faint">
                    {" "}
                    ({String(plan.priced_legs)} legs priced)
                  </span>
                ) : null}
              </dd>
              <dt>emissions</dt>
              <dd className="font-mono">{String(plan.co2e_kg ?? "—")} kg CO2e</dd>
              <dt>meets deadline</dt>
              <dd>
                {plan.meets_deadline === undefined ? (
                  "—"
                ) : (
                  <Pill state={plan.meets_deadline ? "OK" : "ALERT"} />
                )}
              </dd>
              <dt>confidence</dt>
              <dd>{String(plan.confidence ?? "—")}</dd>
              {plan.ai_route_notes ? (
                <>
                  <dt>route advisory</dt>
                  <dd className="text-muted text-xs">{String(plan.ai_route_notes)}</dd>
                </>
              ) : null}
              {plan.customs_required ? (
                <>
                  <dt>customs</dt>
                  <dd>required</dd>
                </>
              ) : null}
            </dl>
          )}
        </Panel>
      </div>

      {quotes.length > 0 ? (
        <Panel
          title="Carrier quotes"
          hint={`round ${quotes[0].round} · deterministic weighted scoring`}
          flush
        >
          <div className="scroller" tabIndex={0} role="region" aria-label="Carrier quotes">
            <table>
              <thead>
                <tr>
                  <th scope="col">Carrier</th>
                  <th scope="col">State</th>
                  <th scope="col">Source</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Transit</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">Score</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => (
                  <tr key={q.id}>
                    <td>
                      <div className="font-semibold">{q.carrier_code}</div>
                      {q.raw_text ? (
                        <span className="quote-raw">“{q.raw_text.slice(0, 60)}”</span>
                      ) : null}
                    </td>
                    <td>
                      <Pill state={q.state} />
                    </td>
                    <td className="num">{q.source}</td>
                    <td className="num">
                      {money(q.amount_minor, q.currency ?? "NGN")}
                    </td>
                    <td className="num">
                      {q.transit_hours ? `${Number(q.transit_hours)} h` : "—"}
                    </td>
                    <td className="num">
                      {q.confidence
                        ? `${(Number(q.confidence) * 100).toFixed(0)}%`
                        : "—"}
                      {q.parsed_by ? (
                        <span className="text-faint"> parsed</span>
                      ) : null}
                    </td>
                    <td>
                      {q.score === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        <div className="row-center">
                          <span className="bar">
                            <span style={{ width: `${Number(q.score) * 100}%` }} />
                          </span>
                          <span className="font-mono text-xs">
                            {(Number(q.score) * 100).toFixed(0)}
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel title="Legs" hint="one row per mode change" flush>
        {legs.length === 0 ? (
          <Empty message="No legs yet" hint="Route legs appear once corridor planning completes." />
        ) : (
          <div className="body">
            <ul className="legs" role="list">
              {legs.map((leg) => (
                <li key={leg.sequence} className="leg">
                  <span className="meta">#{leg.sequence}</span>
                  <Pill state={leg.mode} />
                  <span className="where">
                    {(leg.metadata?.origin_name as string) ?? "—"} →{" "}
                    {(leg.metadata?.destination_name as string) ?? "—"}
                  </span>
                  <Pill state={leg.state} />
                  <span className="meta">
                    {leg.distance_km ? `${Number(leg.distance_km)} km` : "—"}
                    {leg.load_type ? ` · ${leg.load_type}` : ""}
                    {leg.co2e_kg ? ` · ${Number(leg.co2e_kg)} kg CO2e` : ""}
                  </span>
                  <span className="meta cost-right">
                    {leg.cost_minor
                      ? money(leg.cost_minor, leg.currency ?? "NGN")
                      : (leg.metadata?.pricing as string) === "carrier_quote"
                        ? "carrier quote"
                        : "unpriced"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      <div className="grid-2">
        <Panel title="Timeline" hint={`${events.length} events`}>
          <ol className="timeline">
            {events.map((e) => (
              <li key={e.seq}>
                <span className="seq">{e.seq}</span>
                <span className="what">
                  <b>{labelFor(e.type)}</b>
                  {e.to_state ? (
                    <div className="move">
                      {e.from_state ?? "—"} → {e.to_state}
                    </div>
                  ) : null}
                  {typeof e.payload?.customer_message === "string" ? (
                    <div className="move text-warn">
                      “{e.payload.customer_message}”
                    </div>
                  ) : null}
                  {typeof e.payload?.rationale === "string" ? (
                    <div className="move">{e.payload.rationale}</div>
                  ) : null}
                </span>
                <span className="who">{e.actor}</span>
              </li>
            ))}
          </ol>
        </Panel>

        <Panel title="Allocation">
          {!allocation ? (
            <Empty
              message="Not allocated yet"
              hint="Stock allocation reserves warehouse units once the order validates."
            />
          ) : (
            <>
              <dl className="kv">
                <dt>sku</dt>
                <dd>{String(allocation.sku ?? "—")}</dd>
                <dt>quantity</dt>
                <dd className="font-mono">{String(allocation.quantity ?? "—")}</dd>
                <dt>from</dt>
                <dd>
                  {(allocation.lines as { warehouse: string; quantity: number }[])
                    ?.map((l) => `${l.warehouse} ×${l.quantity}`)
                    .join(", ") ?? "—"}
                </dd>
                <dt>meets deadline</dt>
                <dd>
                  {allocation.meets_deadline === null ? (
                    "no deadline"
                  ) : (
                    <Pill state={allocation.meets_deadline ? "OK" : "ALERT"} />
                  )}
                </dd>
              </dl>
              {allocation.rationale ? (
                <p className="prose-note">
                  {String(allocation.rationale)}
                </p>
              ) : null}
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
