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
        <h1>AI Customer Support Agent</h1>
        <p>
          Customer-facing assistance across Website Chat, WhatsApp, and
          Telegram. Tracks live shipments, accepts new order bookings, and
          initiates fulfillment or issue resolution immediately while keeping
          carrier buy rates and internal policy details private.
        </p>
      </div>

      <TrackChat initialReference={ref} />

      <Panel title="Channel capabilities & data privacy">
        <p className="prose" style={{ marginBottom: 10 }}>
          Customers can track existing shipments, place new orders, request
          route adjustments, or escalate delivery issues across Website Chat,
          WhatsApp (`/api/webhooks/whatsapp`), and Telegram
          (`/api/webhooks/telegram`). Every actionable request starts backend
          fulfillment automatically.
        </p>
        <p className="prose">
          The AI Customer Support Agent uses an allowlisted shipment view —
          carrier buy rates, quotes, scoring weights, and internal margins never
          reach customer replies.
        </p>
      </Panel>
    </>
  );
}
