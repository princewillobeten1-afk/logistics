import { headers } from "next/headers";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { listOrgConnectors } from "@/lib/integrations/store";
import { ApiDocsClient } from "./api-docs-client";

export const dynamic = "force-dynamic";

export default async function ApiDocsPage() {
  const user = await requireUser();
  const head = await headers();
  const proto = head.get("x-forwarded-proto") ?? "http";
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "localhost:3000";
  const origin = `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;

  const connectors = await listOrgConnectors(user.orgId);

  return (
    <>
      <div className="page-head docs-page-head">
        <div className="docs-page-head-copy">
          <h1>ERP &amp; TMS API documentation</h1>
          <p>
            Reference documentation and production code snippets for integrating external ERP,
            TMS, WMS, storefront, and fleet telematics platforms with Control Tower.
          </p>
        </div>
        <div className="docs-page-head-actions">
          <Link href="/integrations" className="btn btn-primary">
            <span>Manage API keys &amp; connectors</span>
            <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
          </Link>
        </div>
      </div>

      <ApiDocsClient
        origin={origin}
        orgName={user.orgName}
        connectors={connectors}
      />
    </>
  );
}
