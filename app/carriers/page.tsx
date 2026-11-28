import { Empty, Offline, Panel, Pill } from "@/app/components";
import { AddCarrierForm, StarterNetworkButton } from "@/components/network-crud";
import { PaginationBar } from "@/components/pagination-bar";
import { TableSearchBar } from "@/components/table-search-bar";
import { paginateArray } from "@/lib/pagination";
import { listCarriers } from "@/lib/queries";
import { WEIGHTS, num, scoreCarrier } from "@/lib/scoring";

export const dynamic = "force-dynamic";

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(0)}%`;
}

export default async function Carriers({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; pageSize?: string }>;
}) {
  const { q, page, pageSize } = await searchParams;
  let carriers;
  try {
    carriers = await listCarriers();
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Carrier management</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const scored = carriers
    .map((c) => ({
      carrier: c,
      score: scoreCarrier({
        onTimeRate: num(c.on_time_rate),
        damageRate: num(c.damage_rate),
        availabilityRate: num(c.availability_rate),
        serviceScore: num(c.service_score),
        shipmentsCount: c.shipments_count,
      }),
    }))
    .sort((a, b) => b.score.normalised - a.score.normalised);

  const paged = paginateArray(scored, {
    q,
    page,
    pageSize,
    matcher: ({ carrier: c }, needle) =>
      `${c.name} ${c.code} ${c.integration} ${(c.modes ?? []).join(" ")}`
        .toLowerCase()
        .includes(needle),
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
          <h1>Carrier management</h1>
          <p>
            Selection is a weighted score, not a judgment call — so it is tunable,
            auditable, and cannot invent a carrier that does not exist. The model
            writes the rationale for the approval card; the arithmetic picks.
          </p>
        </div>
        {carriers.length === 0 ? <StarterNetworkButton /> : <StarterNetworkButton compact />}
      </div>

      <Panel title="Add carrier" hint="register a haulage, air, or ocean partner">
        <AddCarrierForm />
      </Panel>

      <div className="grid-2">
        <Panel title="Scoring model" hint="applied at quote time">
          <div className="weights">
            {Object.entries(WEIGHTS).map(([key, weight]) => (
              <div className="weight-row" key={key}>
                <span className="label">
                  {key.replace(/([A-Z])/g, " $1").toLowerCase()}
                </span>
                <span className="bar">
                  <span style={{ width: `${weight * 100 * 3.33}%` }} />
                </span>
                <span className="val">{(weight * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
          <p className="prose-note">
            Cost is 30% of the model but needs live quotes to normalise against.
            The scores below are the remaining 70% — the quality half of the
            model, which is what carrier history can tell you before anyone
            has quoted.
          </p>
        </Panel>

        <Panel title="Fleet" hint={`${carriers.length} carriers`}>
          <dl className="kv">
            <dt>approved</dt>
            <dd>
              {carriers.filter((c) => c.approved).length} of {carriers.length}
              <span className="text-faint">
                {" "}
                — unapproved carriers trip an approval gate regardless of amount
              </span>
            </dd>
            <dt>by integration</dt>
            <dd>
              {Object.entries(
                carriers.reduce<Record<string, number>>((acc, c) => {
                  acc[c.integration] = (acc[c.integration] ?? 0) + 1;
                  return acc;
                }, {}),
              )
                .map(([k, v]) => `${v} ${k.toLowerCase()}`)
                .join(" · ") || "—"}
            </dd>
            <dt>by mode</dt>
            <dd>
              {Object.entries(
                carriers.reduce<Record<string, number>>((acc, c) => {
                  for (const m of c.modes ?? []) acc[m] = (acc[m] ?? 0) + 1;
                  return acc;
                }, {}),
              )
                .map(([k, v]) => `${v} ${k.toLowerCase()}`)
                .join(" · ") || "—"}
            </dd>
          </dl>
        </Panel>
      </div>

      <TableSearchBar
        basePath="/carriers"
        initialQuery={paged.query}
        pageSize={paged.pageSize}
        placeholder="Search carrier name, code, mode, or integration…"
        label="Search carriers"
        summaryText={
          paged.total === 0
            ? "0 matching carriers"
            : `Showing ${paged.startIndex}–${paged.endIndex} of ${paged.total.toLocaleString()} carriers`
        }
      />

      <Panel
        title="Carriers by quality score"
        hint={`${paged.total.toLocaleString()} matching · page ${paged.page} of ${paged.totalPages}`}
        flush
      >
        {paged.items.length === 0 ? (
          <Empty
            message={paged.query ? "No matching carriers" : "No carriers yet"}
            hint={
              paged.query
                ? "Try clearing your search filter to view all registered carriers."
                : "Your carrier network is set up by an administrator. Once carriers are added, their on-time and damage records build up here as they run jobs."
            }
          />
        ) : (
          <>
            <div
              className="scroller"
              tabIndex={0}
              role="region"
              aria-label="Carriers by quality score"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Carrier</th>
                    <th scope="col">Modes</th>
                    <th scope="col">Integration</th>
                    <th scope="col">Approved</th>
                    <th scope="col">On-time</th>
                    <th scope="col">Damage</th>
                    <th scope="col">Availability</th>
                    <th scope="col">Service</th>
                    <th scope="col">Quality score</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.items.map(({ carrier: c, score }) => {
                    const tone =
                      score.normalised >= 0.85
                        ? undefined
                        : score.normalised >= 0.7
                          ? "warn"
                          : "alert";
                    return (
                      <tr key={c.id}>
                        <td>
                          <div className="font-semibold">{c.name}</div>
                          <div className="num text-faint text-xs">
                            {c.code}
                          </div>
                        </td>
                        <td className="num">{(c.modes ?? []).join(", ")}</td>
                        <td>
                          <Pill state={c.integration} />
                        </td>
                        <td>
                          {c.approved ? (
                            <Pill state="OK" />
                          ) : (
                            <Pill state="ALERT" />
                          )}
                        </td>
                        <td className="num">{pct(num(c.on_time_rate))}</td>
                        <td
                          className={`num${(num(c.damage_rate) ?? 0) > 0.05 ? " text-crit" : ""}`}
                        >
                          {pct(num(c.damage_rate))}
                        </td>
                        <td className="num">{pct(num(c.availability_rate))}</td>
                        <td className="num">{pct(num(c.service_score))}</td>
                        <td>
                          <div className="row-center">
                            <span className="bar" data-tone={tone}>
                              <span style={{ width: `${score.normalised * 100}%` }} />
                            </span>
                            <span className="num text-xs" style={{ minWidth: 34 }}>
                              {(score.normalised * 100).toFixed(0)}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <PaginationBar
              basePath="/carriers"
              page={paged.page}
              pageSize={paged.pageSize}
              total={paged.total}
              totalPages={paged.totalPages}
              startIndex={paged.startIndex}
              endIndex={paged.endIndex}
              queryParams={{ q: paged.query || undefined }}
              itemLabel="carriers"
            />
          </>
        )}
      </Panel>

      <Panel title="Why this ordering" hint="cost vs. reliability trade-off">
        <p className="prose">
          The cheapest carrier is frequently not the right one. A carrier with
          high availability but a high historical damage rate ranks lower on a
          shipment with a tight deadline or fragile cargo — because the weighted
          score penalises damage and late deliveries consistently on every
          shipment, rather than relying on an ad-hoc summary.
        </p>
      </Panel>
    </>
  );
}
