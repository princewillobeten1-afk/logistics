"use server";

import { revalidatePath } from "next/cache";
import { may, requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { query, transaction } from "@/lib/db";

type ActionResult = { ok: boolean; message: string };

const STARTER_WAREHOUSES: Array<{
  code: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  leadHours: number;
  stock: number;
}> = [
  { code: "Lagos", name: "Lagos Central DC", city: "Lagos", country: "NG", lat: 6.5244, lon: 3.3792, leadHours: 8, stock: 180 },
  { code: "Abuja", name: "Abuja Distribution", city: "Abuja", country: "NG", lat: 9.0765, lon: 7.3986, leadHours: 12, stock: 120 },
  { code: "PHC", name: "Port Harcourt Hub", city: "Port Harcourt", country: "NG", lat: 4.8156, lon: 7.0498, leadHours: 10, stock: 80 },
];

const STARTER_GATEWAYS: Array<{
  type: "PORT" | "AIRPORT";
  name: string;
  code: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
}> = [
  { type: "PORT", name: "Apapa Port", code: "NGAPP", city: "Lagos", country: "NG", lat: 6.4488, lon: 3.3596 },
  { type: "AIRPORT", name: "Murtala Muhammed Cargo", code: "LOS", city: "Lagos", country: "NG", lat: 6.5774, lon: 3.3212 },
  { type: "PORT", name: "Tema Port", code: "GHTEM", city: "Tema", country: "GH", lat: 5.6167, lon: 0.0167 },
  { type: "AIRPORT", name: "Heathrow Cargo", code: "LHR", city: "London", country: "GB", lat: 51.47, lon: -0.4543 },
];

const STARTER_CARRIERS: Array<{
  code: string;
  name: string;
  modes: string[];
  integration: "API" | "EMAIL" | "WHATSAPP" | "MANUAL";
  onTime: number;
  damage: number;
  avail: number;
  service: number;
}> = [
  { code: "CARRIER-A", name: "Sahel Haulage", modes: ["ROAD"], integration: "API", onTime: 0.91, damage: 0.02, avail: 0.85, service: 0.88 },
  { code: "CARRIER-C", name: "Premier Logistics", modes: ["ROAD"], integration: "API", onTime: 0.97, damage: 0.01, avail: 0.72, service: 0.94 },
  { code: "CARRIER-D", name: "Gulf Lines Ocean", modes: ["SEA"], integration: "API", onTime: 0.89, damage: 0.02, avail: 0.82, service: 0.85 },
  { code: "CARRIER-E", name: "TransWest Air Cargo", modes: ["AIR"], integration: "API", onTime: 0.94, damage: 0.01, avail: 0.76, service: 0.91 },
];

const STARTER_VEHICLES: Array<{
  carrierCode: string;
  mode: "ROAD" | "AIR" | "SEA" | "RAIL";
  kind: string;
  reg: string;
  capacityKg: number;
  reefer: boolean;
  hazmat: boolean;
}> = [
  { carrierCode: "CARRIER-A", mode: "ROAD", kind: "RIGID_TRUCK", reg: "LAG-114-XA", capacityKg: 12000, reefer: false, hazmat: false },
  { carrierCode: "CARRIER-A", mode: "ROAD", kind: "REEFER", reg: "LAG-318-XC", capacityKg: 18000, reefer: true, hazmat: true },
  { carrierCode: "CARRIER-C", mode: "ROAD", kind: "ARTICULATED", reg: "ABJ-402-YA", capacityKg: 30000, reefer: false, hazmat: false },
  { carrierCode: "CARRIER-E", mode: "AIR", kind: "FREIGHTER", reg: "5N-TWA", capacityKg: 40000, reefer: false, hazmat: false },
  { carrierCode: "CARRIER-D", mode: "SEA", kind: "CONTAINER_SHIP", reg: "IMO-9218471", capacityKg: 900000, reefer: true, hazmat: true },
];

const STARTER_DRIVERS = [
  { carrierCode: "CARRIER-A", name: "Emeka Nwosu", phone: "+234 810 111 0001", licence: "LAG-DL-88213", hazmat: true },
  { carrierCode: "CARRIER-C", name: "Hauwa Suleiman", phone: "+234 810 111 0004", licence: "ABJ-DL-33127", hazmat: true },
];

function revalidateNetworkPaths() {
  revalidatePath("/carriers");
  revalidatePath("/warehouses");
  revalidatePath("/fleet");
  revalidatePath("/customers");
  revalidatePath("/map");
  revalidatePath("/planning");
  revalidatePath("/");
}

export async function initializeStarterNetworkAction(): Promise<ActionResult> {
  const user = await requireUser();
  if (!may(user.role, "EDIT_SHIPMENT")) {
    return { ok: false, message: "Your role cannot modify logistics network master data." };
  }

  try {
    await transaction(async (client) => {
      for (const wh of STARTER_WAREHOUSES) {
        const loc = await client.query<{ id: string }>(
          `INSERT INTO locations (type, name, code, city, country, latitude, longitude)
           VALUES ('WAREHOUSE', $1, $2, $3, $4, $5, $6)
           ON CONFLICT (org_id, type, code) WHERE code IS NOT NULL
           DO UPDATE SET name = EXCLUDED.name, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude
           RETURNING id`,
          [wh.name, wh.code, wh.city, wh.country, wh.lat, wh.lon],
        );
        const wRes = await client.query<{ id: string }>(
          `INSERT INTO warehouses (code, name, location_id, dispatch_lead_hours, handles_hazmat, handles_reefer)
           VALUES ($1, $2, $3, $4, true, true)
           ON CONFLICT (org_id, code) DO UPDATE
               SET location_id = EXCLUDED.location_id, dispatch_lead_hours = EXCLUDED.dispatch_lead_hours
           RETURNING id`,
          [wh.code, wh.name, loc.rows[0]?.id ?? null, wh.leadHours],
        );
        if (wRes.rows[0]?.id) {
          await client.query(
            `INSERT INTO inventory (warehouse_id, sku, on_hand, reserved)
             VALUES ($1, 'DEFAULT', $2, 0)
             ON CONFLICT (warehouse_id, sku) DO UPDATE
                 SET on_hand = GREATEST(inventory.on_hand, EXCLUDED.on_hand)`,
            [wRes.rows[0].id, wh.stock],
          );
        }
      }

      for (const gw of STARTER_GATEWAYS) {
        await client.query(
          `INSERT INTO locations (type, name, code, city, country, latitude, longitude)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (org_id, type, code) WHERE code IS NOT NULL
           DO UPDATE SET name = EXCLUDED.name`,
          [gw.type, gw.name, gw.code, gw.city, gw.country, gw.lat, gw.lon],
        );
      }

      const carrierIds = new Map<string, string>();
      for (const c of STARTER_CARRIERS) {
        const cRes = await client.query<{ id: string }>(
          `INSERT INTO carriers (code, name, modes, integration, approved, active)
           VALUES ($1, $2, $3, $4, true, true)
           ON CONFLICT (org_id, code) DO UPDATE
               SET name = EXCLUDED.name, modes = EXCLUDED.modes, approved = true, active = true
           RETURNING id`,
          [c.code, c.name, c.modes, c.integration],
        );
        const cid = cRes.rows[0]?.id;
        if (cid) {
          carrierIds.set(c.code, cid);
          await client.query(
            `INSERT INTO carrier_performance
               (carrier_id, shipments_count, on_time_rate, damage_rate, availability_rate, service_score)
             VALUES ($1, 200, $2, $3, $4, $5)
             ON CONFLICT (carrier_id, COALESCE(origin_region, ''), COALESCE(destination_region, ''), COALESCE(mode, ''))
             DO UPDATE SET on_time_rate = EXCLUDED.on_time_rate, service_score = EXCLUDED.service_score`,
            [cid, c.onTime, c.damage, c.avail, c.service],
          );
        }
      }

      for (const v of STARTER_VEHICLES) {
        const cid = carrierIds.get(v.carrierCode) ?? null;
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM conveyances WHERE identifiers->>'registration' = $1 LIMIT 1`,
          [v.reg],
        );
        if (existing.rows.length === 0) {
          await client.query(
            `INSERT INTO conveyances (carrier_id, mode, kind, identifiers, capacity_kg, reefer, hazmat_certified, active)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, true)`,
            [cid, v.mode, v.kind, JSON.stringify({ registration: v.reg }), v.capacityKg, v.reefer, v.hazmat],
          );
        }
      }

      for (const d of STARTER_DRIVERS) {
        const cid = carrierIds.get(d.carrierCode) ?? null;
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM drivers WHERE licence_number = $1 LIMIT 1`,
          [d.licence],
        );
        if (existing.rows.length === 0) {
          await client.query(
            `INSERT INTO drivers (carrier_id, name, phone, licence_number, licence_expiry, hazmat_certified, active)
             VALUES ($1, $2, $3, $4, (current_date + interval '365 days')::date, $5, true)`,
            [cid, d.name, d.phone, d.licence, d.hazmat],
          );
        }
      }
    });

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      orgId: user.orgId,
      action: "NETWORK_STARTER_INITIALIZED",
      entityType: "organisation",
      entityId: user.orgId,
    });
    revalidateNetworkPaths();
    return {
      ok: true,
      message: "Starter network initialized: 3 warehouses with stock, 4 gateways, 4 approved multimodal carriers, 5 vehicles, and 2 drivers.",
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not initialize starter network.",
    };
  }
}

