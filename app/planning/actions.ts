"use server";

import { revalidatePath } from "next/cache";
import { requireDepartment } from "@/lib/auth";
import { handleFrontendLogisticsAction } from "@/lib/controllers/action-controller";

export async function submitPlanningIntakeAction(input: {
  reference?: string;
  originCity?: string;
  destinationCity?: string;
  preferredMode?: string;
  deadlineIso?: string;
  notes: string;
}): Promise<{
  ok: boolean;
  message: string;
  shipmentReference?: string | null;
  aiWarning?: string | null;
}> {
  await requireDepartment("FLEET", "EDIT_SHIPMENT");

  try {
    const out = await handleFrontendLogisticsAction({
      intent: "PLANNING_ROUTING",
      sourceChannel: "WEB_FORM_PLANNING",
      payload: {
        reference: input.reference,
        originCity: input.originCity,
        destinationCity: input.destinationCity,
        preferredMode: input.preferredMode,
        deadlineIso: input.deadlineIso,
        notes: input.notes,
      },
    });

    if (!out.ok) {
      return {
        ok: false,
        message: out.error ?? out.message,
      };
    }

    revalidatePath("/planning");
    revalidatePath("/shipments");
    revalidatePath("/fleet");
    revalidatePath("/queue");
    revalidatePath("/activity");

    return {
      ok: true,
      shipmentReference: out.shipmentReference ?? null,
      aiWarning: out.aiWarning ?? null,
      message: out.message,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Could not initiate planning request.",
    };
  }
}

export async function triggerFleetOptimization(): Promise<{
  ok: boolean;
  message: string;
  updatedCount?: number;
}> {
  await requireDepartment("FLEET", "EDIT_SHIPMENT");

  const out = await handleFrontendLogisticsAction({
    intent: "FLEET_OPTIMIZE",
    sourceChannel: "WEB_FORM_PLANNING",
    payload: {},
  });

  if (out.ok) {
    revalidatePath("/planning");
    revalidatePath("/shipments");
    revalidatePath("/fleet");
    revalidatePath("/queue");
    revalidatePath("/activity");
  }

  return {
    ok: out.ok,
    updatedCount: out.updatedCount,
    message: out.ok ? out.message : (out.error ?? out.message),
  };
}
