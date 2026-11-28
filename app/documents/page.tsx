import { Download } from "lucide-react";
import { Empty, Offline, Panel, Pill, ShipmentLink } from "@/app/components";
import { DocumentUploadPanel } from "@/components/documents/document-upload-panel";
import { PaginationBar } from "@/components/pagination-bar";
import { TableSearchBar } from "@/components/table-search-bar";
import { currentUser, may } from "@/lib/auth";
import { relative, when } from "@/lib/format";
import { paginateArray } from "@/lib/pagination";
import { listCustoms, listDocuments, listShipments } from "@/lib/queries";

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

export default async function Documents({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; pageSize?: string }>;
}) {
  const [user, sp] = await Promise.all([currentUser(), searchParams]);
  let documents, customs, shipments;
  try {
    [documents, customs, shipments] = await Promise.all([
      listDocuments(),
      listCustoms(),
      listShipments(),
    ]);
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
  const canUpload = Boolean(user && may(user.role, "EDIT_SHIPMENT"));
  const shipmentReferences = shipments.slice(0, 50).map((s) => s.reference);

  const pagedDocuments = paginateArray(documents, {
    q: sp.q,
    page: sp.page,
    pageSize: sp.pageSize,
    matcher: (d, q) =>
      (d.reference ?? "").toLowerCase().includes(q) ||
      d.kind.toLowerCase().includes(q) ||
      (d.filename ?? "").toLowerCase().includes(q) ||
      (d.extraction_model ?? "").toLowerCase().includes(q),
  });

  const pagedCustoms = paginateArray(customs, {
    q: sp.q,
    page: sp.page,
    pageSize: sp.pageSize,
    matcher: (c, q) =>
      (c.reference ?? "").toLowerCase().includes(q) ||
      c.direction.toLowerCase().includes(q) ||
      (c.broker ?? "").toLowerCase().includes(q) ||
      c.clearance_state.toLowerCase().includes(q) ||
      (c.hs_codes ?? []).some((hs) => hs.toLowerCase().includes(q)),
  });

  const queryParams = { q: pagedDocuments.query || undefined };

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

      <TableSearchBar
        basePath="/documents"
        initialQuery={pagedDocuments.query}
        pageSize={pagedDocuments.pageSize}
        placeholder="Filter documents and customs by shipment, type, file, broker, or HS code…"
        label="Search documents and customs"
        summaryText={`${pagedDocuments.total} document(s) · ${pagedCustoms.total} customs declaration(s)`}
      />

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

      {canUpload && (
        <Panel
          title="Upload workspace document"
          hint="stored in your organisation's isolated document vault"
        >
          <DocumentUploadPanel shipmentReferences={shipmentReferences} />
        </Panel>
      )}

      <Panel title="Document log" hint={`${pagedDocuments.total} stored`} flush>
        {pagedDocuments.items.length === 0 ? (
          <Empty
            message={
              pagedDocuments.query
                ? `No documents matching "${pagedDocuments.query}"`
                : "No documents yet"
            }
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
                  <th scope="col">File</th>
                  <th scope="col">Extracted by</th>
                  <th scope="col">Confidence</th>
                  <th scope="col">Verified</th>
                </tr>
              </thead>
              <tbody>
                {pagedDocuments.items.map((d) => (
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
                    <td className="text-xs">
                      {d.filename ? (
                        <a
                          href={`/api/documents/${encodeURIComponent(d.id)}/download`}
                          className="inline-flex items-center gap-1 font-mono text-[var(--accent)] hover:underline"
                        >
                          <Download className="h-3.5 w-3.5" />
                          {d.filename}
                        </a>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
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
        <PaginationBar
          basePath="/documents"
          page={pagedDocuments.page}
          pageSize={pagedDocuments.pageSize}
          total={pagedDocuments.total}
          totalPages={pagedDocuments.totalPages}
          startIndex={pagedDocuments.startIndex}
          endIndex={pagedDocuments.endIndex}
          queryParams={queryParams}
          itemLabel="documents"
        />
      </Panel>

      <Panel
        title="Customs"
        hint={`${pagedCustoms.total} declaration(s) · attached to the leg that crosses the border`}
        flush
      >
        {pagedCustoms.items.length === 0 ? (
          <Empty
            message={
              pagedCustoms.query
                ? `No customs declarations matching "${pagedCustoms.query}"`
                : "No customs declarations"
            }
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
                {pagedCustoms.items.map((c) => (
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
        <PaginationBar
          basePath="/documents"
          page={pagedCustoms.page}
          pageSize={pagedCustoms.pageSize}
          total={pagedCustoms.total}
          totalPages={pagedCustoms.totalPages}
          startIndex={pagedCustoms.startIndex}
          endIndex={pagedCustoms.endIndex}
          queryParams={queryParams}
          itemLabel="customs declarations"
        />
      </Panel>
    </>
  );
}
