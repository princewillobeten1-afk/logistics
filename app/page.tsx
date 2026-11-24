import { Offline } from "@/app/components";
import { ControlTowerDashboard } from "@/components/control-tower/control-tower-dashboard";
import { currentUser } from "@/lib/auth";
import { controlTowerSummary, deadWork } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Overview() {
  let summary, dead, user;
  try {
    [summary, dead, user] = await Promise.all([
      controlTowerSummary(),
      deadWork(),
      currentUser(),
    ]);
  } catch (error) {
    return (
      <>
        <div className="page-head">
          <h1>Control Tower</h1>
        </div>
        <Offline error={error instanceof Error ? error.message : String(error)} />
      </>
    );
  }

  return (
    <ControlTowerDashboard
      operatorName={user?.name || user?.email || "Operator"}
      kpis={summary.kpis}
      quoteBookingTrend={summary.quoteBookingTrend}
      modeVolumeTrend={summary.modeVolumeTrend}
      todayQuoteBookingTrend={summary.todayQuoteBookingTrend}
      todayModeVolumeTrend={summary.todayModeVolumeTrend}
      shipments={summary.shipments}
      locations={summary.locations}
      deadCount={dead.length}
    />
  );
}
