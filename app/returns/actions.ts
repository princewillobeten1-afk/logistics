"use server";

import { revalidatePath } from "next/cache";
import { may, requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { transaction } from "@/lib/db";

type ActionResult = { ok: boolean; message: string; rmaNumber?: string };

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  RETURN_REQUESTED: ["PICKUP_SCHEDULED", "IN_TRANSIT", "RECEIVED", "RECALLED", "REJECTED"],
  PICKUP_SCHEDULED: ["IN_TRANSIT", "RECEIVED", "REJECTED"],
  IN_TRANSIT: ["RECEIVED", "REJECTED"],
  RECEIVED: ["INSPECTED", "RECALLED"],
  INSPECTED: ["RESTOCKED", "REFURBISHED", "SCRAPPED"],
  RESTOCKED: ["CLOSED"],
  REFURBISHED: ["RESTOCKED", "CLOSED"],
  SCRAPPED: ["CLOSED"],
  RECALLED: ["SCRAPPED", "CLOSED"],
  CLOSED: [],
  REJECTED: [],
};

export async function createRmaAction(input: {
  shipmentReference?: string;
  warehouseCode?: string;
  sku: string;
  quantity: number;
  reason: string;
  conditionNotes?: string;
  lotNumber?: string;
  serialNumber?: string;
  refundNaira?: number;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!may(user.role, "EDIT_SHIPMENT")) {
    return { ok: false, message: "Your role cannot issue return authorizations." };
  }

  const sku = input.sku.trim().toUpperCase() || "DEFAULT";
  const quantity = Math.max(1, Math.round(Number(input.quantity) || 1));
  const allowedReasons = new Set([
    "DAMAGED",
    "DEFECTIVE",
    "WRONG_ITEM",
    "RECALL",
    "END_OF_LIFE",
    "WARRANTY",
    "CUSTOMER_REMORSE",
  ]);
  const reason = allowedReasons.has(input.reason.trim().toUpperCase())
    ? input.reason.trim().toUpperCase()
    : "DEFECTIVE";
  const refundMinor = Math.max(0, Math.round((Number(input.refundNaira) || 0) * 100));
  const rmaNumber = `RMA-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  try {
    await transaction(async (client) => {
      let shipmentId: string | null = null;
      let orderId: string | null = null;
      if (input.shipmentReference?.trim()) {
        const sRes = await client.query<{ id: string }>(
          `SELECT id FROM shipments WHERE upper(reference) = upper($1) LIMIT 1`,
          [input.shipmentReference.trim()],
        );
        shipmentId = sRes.rows[0]?.id ?? null;
      }

      let warehouseId: string | null = null;
      if (input.warehouseCode?.trim()) {
        const wRes = await client.query<{ id: string }>(
          `SELECT id FROM warehouses WHERE upper(code) = upper($1) LIMIT 1`,
          [input.warehouseCode.trim()],
        );
        warehouseId = wRes.rows[0]?.id ?? null;
      } else {
        const wFirst = await client.query<{ id: string }>(
          `SELECT id FROM warehouses WHERE active ORDER BY code LIMIT 1`,
        );
        warehouseId = wFirst.rows[0]?.id ?? null;
      }

      const initialState = reason === "RECALL" ? "RECALLED" : "RETURN_REQUESTED";
      await client.query(
        `INSERT INTO return_authorizations
           (rma_number, shipment_id, order_id, warehouse_id, sku, quantity, reason,
            condition_notes, state, refund_minor, currency, lot_number, serial_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'NGN', $11, $12)`,
        [
          rmaNumber,
          shipmentId,
          orderId,
          warehouseId,
          sku,
          quantity,
          reason,
          input.conditionNotes?.trim() || null,
          initialState,
          refundMinor,
          input.lotNumber?.trim() || null,
          input.serialNumber?.trim() || null,
        ],
      );
    });

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      orgId: user.orgId,
      action: "RMA_CREATED",
      entityType: "return_authorization",
      after: { rmaNumber, sku, quantity, reason },
    });

    revalidatePath("/returns");
    revalidatePath("/warehouses");
    revalidatePath("/");
    return { ok: true, rmaNumber, message: `Return authorization ${rmaNumber} created (${reason}).` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not create RMA." };
  }
}

export async function advanceRmaAction(input: {
  id: string;
  targetState: string;
  disposition?: "RESTOCK" | "REFURBISH" | "SCRAP" | "REPLACE" | "CREDIT";
  conditionNotes?: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!may(user.role, "EDIT_SHIPMENT")) {
    return { ok: false, message: "Your role cannot update return authorizations." };
  }

  const targetState = input.targetState.trim().toUpperCase();

  try {
    const out = await transaction(async (client) => {
      const res = await client.query<{
        id: string;
        rma_number: string;
        state: string;
        warehouse_id: string | null;
        sku: string;
        quantity: number;
      }>(
        `SELECT id, rma_number, state, warehouse_id, sku, quantity
           FROM return_authorizations
          WHERE id = $1`,
        [input.id],
      );
      const rma = res.rows[0];
      if (!rma) throw new Error("RMA not found.");

      const allowed = ALLOWED_TRANSITIONS[rma.state] ?? [];
      if (!allowed.includes(targetState)) {
        throw new Error(`Cannot transition RMA from ${rma.state} to ${targetState}.`);
      }

      if (targetState === "RESTOCKED" && rma.warehouse_id) {
        await client.query(
          `INSERT INTO inventory (warehouse_id, sku, on_hand, reserved)
           VALUES ($1, $2, $3, 0)
           ON CONFLICT (warehouse_id, sku) DO UPDATE
               SET on_hand = inventory.on_hand + EXCLUDED.on_hand`,
          [rma.warehouse_id, rma.sku, rma.quantity],
        );
      }

      await client.query(
        `UPDATE return_authorizations
            SET state = $1,
                disposition = COALESCE($2, disposition),
                condition_notes = COALESCE($3, condition_notes),
                inspected_by = CASE WHEN $1 IN ('INSPECTED', 'RESTOCKED', 'REFURBISHED', 'SCRAPPED') THEN $4 ELSE inspected_by END,
                inspected_at = CASE WHEN $1 IN ('INSPECTED', 'RESTOCKED', 'REFURBISHED', 'SCRAPPED') THEN COALESCE(inspected_at, now()) ELSE inspected_at END,
                resolved_at = CASE WHEN $1 IN ('CLOSED', 'REJECTED') THEN now() ELSE resolved_at END
          WHERE id = $5`,
        [
          targetState,
          input.disposition ?? null,
          input.conditionNotes?.trim() || null,
          user.email,
          rma.id,
        ],
      );

      return rma;
    });

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      orgId: user.orgId,
      action: `RMA_${targetState}`,
      entityType: "return_authorization",
      entityId: out.id,
      after: { rmaNumber: out.rma_number, targetState, disposition: input.disposition },
    });

    revalidatePath("/returns");
    revalidatePath("/warehouses");
    revalidatePath("/");
    return {
      ok: true,
      message:
        targetState === "RESTOCKED"
          ? `${out.rma_number} restocked (${out.quantity} × ${out.sku} added back to warehouse stock).`
          : `${out.rma_number} advanced to ${targetState}.`,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not advance RMA." };
  }
}
