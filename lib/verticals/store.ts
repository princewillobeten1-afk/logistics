import { queryAs } from "@/lib/db";
import { assertVerifiedOrgId } from "@/lib/tenant-guard";
import {
  canTransitionCustomsStatus,
  validateInternationalFreightInput,
  validateThirdPartyClientInput,
  type BillingModel,
  type CustomsClearanceStatus,
  type FreightDirection,
  type FreightMode,
  type IncotermCode,
  type InternationalFreightInput,
  type InternationalFreightRecord,
  type ThirdPartyClientInput,
  type ThirdPartyClientRecord,
} from "./freight-and-3pl";

interface DbThirdPartyClientRow {
  id: string;
  org_id: string;
  client_code: string;
  client_name: string;
  contact_email: string | null;
  sla_hours: number | string;
  billing_model: string;
  dedicated_warehouses: string[] | null;
  sku_prefixes: string[] | null;
  monthly_storage_rate_usd: number | string;
  per_order_pick_fee_usd: number | string;
  active: boolean;
  notes: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DbInternationalFreightRow {
  id: string;
  org_id: string;
  shipment_reference: string;
  direction: string;
  transport_mode: string;
  incoterm: string;
  container_or_waybill: string;
  origin_country: string;
  destination_country: string;
  port_of_loading: string | null;
  port_of_discharge: string | null;
  hs_codes: string[] | null;
  declared_value_usd: number | string;
  estimated_duty_usd: number | string;
  customs_broker: string | null;
  clearance_status: string;
  commercial_invoice_ready: boolean;
  packing_list_ready: boolean;
  certificate_of_origin_ready: boolean;
  milestone_note: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapClientRow(row: DbThirdPartyClientRow): ThirdPartyClientRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    clientCode: row.client_code,
    clientName: row.client_name,
    contactEmail: row.contact_email ?? null,
    slaHours: Number(row.sla_hours ?? 48),
    billingModel: (row.billing_model as BillingModel) ?? "HYBRID_STORAGE_PICK",
    dedicatedWarehouses: Array.isArray(row.dedicated_warehouses)
      ? row.dedicated_warehouses
      : [],
    skuPrefixes: Array.isArray(row.sku_prefixes) ? row.sku_prefixes : [],
    monthlyStorageRateUsd: Number(row.monthly_storage_rate_usd ?? 0),
    perOrderPickFeeUsd: Number(row.per_order_pick_fee_usd ?? 0),
    active: row.active !== false,
    notes: row.notes ?? null,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at ?? new Date().toISOString()),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at ?? new Date().toISOString()),
  };
}

function mapFreightRow(row: DbInternationalFreightRow): InternationalFreightRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    shipmentReference: row.shipment_reference,
    direction: (row.direction as FreightDirection) ?? "EXPORT",
    transportMode: (row.transport_mode as FreightMode) ?? "SEA",
    incoterm: (row.incoterm as IncotermCode) ?? "FOB",
    containerOrWaybill: row.container_or_waybill,
    originCountry: row.origin_country,
    destinationCountry: row.destination_country,
    portOfLoading: row.port_of_loading ?? null,
    portOfDischarge: row.port_of_discharge ?? null,
    hsCodes: Array.isArray(row.hs_codes) ? row.hs_codes : [],
    declaredValueUsd: Number(row.declared_value_usd ?? 0),
    estimatedDutyUsd: Number(row.estimated_duty_usd ?? 0),
    customsBroker: row.customs_broker ?? null,
    clearanceStatus: (row.clearance_status as CustomsClearanceStatus) ?? "PENDING_DOCS",
    commercialInvoiceReady: Boolean(row.commercial_invoice_ready),
    packingListReady: Boolean(row.packing_list_ready),
    certificateOfOriginReady: Boolean(row.certificate_of_origin_ready),
    milestoneNote: row.milestone_note ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at ?? new Date().toISOString()),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at ?? new Date().toISOString()),
  };
}

export async function listThirdPartyClients(
  orgId: string,
): Promise<ThirdPartyClientRecord[]> {
  const verifiedOrgId = assertVerifiedOrgId(orgId, "listThirdPartyClients");
  try {
    const rows = await queryAs<DbThirdPartyClientRow>(
      verifiedOrgId,
      `SELECT id, org_id, client_code, client_name, contact_email, sla_hours,
              billing_model, dedicated_warehouses, sku_prefixes,
              monthly_storage_rate_usd, per_order_pick_fee_usd, active, notes,
              created_at, updated_at
         FROM third_party_clients
        ORDER BY active DESC, client_name ASC`,
      [],
    );
    return rows.map(mapClientRow);
  } catch {
    return [];
  }
}

