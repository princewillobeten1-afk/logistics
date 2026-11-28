import { dispatchToAutonomousAgent } from "@/lib/agents/autonomous";
import { recordAudit } from "@/lib/audit";
import { query, runWithOrgScope } from "@/lib/db";
import type { IntegrationConnectorRecord } from "@/lib/local-store";
import {
  detectAndParseRawPayload,
  normalizeExternalRecord,
  type DetectedPayloadFormat,
  type NormalizedLogisticsEvent,
} from "./mapper";
import {
  signWebhookPayload,
  unsealWebhookSecret,
  validateOutboundWebhookUrlForDispatch,
} from "./security";
import {
  bumpConnectorStats,
  findDuplicateEvent,
  recordIntegrationEvent,
  type PublicIntegrationEvent,
} from "./store";
import { runAutonomousTakeoverForShipment } from "./takeover";

export interface IngestRecordOutcome {
  index: number;
  status: "PROCESSED" | "DUPLICATE" | "FAILED";
  entityType: string;
  mappedBy: string;
  externalRef: string | null;
  orderReference: string | null;
  shipmentReference: string | null;
  delegatedAgents: string[];
  summary: string;
  orchestrationSummary: string | null;
  outboundWebhookStatus: string | null;
  normalized: NormalizedLogisticsEvent;
  error: string | null;
}

export interface UniversalIngestResult {
  ok: boolean;
  connectorId: string;
  connectorName: string;
  autonomyMode: string;
  format: DetectedPayloadFormat;
  totalReceived: number;
  processed: number;
  duplicates: number;
  failed: number;
  entityCounts: Record<string, number>;
  takeoverSummary: {
    booked: number;
    awaitingApproval: number;
  };
  outcomes: IngestRecordOutcome[];
  events: PublicIntegrationEvent[];
  parseError?: string;
}

function makeCode(prefix: string, raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
  return cleaned || `${prefix}-${Math.floor(100 + Math.random() * 899)}`;
}

