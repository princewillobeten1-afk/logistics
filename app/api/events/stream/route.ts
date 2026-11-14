import { currentUser } from "@/lib/auth";
import { queryAs } from "@/lib/db";

// Needs the pg driver, and must never be cached or statically rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_MS = 2000;
const HEARTBEAT_MS = 20_000;
// A client that has been away long enough to miss more than this gets the
// most recent slice rather than a catch-up flood it would only discard.
const MAX_BATCH = 50;

type Row = {
  id: string;
  type: string;
  actor: string;
  to_state: string | null;
  created_at: Date;
  reference: string | null;
};

/**
 * Server-sent events over `shipment_events` (§37).
 *
 * **The stream carries "something changed", not the change itself.** Clients
 * respond by re-reading the page through the normal server components, which
 * is what makes the whole thing safe: `shipment_events.id` comes from a
 * sequence, and sequences commit out of order — a row with id 100 can become
 * visible while 99 is still uncommitted, so polling `id > last` can step over
 * one. If the payload were the data, that would be a silently lost update.
 * Because it is only a nudge, a skipped id costs nothing: the next event
 * triggers a full re-read that includes whatever was missed, and the page
 * never renders from the stream.
 *
 * Polling rather than LISTEN/NOTIFY on purpose. NOTIFY needs a dedicated
 * connection held open per client, and the pool has five; a 2-second poll of
 * an indexed `id >` on an append-only table is cheaper than that at any scale
 * this system will see.
 */
export async function GET(request: Request): Promise<Response> {
  // Middleware only saw that a cookie exists. This is where it is verified.
  const user = await currentUser();
  if (!user) {
    return new Response("Not signed in.", { status: 401 });
  }
  const orgId = user.orgId;

  // Resume where the client left off. `Last-Event-ID` is sent automatically by
  // EventSource on reconnect, so a dropped connection does not replay from the
  // beginning of time.
  const url = new URL(request.url);
  const resumeFrom =
    request.headers.get("last-event-id") ?? url.searchParams.get("since");

  let cursor = resumeFrom !== null ? Number(resumeFrom) : null;
  if (cursor !== null && !Number.isFinite(cursor)) cursor = null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client went away between the abort signal and this write.
          closed = true;
        }
      };

      const shutdown = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime; nothing to do.
        }
      };

      request.signal.addEventListener("abort", shutdown);

      // A first frame immediately, so the browser treats the connection as
      // open rather than sitting in a connecting state until the first event.
      send(": connected\n\n");

      if (cursor === null) {
        // No resume point: start from now. Replaying history on a fresh page
        // load would fire a refresh for every event ever recorded.
        try {
          const [latest] = await queryAs<{ id: string | null }>(
            orgId,
            "SELECT max(id)::text AS id FROM shipment_events",
          );
          cursor = Number(latest?.id ?? 0);
        } catch {
          cursor = 0;
        }
      }

      let sinceHeartbeat = 0;

      const tick = async () => {
        if (closed) return;
        try {
          const rows = await queryAs<Row>(
            orgId,
            `SELECT e.id::text, e.type, e.actor, e.to_state, e.created_at,
                    s.reference
               FROM shipment_events e
               JOIN shipments s ON s.id = e.shipment_id
              WHERE e.id > $1
              ORDER BY e.id
              LIMIT $2`,
            [cursor, MAX_BATCH],
          );

          for (const row of rows) {
            cursor = Number(row.id);
            send(
              `id: ${row.id}\n` +
                `event: shipment\n` +
                `data: ${JSON.stringify({
                  id: row.id,
                  type: row.type,
                  actor: row.actor,
                  state: row.to_state,
                  reference: row.reference,
                  at: row.created_at,
                })}\n\n`,
            );
          }

          sinceHeartbeat += POLL_MS;
          if (rows.length === 0 && sinceHeartbeat >= HEARTBEAT_MS) {
            // Comment frames keep proxies and load balancers from treating an
            // idle stream as dead. They are ignored by EventSource.
            send(": keep-alive\n\n");
            sinceHeartbeat = 0;
          } else if (rows.length > 0) {
            sinceHeartbeat = 0;
          }
        } catch (error) {
          // A failed poll is not fatal — Postgres restarting, a pool timeout.
          // Report it and keep the connection; the next tick usually works,
          // and dropping the stream would make every client reconnect at once.
          send(
            `event: warning\ndata: ${JSON.stringify({
              message: error instanceof Error ? error.message : "poll failed",
            })}\n\n`,
          );
        }

        if (!closed) timer = setTimeout(tick, POLL_MS);
      };

      timer = setTimeout(tick, POLL_MS);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx buffers proxied responses by default, which holds every frame
      // until the buffer fills — for a stream that means nothing arrives.
      "X-Accel-Buffering": "no",
    },
  });
}
