import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { runWithOrgScope } from "@/lib/db";
import { buildMapDriverPins, buildMapNetworkData } from "@/lib/map-data";
import { listDrivers, listLocations, listShipments } from "@/lib/queries";
import {
  detectWorkspaceTampering,
  filterByBranchScope,
} from "@/lib/tenant-guard";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }
  const tamper = detectWorkspaceTampering(req, user.orgId);
  if (tamper) {
    return NextResponse.json({ error: tamper }, { status: 403 });
  }

  try {
    return await runWithOrgScope(user.orgId, async () => {
      const [locations, allShipments, drivers] = await Promise.all([
        listLocations(),
        listShipments(),
        listDrivers(),
      ]);
      const shipments = filterByBranchScope(allShipments, user, (s) => [
        typeof s.origin?.city === "string" ? s.origin.city : null,
        typeof s.destination?.city === "string" ? s.destination.city : null,
      ]);
      const data = buildMapNetworkData(locations, shipments);
      const driverPins = buildMapDriverPins(drivers, locations);
      return NextResponse.json(
        {
          ...data,
          drivers: driverPins,
          fetchedAt: new Date().toISOString(),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Could not refresh shipment and location data.",
      },
      { status: 500 },
    );
  }
}