async function dispatchOutboundCallback(
  connector: IntegrationConnectorRecord,
  eventName: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (!connector.outbound_webhook_url) return null;

  const urlCheck = await validateOutboundWebhookUrlForDispatch(
    connector.outbound_webhook_url,
  );
  if (!urlCheck.ok || !urlCheck.normalizedUrl) {
    return `BLOCKED (${urlCheck.error ?? "unsafe URL"})`;
  }

  const envelope = {
    event: eventName,
    connectorId: connector.id,
    connectorName: connector.name,
    timestamp: new Date().toISOString(),
    data: payload,
  };
  const body = JSON.stringify(envelope);
  const signingSecret = unsealWebhookSecret(connector.webhook_secret_hash);
  const signature = signWebhookPayload(body, signingSecret);

  try {
    const res = await fetch(urlCheck.normalizedUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ControlTower-Webhook/1.0",
        "X-ControlTower-Event": eventName,
        "X-ControlTower-Connector": connector.id,
        "X-ControlTower-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(6_000),
    });
    return res.ok ? `DELIVERED (${res.status})` : `HTTP_${res.status}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    return `FAILED (${msg.slice(0, 60)})`;
  }
}

export async function processUniversalIngestion({
  connector,
  rawPayload,
  contentType,
  idempotencyKey,
  actorEmail,
  syncOrchestrate = true,
  maxRecords = 250,
}: {
  connector: IntegrationConnectorRecord;
  rawPayload: string | Record<string, unknown> | Record<string, unknown>[];
  contentType?: string | null;
  idempotencyKey?: string | null;
  actorEmail?: string | null;
  syncOrchestrate?: boolean;
  maxRecords?: number;
}): Promise<UniversalIngestResult> {
  const parsed = detectAndParseRawPayload(rawPayload, contentType);
  if (parsed.parseError) {
    return {
      ok: false,
      connectorId: connector.id,
      connectorName: connector.name,
      autonomyMode: connector.autonomy_mode,
      format: parsed.format,
      totalReceived: 0,
      processed: 0,
      duplicates: 0,
      failed: 1,
      entityCounts: {},
      takeoverSummary: { booked: 0, awaitingApproval: 0 },
      outcomes: [],
      events: [],
      parseError: parsed.parseError,
    };
  }
  const records = parsed.records.slice(0, maxRecords);

  const outcomes: IngestRecordOutcome[] = [];
  const events: PublicIntegrationEvent[] = [];
  const entityCounts: Record<string, number> = {};
  let processed = 0;
  let duplicates = 0;
  let failed = 0;
  let takeoverBooked = 0;
  let takeoverApprovals = 0;

  for (let idx = 0; idx < records.length; idx += 1) {
    const startedAt = Date.now();
    const record = records[idx];
    const rawPreview = JSON.stringify(record).slice(0, 600);
    const effectiveIdemKey = idempotencyKey
      ? records.length > 1
        ? `${idempotencyKey}:${idx}`
        : idempotencyKey
      : null;

    if (effectiveIdemKey) {
      const dup = await findDuplicateEvent(
        connector.org_id,
        connector.id,
        effectiveIdemKey,
      );
      if (dup) {
        duplicates += 1;
        outcomes.push({
          index: idx,
          status: "DUPLICATE",
          entityType: dup.entityType,
          mappedBy: dup.mappedBy,
          externalRef: dup.externalRef,
          orderReference: dup.orderRef,
          shipmentReference: dup.shipmentRef,
          delegatedAgents: dup.delegatedAgents,
          summary: `Duplicate idempotency key skipped (${dup.shipmentRef ?? dup.orderRef ?? dup.id})`,
          orchestrationSummary: null,
          outboundWebhookStatus: dup.outboundStatus,
          normalized: dup.normalizedPayload as unknown as NormalizedLogisticsEvent,
          error: null,
        });
        continue;
      }
    }

    try {
      const normalized = await normalizeExternalRecord(record, {
        fieldMapping: connector.field_mapping ?? {},
        systemName: connector.name,
      });

      let orderReference: string | null = null;
      let shipmentReference: string | null = normalized.shipmentRef;
      let delegatedAgents: string[] = [];
      let orchestrationSummary: string | null = null;
      let outboundEventName = "integration.synced";

      const isSyncOnly = connector.autonomy_mode === "SYNC_ONLY";
      const runAiSync = syncOrchestrate && records.length <= 2;
      const runMode = runAiSync ? "sync_orchestrate" : "background_orchestrate";
      const autoTakeoverEnabled = connector.auto_takeover !== false && !isSyncOnly;

      await runWithOrgScope(connector.org_id, async () => {
        if (normalized.entityType === "WAREHOUSE") {
          outboundEventName = "warehouse.synced";
          const code = makeCode(
            "WH",
            normalized.warehouseCode ?? normalized.warehouseName ?? normalized.originCity ?? "HUB",
          );
          const name = normalized.warehouseName ?? normalized.originCity ?? code;
          const city = normalized.originCity ?? name;
          const country = (normalized.warehouseCountry ?? "US").slice(0, 3).toUpperCase();

          await query(
            `INSERT INTO locations (type, name, code, city, country, latitude, longitude)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [
              "WAREHOUSE",
              name,
              code,
              city,
              country,
              normalized.latitude ?? null,
              normalized.longitude ?? null,
            ],
          );
          await query(
            `INSERT INTO warehouses (code, name, dispatch_lead_hours, handles_hazmat, handles_reefer, city, country, latitude, longitude)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [
              code,
              name,
              normalized.warehouseLeadHours ?? 4,
              Boolean(normalized.hazmat),
              Boolean(normalized.reefer),
              city,
              country,
              normalized.latitude ?? null,
              normalized.longitude ?? null,
            ],
          );
          orchestrationSummary = `Synced warehouse ${code} (${name}, ${city}) to Warehouses & Network Map.`;
        } else if (normalized.entityType === "CARRIER") {
          outboundEventName = "carrier.synced";
          const name = normalized.carrierName ?? normalized.externalRef ?? "Carrier Partner";
          const code = makeCode("CAR", normalized.carrierCode ?? name);
          const modes =
            normalized.carrierModes && normalized.carrierModes.length > 0
              ? normalized.carrierModes
              : [normalized.preferredMode ?? "ROAD"];
          const otp =
            normalized.carrierOnTimeRate != null
              ? normalized.carrierOnTimeRate > 1
                ? normalized.carrierOnTimeRate / 100
                : normalized.carrierOnTimeRate
              : 0.94;
          await query(
            `INSERT INTO carriers (code, name, modes, integration, approved, on_time_rate, service_score)
             VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
             RETURNING id`,
            [
              code,
              name,
              JSON.stringify(modes),
              "API",
              true,
              otp.toFixed(3),
              Math.min(0.99, otp + 0.01).toFixed(3),
            ],
          );
          orchestrationSummary = `Onboarded approved carrier ${name} (${modes.join(", ")}) for autonomous quote scoring.`;
        } else if (normalized.entityType === "CUSTOMER") {
          outboundEventName = "customer.synced";
          const name = normalized.customerName ?? normalized.externalRef ?? "Customer Account";
          const code = makeCode("CUST", normalized.customerCode ?? name);
          const contacts =
            normalized.customerEmail || normalized.customerPhone
              ? [
                  {
                    name,
                    email: normalized.customerEmail ?? undefined,
                    phone: normalized.customerPhone ?? undefined,
                  },
                ]
              : [];
          await query(
            `INSERT INTO customers (code, name, sla_hours, payment_terms, default_currency, contacts)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             RETURNING id`,
            [
              code,
              name,
              normalized.slaHours ?? 48,
              normalized.paymentTerms ?? "NET30",
              normalized.currency || "USD",
              JSON.stringify(contacts),
            ],
          );
          orchestrationSummary = `Synced customer ${name} (${code}) with ${normalized.slaHours ?? 48}h SLA.`;
        } else if (normalized.entityType === "FLEET_VEHICLE") {
          outboundEventName = "fleet.synced";
          const reg = (
            normalized.vehicleRegistration ??
            normalized.externalRef ??
            makeCode("TRK", `UNIT-${idx + 1}`)
          ).toUpperCase();
          await query(
            `INSERT INTO conveyances
               (mode, kind, registration, carrier_code, carrier_name, capacity_kg, capacity_cbm, reefer, hazmat_certified, last_lat, last_lon)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id`,
            [
              normalized.vehicleMode ?? normalized.preferredMode ?? "ROAD",
              normalized.vehicleKind ?? "BOX_TRUCK",
              reg,
              normalized.carrierCode ?? "OWN",
              normalized.carrierName ?? connector.name,
              normalized.capacityKg ?? 10000,
              normalized.capacityCbm ?? 45,
              Boolean(normalized.reefer),
              Boolean(normalized.hazmat),
              normalized.latitude != null ? String(normalized.latitude) : null,
              normalized.longitude != null ? String(normalized.longitude) : null,
            ],
          );
          orchestrationSummary = `Registered fleet vehicle ${reg} (${normalized.capacityKg ?? 10000} kg) ready for autonomous dispatch.`;
        } else if (normalized.entityType === "DRIVER") {
          outboundEventName = "driver.synced";
          const name = normalized.driverName ?? normalized.externalRef ?? "Fleet Driver";
          const licence =
            normalized.driverLicence ?? makeCode("DRV", name);
          await query(
            `INSERT INTO drivers (name, phone, licence_number, licence_expiry, hazmat_certified, carrier_code, carrier_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [
              name,
              normalized.driverPhone ?? "",
              licence,
              normalized.driverLicenceExpiry ?? null,
              Boolean(normalized.hazmat),
              normalized.carrierCode ?? "OWN",
              normalized.carrierName ?? connector.name,
            ],
          );
          orchestrationSummary = `Synced active driver ${name} (${licence}) into Fleet roster.`;
        } else if (normalized.entityType === "TELEMETRY") {
          outboundEventName = "telemetry.updated";
          const unitReg =
            normalized.vehicleRegistration ?? normalized.externalRef ?? "EXT-UNIT";

          if (normalized.latitude !== null && normalized.longitude !== null) {
            await query(
              `UPDATE conveyances
                  SET identifiers = COALESCE(identifiers, '{}'::jsonb) || jsonb_build_object(
                        'last_lat', $1::text,
                        'last_lon', $2::text,
                        'last_speed', $3::text,
                        'last_seen_at', $4::text
                      ),
                      updated_at = now()
                WHERE upper(identifiers->>'registration') = upper($5)`,
              [
                String(normalized.latitude),
                String(normalized.longitude),
                normalized.speedKph != null ? String(normalized.speedKph) : "",
                new Date().toISOString(),
                unitReg,
              ],
            );
          }

          let targetShipmentId: string | null = null;
          if (normalized.shipmentRef) {
            const ship = await query<{ id: string }>(
              `SELECT id FROM shipments WHERE upper(reference) = upper($1) LIMIT 1`,
              [normalized.shipmentRef],
            );
            targetShipmentId = ship[0]?.id ?? null;
          } else {
            const activeLeg = await query<{ shipment_id: string }>(
              `SELECT l.shipment_id
                 FROM shipment_legs l
                 JOIN conveyances v ON v.id = l.conveyance_id
                WHERE upper(v.identifiers->>'registration') = upper($1)
                  AND l.state NOT IN ('COMPLETED', 'CANCELLED')
                ORDER BY l.sequence
                LIMIT 1`,
              [unitReg],
            );
            targetShipmentId = activeLeg[0]?.shipment_id ?? null;
          }

          if (targetShipmentId) {
            await query(
              `INSERT INTO tracking_events
                 (shipment_id, occurred_at, source, event_type, latitude, longitude, speed_kph, temperature_c, payload)
               VALUES ($1, now(), 'API', 'POSITION', $2, $3, $4, $5, $6::jsonb)`,
              [
                targetShipmentId,
                normalized.latitude,
                normalized.longitude,
                normalized.speedKph,
                normalized.temperatureC,
                JSON.stringify({
                  connector: connector.name,
                  vehicle: normalized.vehicleRegistration,
                  externalRef: normalized.externalRef,
                }),
              ],
            );
            await query(
              `INSERT INTO shipment_events
                 (shipment_id, seq, type, from_state, to_state, payload, actor)
               VALUES (
                 $1,
                 (SELECT COALESCE(MAX(seq), 0) + 1 FROM shipment_events WHERE shipment_id = $1),
                 $2, $3, $4, $5::jsonb, $6
               )`,
              [
                targetShipmentId,
                "telemetry.position_updated",
                null,
                null,
                JSON.stringify({
                  connector: connector.name,
                  vehicle: normalized.vehicleRegistration,
                  lat: normalized.latitude,
                  lon: normalized.longitude,
                  speedKph: normalized.speedKph,
                  temperatureC: normalized.temperatureC,
                }),
                `integration:${connector.system_type}`,
              ],
            );
          }

          if (!isSyncOnly) {
            const dispatch = await dispatchToAutonomousAgent({
              sourceChannel: "EXTERNAL_API",
              intentHint: "TRACKING_INQUIRY",
              message: `${connector.name} GPS telemetry: ${normalized.summary}${normalized.notes ? ` · ${normalized.notes}` : ""}`,
              reference: normalized.shipmentRef,
              externalId: connector.id,
              displayName: connector.name,
              orgId: connector.org_id,
              actorEmail: actorEmail ?? `connector@${connector.system_type}`,
              mode: "background_orchestrate",
              skipEntityCreation: true,
            });
            delegatedAgents = dispatch.delegatedAgents;
            orchestrationSummary =
              dispatch.orchestrationSummary ??
              `Updated live GPS coordinates for ${normalized.vehicleRegistration ?? normalized.shipmentRef ?? "vehicle"}.`;
          }
        } else if (normalized.entityType === "INVENTORY_SYNC") {
          outboundEventName = "inventory.synced";
          const whCode = (normalized.warehouseCode ?? "MAIN-HUB")
            .trim()
            .toUpperCase();
          const sku = (normalized.sku ?? normalized.externalRef ?? "SKU-EXT")
            .trim()
            .toUpperCase();
          const onHand = Math.max(0, Math.round(normalized.onHand ?? 0));
          const reserved = Math.min(
            onHand,
            Math.max(0, Math.round(normalized.reserved ?? 0)),
          );

          let whRows = await query<{ id: string }>(
            `SELECT id FROM warehouses WHERE upper(code) = upper($1) LIMIT 1`,
            [whCode],
          );
          if (!whRows[0]) {
            whRows = await query<{ id: string }>(
              `INSERT INTO warehouses (code, name)
               VALUES ($1, $2)
               ON CONFLICT (org_id, code) DO NOTHING
               RETURNING id`,
              [whCode, `${whCode} (${connector.name})`],
            );
            if (!whRows[0]) {
              whRows = await query<{ id: string }>(
                `SELECT id FROM warehouses WHERE upper(code) = upper($1) LIMIT 1`,
                [whCode],
              );
            }
          }

          if (whRows[0]) {
            await query(
              `INSERT INTO inventory (warehouse_id, sku, on_hand, reserved)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (warehouse_id, sku) DO UPDATE
                 SET on_hand = EXCLUDED.on_hand,
                     reserved = EXCLUDED.reserved,
                     updated_at = now()`,
              [whRows[0].id, sku, onHand, reserved],
            );
          }

          if (!isSyncOnly) {
            const dispatch = await dispatchToAutonomousAgent({
              sourceChannel: "EXTERNAL_API",
              intentHint: "PLANNING_ROUTING",
              message: `${connector.name} warehouse inventory sync: ${normalized.summary}${normalized.notes ? ` · ${normalized.notes}` : ""}`,
              reference: normalized.shipmentRef,
              externalId: connector.id,
              displayName: connector.name,
              orgId: connector.org_id,
              actorEmail: actorEmail ?? `connector@${connector.system_type}`,
              mode: "background_orchestrate",
              skipEntityCreation: true,
            });
            delegatedAgents = dispatch.delegatedAgents;
            orchestrationSummary =
              dispatch.orchestrationSummary ??
              `Updated inventory ${normalized.warehouseCode ?? "MAIN-HUB"} / ${normalized.sku ?? "SKU"} (on hand: ${normalized.onHand ?? 0}).`;
          }
        } else {
          // ORDER, SHIPMENT_UPDATE, EXCEPTION, CARRIER_QUOTE, CUSTOMS_DOC
          outboundEventName =
            normalized.entityType === "EXCEPTION"
              ? "exception.detected"
              : normalized.entityType === "ORDER"
                ? "shipment.booked"
                : "shipment.updated";

          const autonomyNote =
            connector.autonomy_mode === "ASSISTED_APPROVAL"
              ? "[Connector Policy: Assisted Approval — queue bookings for operator approval]"
              : connector.autonomy_mode === "FULL_AUTONOMOUS"
                ? "[Connector Policy: Full Autonomous — execute full planning, carrier scoring, fleet assignment, and booking]"
                : "[Connector Policy: Sync Only]";

          const dispatch = await dispatchToAutonomousAgent({
            sourceChannel: "EXTERNAL_API",
            intentHint: normalized.intent,
            message: `${connector.name} (${normalized.entityType}): ${normalized.summary}. ${normalized.notes ?? ""} ${autonomyNote}`.trim(),
            reference: normalized.shipmentRef,
            externalId: normalized.externalRef ?? connector.id,
            displayName: normalized.customerName ?? connector.name,
            orgId: connector.org_id,
            actorEmail:
              actorEmail ??
              normalized.customerEmail ??
              `connector@${connector.system_type}`,
            mode: isSyncOnly ? "background_orchestrate" : runMode,
            skipEntityCreation: false,
            structured: {
              originCity: normalized.originCity,
              originAddress: normalized.originAddress ?? null,
              originCountry: normalized.originCountry ?? null,
              destinationCity: normalized.destinationCity,
              destinationAddress: normalized.destinationAddress ?? null,
              destinationCountry: normalized.destinationCountry ?? null,
              cargoDescription: normalized.cargoDescription,
              weightKg: normalized.weightKg,
              quantity: normalized.quantity,
              deadlineIso: normalized.deadlineIso,
              preferredMode: normalized.preferredMode,
              customerName: normalized.customerName ?? connector.name,
              customerEmail: normalized.customerEmail,
              shipperName: normalized.shipperName ?? null,
              shipperPhone: normalized.shipperPhone ?? null,
              shipperEmail: normalized.shipperEmail ?? null,
              receiverName: normalized.receiverName ?? null,
              receiverPhone: normalized.receiverPhone ?? null,
              receiverEmail: normalized.receiverEmail ?? null,
              hsCode: normalized.hsCode ?? null,
              incoterm: normalized.incoterm ?? null,
              hazmat: normalized.hazmat,
              reefer: normalized.reefer,
              currency: normalized.currency,
              notes: [
                normalized.externalRef ? `External Ref: ${normalized.externalRef}` : "",
                `Source System: ${connector.name}`,
                normalized.notes ?? "",
              ]
                .filter(Boolean)
                .join(" · "),
            },
          });

          orderReference = dispatch.orderReference;
          shipmentReference = dispatch.shipmentReference ?? normalized.shipmentRef;
          delegatedAgents = isSyncOnly ? [] : dispatch.delegatedAgents;
          orchestrationSummary = dispatch.orchestrationSummary;

          // True end-to-end Autonomous Takeover for every newly ingested order
          if (
            autoTakeoverEnabled &&
            dispatch.shipmentId &&
            normalized.entityType === "ORDER"
          ) {
            const takeover = await runAutonomousTakeoverForShipment({
              shipmentId: dispatch.shipmentId,
              shipmentReference: dispatch.shipmentReference,
              orgId: connector.org_id,
              autonomyMode: connector.autonomy_mode,
              customerName: normalized.customerName,
              customerEmail: normalized.customerEmail,
              originCity: normalized.originCity,
              destinationCity: normalized.destinationCity,
              weightKg: normalized.weightKg,
              quantity: normalized.quantity,
              preferredMode: normalized.preferredMode,
              currency: normalized.currency,
              hazmat: normalized.hazmat,
              reefer: normalized.reefer,
              deadlineIso: normalized.deadlineIso,
              sourceName: connector.name,
              actorEmail: actorEmail ?? `connector@${connector.system_type}`,
            });

            if (takeover.finalState === "BOOKED") takeoverBooked += 1;
            else if (takeover.finalState === "AWAITING_APPROVAL") takeoverApprovals += 1;

            orchestrationSummary = orchestrationSummary
              ? `${takeover.summary} · ${orchestrationSummary}`
              : takeover.summary;
          }
        }

        await recordAudit({
          actor: actorEmail ?? `connector:${connector.id}`,
          actorType: "INTEGRATION",
          orgId: connector.org_id,
          action: `INTEGRATION_${normalized.entityType}`,
          entityType: shipmentReference ?? orderReference ?? connector.name,
          after: {
            connectorId: connector.id,
            connectorName: connector.name,
            mappedBy: normalized.mappedBy,
            externalRef: normalized.externalRef,
            orderReference,
            shipmentReference,
            delegatedAgents,
          },
        });
      });

      const outboundStatus = await dispatchOutboundCallback(
        connector,
        outboundEventName,
        {
          externalRef: normalized.externalRef,
          entityType: normalized.entityType,
          orderReference,
          shipmentReference,
          delegatedAgents,
          autonomyMode: connector.autonomy_mode,
          summary: normalized.summary,
          orchestrationSummary,
        },
      );

      const latencyMs = Math.max(1, Date.now() - startedAt);
      const ev = await recordIntegrationEvent({
        orgId: connector.org_id,
        connectorId: connector.id,
        connectorName: connector.name,
        direction: "INBOUND",
        format: parsed.format,
        entityType: normalized.entityType,
        status: "PROCESSED",
        idempotencyKey: effectiveIdemKey,
        externalRef: normalized.externalRef,
        shipmentRef: shipmentReference,
        orderRef: orderReference,
        mappedBy: normalized.mappedBy,
        summary: normalized.summary,
        delegatedAgents,
        rawPreview,
        normalizedPayload: normalized as unknown as Record<string, unknown>,
        outboundStatus,
        latencyMs,
        error: null,
      });

      entityCounts[normalized.entityType] =
        (entityCounts[normalized.entityType] ?? 0) + 1;
      events.push(ev);
      processed += 1;
      outcomes.push({
        index: idx,
        status: "PROCESSED",
        entityType: normalized.entityType,
        mappedBy: normalized.mappedBy,
        externalRef: normalized.externalRef,
        orderReference,
        shipmentReference,
        delegatedAgents,
        summary: normalized.summary,
        orchestrationSummary,
        outboundWebhookStatus: outboundStatus,
        normalized,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ingestion failed";
      const latencyMs = Math.max(1, Date.now() - startedAt);
      const ev = await recordIntegrationEvent({
        orgId: connector.org_id,
        connectorId: connector.id,
        connectorName: connector.name,
        direction: "INBOUND",
        format: parsed.format,
        entityType: "ORDER",
        status: "FAILED",
        idempotencyKey: effectiveIdemKey,
        externalRef: null,
        shipmentRef: null,
        orderRef: null,
        mappedBy: "HEURISTIC",
        summary: "Failed to ingest external payload",
        delegatedAgents: [],
        rawPreview,
        normalizedPayload: {},
        outboundStatus: null,
        latencyMs,
        error: message,
      });
      events.push(ev);
      failed += 1;
      outcomes.push({
        index: idx,
        status: "FAILED",
        entityType: "ORDER",
        mappedBy: "HEURISTIC",
        externalRef: null,
        orderReference: null,
        shipmentReference: null,
        delegatedAgents: [],
        summary: "Ingestion failed",
        orchestrationSummary: null,
        outboundWebhookStatus: null,
        normalized: {
          entityType: "ORDER",
          intent: "NEW_ORDER",
          mappedBy: "HEURISTIC",
          confidence: 0,
          externalRef: null,
          shipmentRef: null,
          originCity: null,
          destinationCity: null,
          cargoDescription: null,
          weightKg: null,
          quantity: null,
          deadlineIso: null,
          preferredMode: null,
          customerName: null,
          customerEmail: null,
          hazmat: false,
          reefer: false,
          currency: "USD",
          vehicleRegistration: null,
          latitude: null,
          longitude: null,
          speedKph: null,
          temperatureC: null,
          warehouseCode: null,
          sku: null,
          onHand: null,
          reserved: null,
          severity: null,
          statusUpdate: null,
          notes: null,
          summary: "Failed",
        },
        error: message,
      });
    }
  }

  await bumpConnectorStats(connector.id, processed, failed, connector.org_id);

  return {
    ok: failed === 0,
    connectorId: connector.id,
    connectorName: connector.name,
    autonomyMode: connector.autonomy_mode,
    format: parsed.format,
    totalReceived: records.length,
    processed,
    duplicates,
    failed,
    entityCounts,
    takeoverSummary: {
      booked: takeoverBooked,
      awaitingApproval: takeoverApprovals,
    },
    outcomes,
    events,
  };
}
