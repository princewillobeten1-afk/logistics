import { Offline } from "@/app/components";
import { TacticsWorkspace } from "@/components/tactics/tactics-workspace";
import { requireUser } from "@/lib/auth";
import { collectTacticsSnapshot } from "@/lib/tactics/store";

export const dynamic = "force-dynamic";

export default async function LogisticsTacticsPage() {
  const user = await requireUser();

  try {
    const initialSnapshot = await collectTacticsSnapshot({
      orgId: user.orgId,
      orgName: user.orgName,
    });

    return (
      <TacticsWorkspace initialSnapshot={initialSnapshot} userRole={user.role} />
    );
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Logistics Strategy Tactics</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }
}
