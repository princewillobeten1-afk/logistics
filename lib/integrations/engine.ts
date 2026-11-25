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
  outcomes: IngestRecordOutcome[];
  events: PublicIntegrationEvent[];
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
  maxRecords = 50,
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
  const records = parsed.records.slice(0, maxRecords);

  const outcomes: IngestRecordOutcome[] = [];
  const events: PublicIntegrationEvent[] = [];
  let processed = 0;
  let duplicates = 0;
  let failed = 0;

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
      const runMode =
        syncOrchestrate && records.length <= 3
          ? "sync_orchestrate"
          : "background_orchestrate";

      await runWithOrgScope(connector.org_id, async () => {
        if (normalized.entityType === "TELEMETRY") {
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
            orchestrationSummary = dispatch.orchestrationSummary;
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
              mode: runMode,
              skipEntityCreation: true,
            });
            delegatedAgents = dispatch.delegatedAgents;
            orchestrationSummary = dispatch.orchestrationSummary;
          }
        } else {
          // ORDER, SHIPMENT_UPDATE, EXCEPTION, CARRIER_QUOTE, CUSTOMS_DOC
          outboundEventName =
            normalized.entityType === "EXCEPTION"
              ? "exception.detected"
              : normalized.entityType === "ORDER"
                ? "shipment.created"
                : "shipment.updated";

          const autonomyNote =
            connector.autonomy_mode === "ASSISTED_APPROVAL"
              ? "[Connector Policy: Assisted Approval — queue spend/bookings for operator approval]"
              : connector.autonomy_mode === "FULL_AUTONOMOUS"
                ? "[Connector Policy: Full Autonomous — execute full planning, allocation, carrier selection, and exception handling]"
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
              destinationCity: normalized.destinationCity,
              cargoDescription: normalized.cargoDescription,
              weightKg: normalized.weightKg,
              quantity: normalized.quantity,
              deadlineIso: normalized.deadlineIso,
              preferredMode: normalized.preferredMode,
              customerName: normalized.customerName ?? connector.name,
              customerEmail: normalized.customerEmail,
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

  await bumpConnectorStats(connector.id, processed, failed);

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
    outcomes,
    events,
  };
}