export async function upsertThirdPartyClient(
  orgId: string,
  input: ThirdPartyClientInput,
): Promise<{ ok: true; client: ThirdPartyClientRecord } | { ok: false; error: string }> {
  const verifiedOrgId = assertVerifiedOrgId(orgId, "upsertThirdPartyClient");
  const validated = validateThirdPartyClientInput(input);
  if (!validated.ok) return validated;
  const v = validated.value;

  const rows = await queryAs<DbThirdPartyClientRow>(
    verifiedOrgId,
    `INSERT INTO third_party_clients (
       org_id, client_code, client_name, contact_email, sla_hours,
       billing_model, dedicated_warehouses, sku_prefixes,
       monthly_storage_rate_usd, per_order_pick_fee_usd, active, notes, updated_at
     )
     VALUES (
       app_current_org_id(), $1, $2, $3, $4,
       $5, $6, $7,
       $8, $9, $10, $11, now()
     )
     ON CONFLICT (org_id, client_code) DO UPDATE SET
       client_name = EXCLUDED.client_name,
       contact_email = EXCLUDED.contact_email,
       sla_hours = EXCLUDED.sla_hours,
       billing_model = EXCLUDED.billing_model,
       dedicated_warehouses = EXCLUDED.dedicated_warehouses,
       sku_prefixes = EXCLUDED.sku_prefixes,
       monthly_storage_rate_usd = EXCLUDED.monthly_storage_rate_usd,
       per_order_pick_fee_usd = EXCLUDED.per_order_pick_fee_usd,
       active = EXCLUDED.active,
       notes = EXCLUDED.notes,
       updated_at = now()
     RETURNING id, org_id, client_code, client_name, contact_email, sla_hours,
               billing_model, dedicated_warehouses, sku_prefixes,
               monthly_storage_rate_usd, per_order_pick_fee_usd, active, notes,
               created_at, updated_at`,
    [
      v.clientCode,
      v.clientName,
      v.contactEmail,
      v.slaHours,
      v.billingModel,
      v.dedicatedWarehouses,
      v.skuPrefixes,
      v.monthlyStorageRateUsd,
      v.perOrderPickFeeUsd,
      v.active,
      v.notes,
    ],
  );

  if (!rows[0]) {
    return { ok: false, error: "Could not save 3PL client account." };
  }
  return { ok: true, client: mapClientRow(rows[0]) };
}

export async function deactivateThirdPartyClient(
  orgId: string,
  clientCode: string,
): Promise<boolean> {
  const verifiedOrgId = assertVerifiedOrgId(orgId, "deactivateThirdPartyClient");
  const normalized = String(clientCode ?? "").trim().toUpperCase();
  if (!normalized) return false;
  const rows = await queryAs<{ id: string }>(
    verifiedOrgId,
    `UPDATE third_party_clients
        SET active = false, updated_at = now()
      WHERE upper(client_code) = $1
      RETURNING id`,
    [normalized],
  );
  return rows.length > 0;
}

export async function listInternationalFreightRecords(
  orgId: string,
): Promise<InternationalFreightRecord[]> {
  const verifiedOrgId = assertVerifiedOrgId(orgId, "listInternationalFreightRecords");
  try {
    const rows = await queryAs<DbInternationalFreightRow>(
      verifiedOrgId,
      `SELECT id, org_id, shipment_reference, direction, transport_mode, incoterm,
              container_or_waybill, origin_country, destination_country,
              port_of_loading, port_of_discharge, hs_codes, declared_value_usd,
              estimated_duty_usd, customs_broker, clearance_status,
              commercial_invoice_ready, packing_list_ready,
              certificate_of_origin_ready, milestone_note, updated_by,
              created_at, updated_at
         FROM international_freight_records
        ORDER BY updated_at DESC`,
      [],
    );
    return rows.map(mapFreightRow);
  } catch {
    return [];
  }
}

export async function upsertInternationalFreightRecord(
  orgId: string,
  input: InternationalFreightInput,
  actorEmail: string,
): Promise<
  | { ok: true; record: InternationalFreightRecord }
  | { ok: false; error: string }
