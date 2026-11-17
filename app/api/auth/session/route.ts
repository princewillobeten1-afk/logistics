import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { authenticated: false },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    {
      authenticated: true,
      user: {
        email: user.email,
        name: user.name,
        orgName: user.orgName,
        role: user.role,
      },
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
