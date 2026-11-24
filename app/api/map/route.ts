import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { buildMapNetworkData } from "@/lib/map-data";
import { listLocations, listShipments } from "@/lib/queries";

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
    const [locations, shipments] = await Promise.all([
      listLocations(),
      listShipments(),
    ]);
    const data = buildMapNetworkData(locations, shipments);
    return NextResponse.json(
      {
        ...data,
        fetchedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
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