> {
  const verifiedOrgId = assertVerifiedOrgId(orgId, "upsertInternationalFreightRecord");
  const validated = validateInternationalFreightInput(input);
  if (!validated.ok) return validated;
  const v = validated.value;

  const rows = await queryAs<DbInternationalFreightRow>(
    verifiedOrgId,
    `INSERT INTO international_freight_records (
       org_id, shipment_reference, direction, transport_mode, incoterm,
       container_or_waybill, origin_country, destination_country,
       port_of_loading, port_of_discharge, hs_codes, declared_value_usd,
       estimated_duty_usd, customs_broker, clearance_status,
       commercial_invoice_ready, packing_list_ready,
       certificate_of_origin_ready, milestone_note, updated_by, updated_at
     )
     VALUES (
       app_current_org_id(), $1, $2, $3, $4,
       $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13, $14,
       $15, $16,
       $17, $18, $19, now()
     )
     ON CONFLICT (org_id, shipment_reference) DO UPDATE SET
       direction = EXCLUDED.direction,
       transport_mode = EXCLUDED.transport_mode,
       incoterm = EXCLUDED.incoterm,
       container_or_waybill = EXCLUDED.container_or_waybill,
       origin_country = EXCLUDED.origin_country,
       destination_country = EXCLUDED.destination_country,
       port_of_loading = EXCLUDED.port_of_loading,
       port_of_discharge = EXCLUDED.port_of_discharge,
       hs_codes = EXCLUDED.hs_codes,
       declared_value_usd = EXCLUDED.declared_value_usd,
       estimated_duty_usd = EXCLUDED.estimated_duty_usd,
       customs_broker = EXCLUDED.customs_broker,
       clearance_status = EXCLUDED.clearance_status,
       commercial_invoice_ready = EXCLUDED.commercial_invoice_ready,
       packing_list_ready = EXCLUDED.packing_list_ready,
       certificate_of_origin_ready = EXCLUDED.certificate_of_origin_ready,
       milestone_note = EXCLUDED.milestone_note,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING id, org_id, shipment_reference, direction, transport_mode, incoterm,
               container_or_waybill, origin_country, destination_country,
               port_of_loading, port_of_discharge, hs_codes, declared_value_usd,
               estimated_duty_usd, customs_broker, clearance_status,
               commercial_invoice_ready, packing_list_ready,
               certificate_of_origin_ready, milestone_note, updated_by,
               created_at, updated_at`,
    [
      v.shipmentReference,
      v.direction,
      v.transportMode,
      v.incoterm,
      v.containerOrWaybill,
      v.originCountry,
      v.destinationCountry,
      v.portOfLoading,
      v.portOfDischarge,
      v.hsCodes,
      v.declaredValueUsd,
      v.estimatedDutyUsd,
      v.customsBroker,
      v.clearanceStatus,
      v.commercialInvoiceReady,
      v.packingListReady,
      v.certificateOfOriginReady,
      v.milestoneNote,
      actorEmail,
    ],
  );

  if (!rows[0]) {
    return { ok: false, error: "Could not save international freight record." };
  }
  return { ok: true, record: mapFreightRow(rows[0]) };
}

export async function transitionCustomsClearanceStatus(
  orgId: string,
  shipmentReference: string,
  nextStatus: CustomsClearanceStatus,
  milestoneNote: string | null,
  actorEmail: string,
): Promise<
  | { ok: true; record: InternationalFreightRecord }
  | { ok: false; error: string }
> {
  const verifiedOrgId = assertVerifiedOrgId(orgId, "transitionCustomsClearanceStatus");
  const ref = String(shipmentReference ?? "").trim().toUpperCase();
  const existing = (await listInternationalFreightRecords(verifiedOrgId)).find(
    (r) => r.shipmentReference.toUpperCase() === ref,
  );
  if (!existing) {
    return { ok: false, error: `International consignment "${ref}" was not found.` };
  }
  if (!canTransitionCustomsStatus(existing.clearanceStatus, nextStatus)) {
    return {
      ok: false,
      error: `Invalid customs transition from ${existing.clearanceStatus} to ${nextStatus}.`,
    };
  }

  const rows = await queryAs<DbInternationalFreightRow>(
    verifiedOrgId,
    `UPDATE international_freight_records
        SET clearance_status = $2,
            milestone_note = COALESCE($3, milestone_note),
            updated_by = $4,
            updated_at = now()
      WHERE upper(shipment_reference) = $1
      RETURNING id, org_id, shipment_reference, direction, transport_mode, incoterm,
                container_or_waybill, origin_country, destination_country,
                port_of_loading, port_of_discharge, hs_codes, declared_value_usd,
                estimated_duty_usd, customs_broker, clearance_status,
                commercial_invoice_ready, packing_list_ready,
                certificate_of_origin_ready, milestone_note, updated_by,
                created_at, updated_at`,
    [ref, nextStatus, milestoneNote ? milestoneNote.slice(0, 280) : null, actorEmail],
  );

  if (!rows[0]) {
    return { ok: false, error: "Could not update customs clearance status." };
  }
  return { ok: true, record: mapFreightRow(rows[0]) };
}
