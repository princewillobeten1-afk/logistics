import { headers } from "next/headers";
import Link from "next/link";
import { BookOpen } from "lucide-react";
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
      <div className="page-head docs-page-head">
        <div className="docs-page-head-copy">
          <h1>System integrations</h1>
          <p>
            Connect your company website, live PostgreSQL database, ERP/WMS/TMS/GPS API, or
            full database export. Control Tower imports your master data and orders
            automatically, then takes over route planning, carrier scoring, fleet dispatch,
            and status callbacks end-to-end.
          </p>
        </div>
        <div className="docs-page-head-actions">
          <Link href="/api-docs" className="btn">
            <BookOpen size={14} strokeWidth={1.9} aria-hidden="true" />
            <span>ERP / TMS API Docs</span>
          </Link>
        </div>
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
