import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { relative, when } from "@/lib/format";
import { listCustoms, listDocuments } from "@/lib/queries";

export const dynamic = "force-dynamic";

const DOC_TYPES = [
  ["BOL", "road", "generated at dispatch"],
  ["AWB", "air", "generated at dispatch"],
  ["SEA_WAYBILL", "sea", "generated at dispatch"],
  ["PACKING_LIST", "all", "generated at dispatch"],
  ["COMMERCIAL_INVOICE", "international", "required for customs"],
  ["CUSTOMS_DECLARATION", "international", "HS codes, declared value, duty"],
  ["POD", "all", "read automatically at delivery"],
];

export default async function Documents() {
  let documents, customs;
  try {
    [documents, customs] = await Promise.all([listDocuments(), listCustoms()]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Documents and compliance</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  const unverified = documents.filter((d) => !d.verified_at);

  return (
    <>
      <div className="page-head">
        <h1>Documents and compliance</h1>
        <p>
          Paperwork generated on dispatch and read back on delivery. Scanned
          documents and delivery photos are read automatically, so details do
          not have to be keyed in by hand.
        </p>
      </div>

      <dl className="tiles">
        <div className="tile">
          <dt>Documents</dt>
          <dd>{documents.length}</dd>
        </div>
        <div className="tile warn">
          <dt>Awaiting verification</dt>
          <dd>{unverified.length}</dd>
          <small>low-confidence extractions go to a human</small>
        </div>
        <div className="tile">
          <dt>Customs declarations</dt>
          <dd>{customs.length}</dd>
        </div>
        <div className="tile alert">
          <dt>Held at customs</dt>
          <dd>{customs.filter((c) => c.clearance_state === "HELD").length}</dd>
        </div>
      </dl>

      <Panel title="Document types" hint="by mode" flush>
        <div
          className="scroller"
          tabIndex={0}
          role="region"
          aria-label="Document types"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Applies to</th>
                <th scope="col">When</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {DOC_TYPES.map(([kind, applies, note]) => (
                <tr key={kind}>
                  <td className="ref">{kind.replace(/_/g, " ")}</td>
                  <td className="num">{applies}</td>
                  <td className="text-muted">{note}</td>
                  <td>
                    <Pill state="PENDING" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Document log" hint={`${documents.length} stored`} flush>
        {documents.length === 0 ? (
          <Empty
            message="No documents yet"
            hint="Waybills and delivery notes are filed here as shipments are dispatched and delivered."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Document log"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Shipment</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Extracted by</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">Verified</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.id}>
                    <td className="num text-faint">
                      {relative(d.created_at)}
                    </td>
                    <td className="ref">
                      <ShipmentLink reference={d.reference} />
                    </td>
                    <td>
                      <Pill state={d.kind} />
                    </td>
                    <td className="num text-muted">
                      {d.extraction_model?.replace("nvidia/", "") ?? "—"}
                    </td>
                    <td className="num">
                      {d.extraction_confidence
                        ? `${(Number(d.extraction_confidence) * 100).toFixed(0)}%`
                        : "—"}
                    </td>
                    <td>
                      {d.verified_at ? (
                        <Pill state="OK" />
                      ) : (
                        <Pill state="PENDING" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Customs" hint="attached to the leg that crosses the border" flush>
        {customs.length === 0 ? (
          <Empty
            message="No customs declarations"
            hint="Raised for international shipments — only the border-crossing leg needs one."
          />
        ) : (
          <div
            className="scroller"
            tabIndex={0}
            role="region"
            aria-label="Customs declarations"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Shipment</th>
                  <th scope="col">Direction</th>
                  <th scope="col">HS codes</th>
                  <th scope="col">Broker</th>
                  <th scope="col">Clearance</th>
                  <th scope="col">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {customs.map((c) => (
                  <tr key={c.id}>
                    <td className="ref">
                      <ShipmentLink reference={c.reference} />
                    </td>
                    <td className="num">{c.direction.toLowerCase()}</td>
                    <td className="num">{(c.hs_codes ?? []).join(", ") || "—"}</td>
                    <td>{c.broker ?? "—"}</td>
                    <td>
                      <Pill
                        state={
                          c.clearance_state === "HELD" ? "ALERT" : c.clearance_state
                        }
                      />
                    </td>
                    <td className="num">{when(c.submitted_at)}</td>
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