export async function createCarrierAction(input: {
  code: string;
  name: string;
  modes: string[];
  integration: string;
  approved: boolean;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!may(user.role, "EDIT_SHIPMENT")) {
    return { ok: false, message: "Your role cannot add carriers." };
  }

  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  const modes = input.modes.length > 0 ? input.modes : ["ROAD"];
  const integration = ["API", "WHATSAPP", "EMAIL", "MANUAL"].includes(input.integration)
    ? input.integration
    : "API";
  if (!code || !name) {
    return { ok: false, message: "Carrier code and name are required." };
  }

  try {
    const rows = await query<{ id: string }>(
      `INSERT INTO carriers (code, name, modes, integration, approved, active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (org_id, code) DO UPDATE
           SET name = EXCLUDED.name, modes = EXCLUDED.modes,
               integration = EXCLUDED.integration, approved = EXCLUDED.approved
       RETURNING id`,
      [code, name, modes, integration, input.approved],
    );
    if (rows[0]?.id) {
      await query(
        `INSERT INTO carrier_performance
           (carrier_id, shipments_count, on_time_rate, damage_rate, availability_rate, service_score)
         VALUES ($1, 50, 0.92, 0.02, 0.85, 0.88)
         ON CONFLICT (carrier_id, COALESCE(origin_region, ''), COALESCE(destination_region, ''), COALESCE(mode, ''))
         DO NOTHING`,
        [rows[0].id],
      );
    }
    await recordAudit({
      actor: user.email,
      actorType: "USER",
      orgId: user.orgId,
      action: "CARRIER_CREATED",
      entityType: "carrier",
      after: { code, name, modes, integration, approved: input.approved },
    });
    revalidateNetworkPaths();
    return { ok: true, message: `Carrier ${code} (${name}) saved.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not save carrier." };
  }
}

export async function createWarehouseAction(input: {
  code: string;
  name: string;
  city: string;
  country: string;
  leadHours: number;
  initialStock: number;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!may(user.role, "EDIT_SHIPMENT")) {
    return { ok: false, message: "Your role cannot add warehouses." };
  }

  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  const city = input.city.trim();
  const country = (input.country.trim().toUpperCase() || "NG").slice(0, 2);
  const lead = Number.isFinite(input.leadHours) && input.leadHours > 0 ? input.leadHours : 8;
  const stock = Number.isFinite(input.initialStock) && input.initialStock >= 0 ? Math.round(input.initialStock) : 100;

  if (!code || !name || !city) {
    return { ok: false, message: "Warehouse code, name, and city are required." };
  }

  try {
    await transaction(async (client) => {
      const loc = await client.query<{ id: string }>(
        `INSERT INTO locations (type, name, code, city, country)
         VALUES ('WAREHOUSE', $1, $2, $3, $4)
         ON CONFLICT (org_id, type, code) WHERE code IS NOT NULL
         DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city, country = EXCLUDED.country
         RETURNING id`,
        [name, code, city, country],
      );
      const wRes = await client.query<{ id: string }>(
        `INSERT INTO warehouses (code, name, location_id, dispatch_lead_hours, handles_hazmat, handles_reefer)
         VALUES ($1, $2, $3, $4, true, true)
         ON CONFLICT (org_id, code) DO UPDATE
             SET name = EXCLUDED.name, location_id = EXCLUDED.location_id, dispatch_lead_hours = EXCLUDED.dispatch_lead_hours
         RETURNING id`,
        [code, name, loc.rows[0]?.id ?? null, lead],
      );
      if (wRes.rows[0]?.id) {
        await client.query(
          `INSERT INTO inventory (warehouse_id, sku, on_hand, reserved)
           VALUES ($1, 'DEFAULT', $2, 0)
           ON CONFLICT (warehouse_id, sku) DO UPDATE SET on_hand = EXCLUDED.on_hand`,
          [wRes.rows[0].id, stock],
        );
      }
    });
    revalidateNetworkPaths();
    return { ok: true, message: `Warehouse ${code} (${city}) added with ${stock} units.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not add warehouse." };
  }
}

export async function createVehicleAction(input: {
  registration: string;
  mode: string;
  kind: string;
  capacityKg: number;
  reefer: boolean;
  hazmat: boolean;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!may(user.role, "EDIT_SHIPMENT")) {
    return { ok: false, message: "Your role cannot add vehicles." };
  }

  const reg = input.registration.trim().toUpperCase();
  const mode = ["ROAD", "AIR", "SEA", "RAIL"].includes(input.mode) ? input.mode : "ROAD";
  const kind = input.kind.trim() || "RIGID_TRUCK";
  const cap = Number.isFinite(input.capacityKg) && input.capacityKg > 0 ? input.capacityKg : 12000;
  if (!reg) return { ok: false, message: "Registration / asset identifier is required." };

  try {
    await query(
      `INSERT INTO conveyances (mode, kind, identifiers, capacity_kg, reefer, hazmat_certified, active)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, true)`,
      [mode, kind, JSON.stringify({ registration: reg }), cap, input.reefer, input.hazmat],
    );
    revalidateNetworkPaths();
    return { ok: true, message: `Vehicle ${reg} (${mode}) added.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not add vehicle." };
  }
}

export async function createDriverAction(input: {
  name: string;
  phone: string;
  licence: string;
  hazmat: boolean;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!may(user.role, "EDIT_SHIPMENT")) {
    return { ok: false, message: "Your role cannot add drivers." };
  }

  const name = input.name.trim();
  const phone = input.phone.trim() || null;
  const licence = input.licence.trim().toUpperCase() || null;
  if (!name) return { ok: false, message: "Driver name is required." };

  try {
    await query(
      `INSERT INTO drivers (name, phone, licence_number, licence_expiry, hazmat_certified, active)
       VALUES ($1, $2, $3, (current_date + interval '365 days')::date, $4, true)`,
      [name, phone, licence, input.hazmat],
    );
    revalidateNetworkPaths();
    return { ok: true, message: `Driver ${name} added.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not add driver." };
  }
}

export async function createCustomerAction(input: {
  code: string;
  name: string;
  slaHours: number;
  paymentTerms: string;
  contactEmail: string;
  contactPhone: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!may(user.role, "EDIT_SHIPMENT")) {
    return { ok: false, message: "Your role cannot add customers." };
  }

  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  const sla = Number.isFinite(input.slaHours) && input.slaHours > 0 ? Math.round(input.slaHours) : 48;
  if (!code || !name) return { ok: false, message: "Customer code and name are required." };

  try {
    await query(
      `INSERT INTO customers (code, name, sla_hours, payment_terms, default_currency, contacts)
       VALUES ($1, $2, $3, $4, 'NGN', $5::jsonb)
       ON CONFLICT (org_id, code) DO UPDATE
           SET name = EXCLUDED.name, sla_hours = EXCLUDED.sla_hours,
               payment_terms = EXCLUDED.payment_terms, contacts = EXCLUDED.contacts`,
      [
        code,
        name,
        sla,
        input.paymentTerms.trim() || "Net 30",
        JSON.stringify([
          {
            name,
            email: input.contactEmail.trim() || undefined,
            phone: input.contactPhone.trim() || undefined,
            role: "primary",
          },
        ]),
      ],
    );
    revalidateNetworkPaths();
    return { ok: true, message: `Customer ${code} (${name}) saved.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not add customer." };
  }
}

export async function updateInventoryPolicyAction(input: {
  warehouseCode: string;
  sku: string;
  safetyStock: number;
  reorderPoint: number;
  reorderQuantity: number;
  unitCostNaira: number;
  annualHoldingRatePct: number;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!may(user.role, "EDIT_SHIPMENT")) {
    return { ok: false, message: "Your role cannot modify inventory policies." };
  }

  const whCode = input.warehouseCode.trim();
  const sku = input.sku.trim().toUpperCase() || "DEFAULT";
  const safety = Math.max(0, Math.round(Number(input.safetyStock) || 0));
  const rop = Math.max(0, Math.round(Number(input.reorderPoint) || 0));
  const reorderQty = Math.max(1, Math.round(Number(input.reorderQuantity) || 100));
  const unitCostMinor = Math.max(0, Math.round((Number(input.unitCostNaira) || 0) * 100));
  const holdingRate = Math.max(0, Math.min(2, (Number(input.annualHoldingRatePct) || 20) / 100));

  try {
    const updated = await query<{ id: string }>(
      `UPDATE inventory i
          SET safety_stock = $1,
              reorder_point = $2,
              reorder_quantity = $3,
              unit_cost_minor = $4,
              annual_holding_rate = $5
         FROM warehouses w
        WHERE w.id = i.warehouse_id
          AND w.code = $6
          AND i.sku = $7
       RETURNING i.id`,
      [safety, rop, reorderQty, unitCostMinor, holdingRate, whCode, sku],
    );
    if (updated.length === 0) {
      return { ok: false, message: `Stock line ${whCode} / ${sku} was not found.` };
    }
    await recordAudit({
      actor: user.email,
      actorType: "USER",
      orgId: user.orgId,
      action: "INVENTORY_POLICY_UPDATED",
      entityType: "inventory",
      after: { warehouseCode: whCode, sku, safety, rop, reorderQty, unitCostMinor, holdingRate },
    });
    revalidateNetworkPaths();
    return { ok: true, message: `Updated replenishment & cost thresholds for ${whCode} / ${sku}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not update policy." };
  }
}

export async function runReplenishmentSweepAction(): Promise<ActionResult> {
  const user = await requireUser();
  if (!may(user.role, "EDIT_SHIPMENT")) {
    return { ok: false, message: "Your role cannot run inventory replenishment." };
  }

  try {
    const created = await transaction(async (client) => {
      const low = await client.query<{
        warehouse_id: string;
        warehouse_code: string;
        sku: string;
        available: number;
        safety_stock: number;
        reorder_point: number;
        reorder_quantity: number;
        unit_cost_minor: string;
        currency: string;
      }>(
        `SELECT i.warehouse_id, w.code AS warehouse_code, i.sku,
                (i.on_hand - i.reserved) AS available,
                i.safety_stock, i.reorder_point, i.reorder_quantity,
                i.unit_cost_minor::text, i.currency
           FROM inventory i
           JOIN warehouses w ON w.id = i.warehouse_id
          WHERE w.active
            AND (i.on_hand - i.reserved) <= i.reorder_point
            AND NOT EXISTS (
              SELECT 1 FROM replenishment_orders r
               WHERE r.warehouse_id = i.warehouse_id
                 AND r.sku = i.sku
                 AND r.status IN ('PROPOSED', 'APPROVED', 'ORDERED')
            )`,
      );

      let count = 0;
      for (const row of low.rows) {
        const avail = Number(row.available ?? 0);
        const rop = Number(row.reorder_point ?? 0);
        const safety = Number(row.safety_stock ?? 0);
        const rQty = Math.max(1, Number(row.reorder_quantity ?? 100));
        const qty = Math.max(rQty, rop + safety + rQty - Math.max(0, avail));
        const estCost = qty * Number(row.unit_cost_minor ?? 0);
        const ref = `RPL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const level = avail <= safety ? "CRITICAL" : "REORDER";
        const reason = `${level}: available ${avail} <= threshold ${level === "CRITICAL" ? safety : rop} at ${row.warehouse_code}`;
        await client.query(
          `INSERT INTO replenishment_orders
             (reference, warehouse_id, sku, quantity, estimated_cost_minor, currency, reason, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'PROPOSED')
           ON CONFLICT (org_id, warehouse_id, sku)
               WHERE status IN ('PROPOSED', 'APPROVED', 'ORDERED') DO NOTHING`,
          [ref, row.warehouse_id, row.sku, qty, estCost, row.currency || "NGN", reason],
        );
        count += 1;
      }
      return count;
    });

    revalidatePath("/warehouses");
    revalidatePath("/");
    return {
      ok: true,
      message:
        created > 0
          ? `Created ${created} replenishment PO proposal(s) for stock at or below reorder point.`
          : "All active warehouse SKUs are currently above reorder point (or already have an open replenishment order).",
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not run replenishment sweep." };
  }
}

export async function advanceReplenishmentAction(input: {
  id: string;
  targetStatus: "APPROVED" | "ORDERED" | "RECEIVED" | "CANCELLED";
  supplierName?: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  if (!may(user.role, "EDIT_SHIPMENT")) {
    return { ok: false, message: "Your role cannot update replenishment orders." };
  }

  try {
    await transaction(async (client) => {
      const res = await client.query<{
        id: string;
        warehouse_id: string;
        sku: string;
        quantity: number;
        status: string;
      }>(
        `SELECT id, warehouse_id, sku, quantity, status
           FROM replenishment_orders
          WHERE id = $1`,
        [input.id],
      );
      const row = res.rows[0];
      if (!row) {
        throw new Error("Replenishment order not found.");
      }
      if (row.status === "RECEIVED" || row.status === "CANCELLED") {
        throw new Error(`Order is already ${row.status}.`);
      }

      if (input.targetStatus === "RECEIVED") {
        await client.query(
          `UPDATE inventory
              SET on_hand = on_hand + $1
            WHERE warehouse_id = $2 AND sku = $3`,
          [row.quantity, row.warehouse_id, row.sku],
        );
      }

      await client.query(
        `UPDATE replenishment_orders
            SET status = $1,
                supplier_name = COALESCE($2, supplier_name),
                received_at = CASE WHEN $1 = 'RECEIVED' THEN now() ELSE received_at END
          WHERE id = $3`,
        [input.targetStatus, input.supplierName?.trim() || null, row.id],
      );
    });

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      orgId: user.orgId,
      action: `REPLENISHMENT_${input.targetStatus}`,
      entityType: "replenishment_order",
      entityId: input.id,
    });
    revalidatePath("/warehouses");
    revalidatePath("/");
    return {
      ok: true,
      message:
        input.targetStatus === "RECEIVED"
          ? "Replenishment received and added to warehouse on-hand stock."
          : `Replenishment order marked ${input.targetStatus}.`,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not advance replenishment order." };
  }
}

export async function runConsolidationAction(): Promise<ActionResult> {
  const user = await requireUser();
  if (!may(user.role, "EDIT_SHIPMENT")) {
    return { ok: false, message: "Your role cannot run freight consolidation." };
  }

  try {
    const { poolConsolidatableShipments } = await import("@/lib/planning");
    const result = await transaction(async (client) => {
      const open = await client.query<{
        id: string;
        reference: string;
        origin: Record<string, unknown>;
        destination: Record<string, unknown>;
        cargo: Record<string, unknown>;
        plan: Record<string, unknown> | null;
      }>(
        `SELECT id, reference, origin, destination, cargo, plan
           FROM shipments
          WHERE state IN ('ALLOCATED', 'PLANNED')
            AND consolidation_group_id IS NULL
          ORDER BY created_at ASC
          LIMIT 100`,
      );

      const candidates = open.rows.map((r) => {
        const plan = r.plan ?? {};
        const cargo = r.cargo ?? {};
        const weightKg = Number(cargo.weight_kg ?? 0) || 250;
        const modes = Array.isArray(plan.modes) ? plan.modes : ["ROAD"];
        const mode = String(modes[0] ?? "ROAD").toUpperCase();
        const loadType = String(
          plan.load_type ??
            (mode === "SEA" && weightKg < 10_000 ? "LCL" : weightKg < 4_000 ? "LTL" : "FTL"),
        ).toUpperCase();
        return {
          shipmentId: r.id,
          reference: r.reference,
          originCity: String(r.origin?.city ?? r.origin?.warehouse ?? ""),
          destinationCity: String(r.destination?.city ?? r.destination?.address ?? ""),
          mode,
          loadType,
          weightKg,
          estimatedCostMinor: Number(plan.estimated_cost_minor ?? 0) || 0,
          currency: String(plan.currency ?? "NGN"),
        };
      });

      const pools = poolConsolidatableShipments(candidates);
      let groupsCreated = 0;
      let shipmentsPooled = 0;

      for (const pool of pools) {
        const ref = `POOL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        const gRes = await client.query<{ id: string }>(
          `INSERT INTO consolidation_groups
             (reference, origin_city, destination_city, mode, load_type, status,
              vehicle_capacity_kg, total_weight_kg, total_volume_cbm,
              utilization_pct, estimated_savings_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 'OPEN', 15000, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            ref,
            pool.originCity,
            pool.destinationCity,
            pool.mode,
            pool.loadType,
            pool.totalWeightKg,
            pool.totalVolumeCbm,
            pool.utilizationPct,
            pool.estimatedSavingsMinor,
            pool.currency,
          ],
        );
        const groupId = gRes.rows[0]?.id;
        if (!groupId) continue;
        groupsCreated += 1;

        for (const item of pool.items) {
          const vol = Math.max(0.05, Math.round((item.weightKg / 333) * 10000) / 10000);
          await client.query(
            `INSERT INTO consolidation_items (group_id, shipment_id, weight_kg, volume_cbm)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (org_id, shipment_id) DO NOTHING`,
            [groupId, item.shipmentId, item.weightKg, vol],
          );
          const srcRow = open.rows.find((x) => x.id === item.shipmentId);
          const mergedPlan = {
            ...(srcRow?.plan ?? {}),
            consolidation_group_ref: ref,
            consolidation_load_type: pool.loadType,
            consolidation_utilization_pct: pool.utilizationPct,
            consolidation_count: pool.items.length,
          };
          await client.query(
            `UPDATE shipments
                SET consolidation_group_id = $1,
                    plan = $2::jsonb
              WHERE id = $3`,
            [groupId, JSON.stringify(mergedPlan), item.shipmentId],
          );
          shipmentsPooled += 1;
        }
      }

      return { groupsCreated, shipmentsPooled };
    });

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      orgId: user.orgId,
      action: "FREIGHT_CONSOLIDATION_RUN",
      entityType: "consolidation_group",
      after: result,
    });
    revalidatePath("/planning");
    revalidatePath("/shipments");
    return {
      ok: true,
      message:
        result.groupsCreated > 0
          ? `Consolidated ${result.shipmentsPooled} LTL/LCL shipments into ${result.groupsCreated} pool(s).`
          : "No ungrouped LTL/LCL pairs found sharing the same lane and mode in ALLOCATED/PLANNED state.",
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not consolidate shipments." };
  }
}
