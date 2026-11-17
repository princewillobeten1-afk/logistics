"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { handleFrontendLogisticsAction } from "@/lib/controllers/action-controller";

export interface OrderIntakeActionResult {
  ok: boolean;
  message: string;
  orderReference?: string | null;
  shipmentReference?: string | null;
  aiWarning?: string | null;
}

export async function submitOrderIntakeAction(input: {
  customerName: string;
  originCity: string;
  destinationCity: string;
  cargoDescription: string;
  weightKg: number;
  quantity: number;
  deadlineIso?: string;
  preferredMode?: string;
  hazmat?: boolean;
  reefer?: boolean;
  notes?: string;
}): Promise<OrderIntakeActionResult> {
  await requireUser();

  try {
    const out = await handleFrontendLogisticsAction({
      intent: "NEW_ORDER",
      sourceChannel: "WEB_FORM_ORDER",
      payload: {
        customerName: input.customerName,
        originCity: input.originCity,
        destinationCity: input.destinationCity,
        cargoDescription: input.cargoDescription,
        weightKg: input.weightKg,
        quantity: input.quantity,
        deadlineIso: input.deadlineIso,
        preferredMode: input.preferredMode,
        hazmat: Boolean(input.hazmat),
        reefer: Boolean(input.reefer),
        notes: input.notes,
      },
    });

    if (!out.ok) {
      return {
        ok: false,
        message: out.error ?? out.message,
      };
    }

    revalidatePath("/");
    revalidatePath("/orders");
    revalidatePath("/shipments");
    revalidatePath("/planning");
    revalidatePath("/queue");
    revalidatePath("/activity");

    return {
      ok: true,
      orderReference: out.orderReference ?? null,
      shipmentReference: out.shipmentReference ?? null,
      aiWarning: out.aiWarning ?? null,
      message: out.message,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Could not submit order.",
    };
  }
}
