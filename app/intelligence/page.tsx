import { Offline } from "@/app/components";
import { BiWorkspace } from "@/components/intelligence/bi-workspace";
import { requireUser } from "@/lib/auth";
import { collectBiSnapshot } from "@/lib/intelligence/collector";

export const dynamic = "force-dynamic";

export default async function BusinessIntelligencePage() {
  const user = await requireUser();

  try {
    const initialSnapshot = await collectBiSnapshot({
      orgId: user.orgId,
      orgName: user.orgName,
      role: user.role,
      periodDays: 7,
    });

    return <BiWorkspace initialSnapshot={initialSnapshot} />;
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>AI Business Intelligence</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }
}
