import { Panel } from "@/app/components";
import { TrackChat } from "@/app/track/chat";

export const dynamic = "force-dynamic";

export default async function Track({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const { ref } = await searchParams;

  return (
    <>
      <div className="page-head">
        <h1>Customer support</h1>
        <p>
          What a customer sees when they track a shipment and ask about it. The
          agent answers from live data and can only see this one shipment —
          carrier costs, quotes and internal states never reach it.
        </p>
      </div>

      <TrackChat initialReference={ref} />

      <Panel title="What a customer can and cannot see">
        <p className="prose" style={{ marginBottom: 10 }}>
          The assistant is given a deliberately narrow view of one shipment. A
          detail reaches the customer only if it has been explicitly allowed —
          what you pay a carrier, the quotes you compared and your internal
          status are never among them.
        </p>
        <p className="prose">
          Several of your stages read as one to the customer. “Finding a
          carrier” and “waiting for approval” both appear as{" "}
          <em>arranging transport</em>, because from outside they mean the same
          thing: it has not left yet. Every reply is recorded, so you can always
          see what a customer was told.
        </p>
      </Panel>

      <Panel title="Before you share tracking with customers">
        <p className="prose">
          Anyone who knows a shipment reference can look it up here, and
          references run in sequence — so one customer could guess another&rsquo;s.
          Nothing commercially sensitive is exposed either way, but a delivery
          address and timing are. Treat this as a preview until tracking links
          are tied to something only the recipient knows.
        </p>
      </Panel>
    </>
  );
}
