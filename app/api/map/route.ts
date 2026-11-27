import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { runWithOrgScope } from "@/lib/db";
import { buildMapDriverPins, buildMapNetworkData } from "@/lib/map-data";
import { listDrivers, listLocations, listShipments } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  try {
    return await runWithOrgScope(user.orgId, async () => {
      const [locations, shipments, drivers] = await Promise.all([
        listLocations(),
        listShipments(),
        listDrivers(),
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
