import { headers } from "next/headers";
import { requireUser } from "@/lib/auth";
import { SYSTEM_CONNECTOR_TEMPLATES } from "@/lib/integrations/catalog";
import {
  listOrgConnectors,
  listOrgIntegrationEvents,
} from "@/lib/integrations/store";
import { IntegrationsHub } from "./integrations-hub";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const user = await requireUser();
  const head = await headers();
  const origin = `${head.get("x-forwarded-proto") ?? "http"}://${
    head.get("host") ?? "localhost:3000"
  }`;

  const [connectors, events] = await Promise.all([
    listOrgConnectors(user.orgId),
    listOrgIntegrationEvents(user.orgId, 60),
  ]);

  return (
    <>
      <div className="page-head">
        <h1>System integrations</h1>
        <p>
          Connect any ERP, TMS, WMS, storefront, GPS fleet feed, EDI X12 gateway, or
          custom webhook. The autonomous agent normalizes incoming payloads, executes
          planning and dispatch, and pushes status updates back to your systems.
        </p>
      </div>

      <IntegrationsHub
        initialConnectors={connectors}
        initialEvents={events}
        templates={SYSTEM_CONNECTOR_TEMPLATES}
        origin={origin}
        userRole={user.role}
      />
    </>
  );
}
