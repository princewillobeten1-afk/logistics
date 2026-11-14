"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { query } from "@/lib/db";

export async function triggerFleetOptimization(): Promise<{
  ok: boolean;
  message: string;
}> {
  await requireUser();

  try {
    await query(
      `INSERT INTO work_items (kind, payload, priority, dedupe_key)
       VALUES ('planning.optimize_fleet', '{"source": "planning_ui"}'::jsonb, 10, $1)
       ON CONFLICT (org_id, dedupe_key) DO NOTHING`,
      [`cuopt-fleet:${Math.floor(Date.now() / 10000)}`],
    );
    revalidatePath("/planning");
    revalidatePath("/queue");
    return {
      ok: true,
      message:
        "Queued NVIDIA cuOpt fleet route optimization job (`planning.optimize_fleet`).",
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Could not queue optimization.",
    };
  }
}

