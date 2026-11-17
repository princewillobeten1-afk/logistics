import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { AGENT_DOMAINS, CORE_AGENTS } from "@/lib/agents/catalog";
import { recentAgentRuns } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const recentRuns = await recentAgentRuns(25);
    return NextResponse.json({
      domains: AGENT_DOMAINS,
      agents: CORE_AGENTS,
      recentRuns,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load agent directory.",
      },
      { status: 500 },
    );
  }
}
