import { randomUUID } from "node:crypto";
import { identityQuery, pool, queryAs } from "@/lib/db";
import { assertVerifiedOrgId } from "@/lib/tenant-guard";
import type {
  IntegrationConnectionMode,
  IntegrationConnectorRecord,
  IntegrationEventRecord,
} from "@/lib/local-store";
import {
  getConnectorTemplate,
  type AutonomyMode,
  type SystemCategory,
} from "./catalog";
import {
  generateConnectorApiKey,
  generateWebhookSecret,
  hashSecret,
  sealWebhookSecret,
  timingSafeHexEquals,
  unsealWebhookSecret,
  validateDatabaseUrlSyntax,
  validateOutboundWebhookUrlSyntax,
} from "./security";

export interface PublicConnector {
  id: string;
  orgId: string;
  name: string;
  systemType: string;
  category: SystemCategory;
  connectionMode: IntegrationConnectionMode;
  autoTakeover: boolean;
  sourceUrl: string | null;
  hasSourceAuth: boolean;
  hasDatabaseConfig: boolean;
  dbTables: string[];
  status: "ACTIVE" | "PAUSED";
  autonomyMode: AutonomyMode;
  apiKeyPrefix: string;
  outboundWebhookUrl: string | null;
  outboundEvents: string[];
  fieldMapping: Record<string, string>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastSyncAt: string | null;
  eventsProcessed: number;
  errorsCount: number;
}

export interface PublicIntegrationEvent {
  id: string;
  connectorId: string;
  connectorName: string;
  direction: "INBOUND" | "OUTBOUND";
  format: string;
  entityType: string;
  status: "PROCESSED" | "DUPLICATE" | "FAILED" | "DELIVERED";
  idempotencyKey: string | null;
  externalRef: string | null;
  shipmentRef: string | null;
  orderRef: string | null;
  mappedBy: string;
  summary: string;
  delegatedAgents: string[];
  rawPreview: string;
  normalizedPayload: Record<string, unknown>;
  outboundStatus: string | null;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

let tablesInitialized = false;

async function ensureIntegrationTables(): Promise<void> {
  if (tablesInitialized) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS integration_connectors (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        system_type TEXT NOT NULL,
        category TEXT NOT NULL,
        connection_mode TEXT NOT NULL DEFAULT 'PUSH_WEBHOOK',
        auto_takeover BOOLEAN NOT NULL DEFAULT true,
        source_url TEXT,
        source_auth_sealed TEXT,
        db_config_sealed TEXT,
        db_tables JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        autonomy_mode TEXT NOT NULL DEFAULT 'FULL_AUTONOMOUS',
        api_key_prefix TEXT NOT NULL,
        api_key_hash TEXT NOT NULL UNIQUE,
        webhook_secret_hash TEXT NOT NULL,
        outbound_webhook_url TEXT,
        outbound_events JSONB NOT NULL DEFAULT '[]'::jsonb,
        field_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_sync_at TIMESTAMPTZ,
        events_processed INTEGER NOT NULL DEFAULT 0,
        errors_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    await pool.query(
      `ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS connection_mode TEXT NOT NULL DEFAULT 'PUSH_WEBHOOK'`,
    );
    await pool.query(
      `ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS auto_takeover BOOLEAN NOT NULL DEFAULT true`,
    );
    await pool.query(
      `ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS source_url TEXT`,
    );
    await pool.query(
      `ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS source_auth_sealed TEXT`,
    );
    await pool.query(
      `ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS db_config_sealed TEXT`,
    );
    await pool.query(
      `ALTER TABLE integration_connectors ADD COLUMN IF NOT EXISTS db_tables JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS integration_events (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        connector_name TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'INBOUND',
        format TEXT NOT NULL DEFAULT 'JSON',
        entity_type TEXT NOT NULL DEFAULT 'ORDER',
        status TEXT NOT NULL DEFAULT 'PROCESSED',
        idempotency_key TEXT,
        external_ref TEXT,
        shipment_ref TEXT,
        order_ref TEXT,
        mapped_by TEXT NOT NULL DEFAULT 'HEURISTIC',
        summary TEXT NOT NULL DEFAULT '',
        delegated_agents JSONB NOT NULL DEFAULT '[]'::jsonb,
        raw_preview TEXT NOT NULL DEFAULT '',
        normalized_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        outbound_status TEXT,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      ALTER TABLE integration_connectors ENABLE ROW LEVEL SECURITY;
      ALTER TABLE integration_connectors FORCE ROW LEVEL SECURITY;
      ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
      ALTER TABLE integration_events FORCE ROW LEVEL SECURITY;
    `).catch(() => {});
    tablesInitialized = true;
  } catch {
    // Local fallback store handles queries without DDL
  }
}

export function unsealConnectorSecrets(row: IntegrationConnectorRecord): {
  sourceAuthHeader: string | null;
  databaseUrl: string | null;
} {
  return {
    sourceAuthHeader: row.source_auth_sealed
      ? unsealWebhookSecret(row.source_auth_sealed)
      : null,
    databaseUrl: row.db_config_sealed
      ? unsealWebhookSecret(row.db_config_sealed)
      : null,
  };
}

function toPublicConnector(row: IntegrationConnectorRecord): PublicConnector {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    systemType: row.system_type,
    category: (row.category as SystemCategory) || "CUSTOM",
    connectionMode: row.connection_mode || "PUSH_WEBHOOK",
    autoTakeover: row.auto_takeover !== false,
    sourceUrl: row.source_url ?? null,
    hasSourceAuth: Boolean(row.source_auth_sealed),
    hasDatabaseConfig: Boolean(row.db_config_sealed),
    dbTables: Array.isArray(row.db_tables) ? row.db_tables : [],
    status: row.status === "PAUSED" ? "PAUSED" : "ACTIVE",
    autonomyMode: row.autonomy_mode || "FULL_AUTONOMOUS",
    apiKeyPrefix: row.api_key_prefix,
    outboundWebhookUrl: row.outbound_webhook_url ?? null,
    outboundEvents: Array.isArray(row.outbound_events) ? row.outbound_events : [],
    fieldMapping:
      row.field_mapping && typeof row.field_mapping === "object"
        ? row.field_mapping
        : {},
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
    eventsProcessed: Number(row.events_processed) || 0,
    errorsCount: Number(row.errors_count) || 0,
  };
}

function toPublicEvent(row: IntegrationEventRecord): PublicIntegrationEvent {
  return {
    id: row.id,
    connectorId: row.connector_id,
    connectorName: row.connector_name,
    direction: row.direction === "OUTBOUND" ? "OUTBOUND" : "INBOUND",
    format: row.format,
    entityType: row.entity_type,
    status: row.status,
    idempotencyKey: row.idempotency_key ?? null,
    externalRef: row.external_ref ?? null,
    shipmentRef: row.shipment_ref ?? null,
    orderRef: row.order_ref ?? null,
    mappedBy: row.mapped_by,
    summary: row.summary,
    delegatedAgents: Array.isArray(row.delegated_agents) ? row.delegated_agents : [],
    rawPreview: row.raw_preview,
    normalizedPayload:
      row.normalized_payload && typeof row.normalized_payload === "object"
        ? row.normalized_payload
        : {},
    outboundStatus: row.outbound_status ?? null,
    latencyMs: Number(row.latency_ms) || 0,
    error: row.error ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listOrgConnectors(orgId: string): Promise<PublicConnector[]> {
  assertVerifiedOrgId(orgId, "listOrgConnectors");
  await ensureIntegrationTables();
  const rows = await queryAs<IntegrationConnectorRecord>(
    orgId,
    `SELECT * FROM integration_connectors WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId],
  );
  return rows.map(toPublicConnector);
}

export async function getOrgConnector(
  id: string,
  orgId: string,
): Promise<IntegrationConnectorRecord | null> {
  assertVerifiedOrgId(orgId, "getOrgConnector");
  await ensureIntegrationTables();
  const rows = await queryAs<IntegrationConnectorRecord>(
    orgId,
    `SELECT * FROM integration_connectors WHERE id = $1 AND org_id = $2 LIMIT 1`,
    [id, orgId],
  );
  return rows[0] ?? null;
}

export async function authenticateConnectorApiKey(
  rawApiKey: string | null | undefined,
): Promise<IntegrationConnectorRecord | null> {
  if (!rawApiKey) return null;
  const trimmed = rawApiKey.trim();
  if (trimmed.length < 16 || trimmed.length > 256) return null;
  await ensureIntegrationTables();
  const keyHash = hashSecret(trimmed);
  const rows = await identityQuery<IntegrationConnectorRecord>(
    `SELECT * FROM integration_connectors WHERE api_key_hash = $1 LIMIT 1`,
    [keyHash],
  );
  const found = rows[0];
  if (!found) return null;
  if (!timingSafeHexEquals(found.api_key_hash, keyHash)) return null;
  return found;
}

export async function createOrgConnector(input: {
  orgId: string;
  name: string;
  systemType: string;
  connectionMode?: IntegrationConnectionMode;
  autoTakeover?: boolean;
  sourceUrl?: string | null;
  sourceAuthHeader?: string | null;
  databaseUrl?: string | null;
  dbTables?: string[];
  autonomyMode?: AutonomyMode;
  outboundWebhookUrl?: string | null;
  outboundEvents?: string[];
  fieldMapping?: Record<string, string>;
  createdBy: string;
}): Promise<{
  connector: PublicConnector;
  apiKey: string;
  webhookSecret: string;
}> {
  await ensureIntegrationTables();
  const template = getConnectorTemplate(input.systemType);
  const name = input.name.trim() || template?.name || "External Logistics System";
  const category = template?.category ?? "CUSTOM";
  const autonomyMode: AutonomyMode =
    input.autonomyMode ?? template?.defaultAutonomy ?? "FULL_AUTONOMOUS";

  let normalizedWebhookUrl: string | null = null;
  if (input.outboundWebhookUrl?.trim()) {
    const check = validateOutboundWebhookUrlSyntax(input.outboundWebhookUrl);
    if (!check.ok) {
      throw new Error(check.error ?? "Invalid outbound webhook URL.");
    }
    normalizedWebhookUrl = check.normalizedUrl ?? null;
  }

  let normalizedSourceUrl: string | null = null;
  if (input.sourceUrl?.trim()) {
    const check = validateOutboundWebhookUrlSyntax(input.sourceUrl);
    if (!check.ok) {
      throw new Error(
        (check.error ?? "Invalid source API URL.").replace(
          /Outbound webhook/gi,
          "Source API",
        ),
      );
    }
    normalizedSourceUrl = check.normalizedUrl ?? null;
  }

  let dbConfigSealed: string | null = null;
  if (input.databaseUrl?.trim()) {
    const dbCheck = validateDatabaseUrlSyntax(input.databaseUrl);
    if (!dbCheck.ok) {
      throw new Error(dbCheck.error ?? "Invalid PostgreSQL database URI.");
    }
    dbConfigSealed = sealWebhookSecret(input.databaseUrl.trim());
  }

  const sourceAuthSealed = input.sourceAuthHeader?.trim()
    ? sealWebhookSecret(input.sourceAuthHeader.trim())
    : null;

  const connectionMode: IntegrationConnectionMode =
    input.connectionMode ??
    (dbConfigSealed
      ? "POSTGRES_DB"
      : normalizedSourceUrl
        ? "PULL_API"
        : template?.defaultConnectionMode ?? "PUSH_WEBHOOK");

  const autoTakeover = input.autoTakeover !== false;
  const dbTables = Array.isArray(input.dbTables)
    ? input.dbTables.filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 60)
    : [];

  const key = generateConnectorApiKey();
  const secret = generateWebhookSecret();
  const id = `conn_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const fieldMapping =
    input.fieldMapping && Object.keys(input.fieldMapping).length > 0
      ? input.fieldMapping
      : (template?.defaultFieldMapping ?? {});
  const outboundEvents =
    Array.isArray(input.outboundEvents) && input.outboundEvents.length > 0
      ? input.outboundEvents
      : ["shipment.created", "shipment.booked", "exception.detected", "approval.decided"];

  assertVerifiedOrgId(input.orgId, "createOrgConnector");
  const rows = await queryAs<IntegrationConnectorRecord>(
    input.orgId,
    `INSERT INTO integration_connectors
       (id, org_id, name, system_type, category, status, autonomy_mode,
        api_key_prefix, api_key_hash, webhook_secret_hash,
        outbound_webhook_url, outbound_events, field_mapping, created_by,
        connection_mode, auto_takeover, source_url, source_auth_sealed, db_config_sealed, db_tables)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18, $19, $20::jsonb)
     RETURNING *`,
    [
      id,
      input.orgId,
      name,
      input.systemType || "custom_rest_webhook",
      category,
      "ACTIVE",
      autonomyMode,
      key.prefix,
      key.hash,
      secret.sealed,
      normalizedWebhookUrl,
      JSON.stringify(outboundEvents),
      JSON.stringify(fieldMapping),
      input.createdBy,
      connectionMode,
      autoTakeover,
      normalizedSourceUrl,
      sourceAuthSealed,
      dbConfigSealed,
      JSON.stringify(dbTables),
    ],
  );

  return {
    connector: toPublicConnector(rows[0]),
    apiKey: key.plaintext,
    webhookSecret: secret.plaintext,
  };
}

export async function updateOrgConnector(
  id: string,
  orgId: string,
  patch: {
    name?: string;
    status?: "ACTIVE" | "PAUSED";
    autonomyMode?: AutonomyMode;
    autoTakeover?: boolean;
    sourceUrl?: string | null;
    sourceAuthHeader?: string | null;
    databaseUrl?: string | null;
    dbTables?: string[];
    outboundWebhookUrl?: string | null;
    outboundEvents?: string[];
    fieldMapping?: Record<string, string>;
  },
): Promise<PublicConnector | null> {
  const existing = await getOrgConnector(id, orgId);
  if (!existing) return null;

  let nextWebhookUrl = existing.outbound_webhook_url;
  if (patch.outboundWebhookUrl !== undefined) {
    if (!patch.outboundWebhookUrl || !patch.outboundWebhookUrl.trim()) {
      nextWebhookUrl = null;
    } else {
      const check = validateOutboundWebhookUrlSyntax(patch.outboundWebhookUrl);
      if (!check.ok) {
        throw new Error(check.error ?? "Invalid outbound webhook URL.");
      }
      nextWebhookUrl = check.normalizedUrl ?? null;
    }
  }

  let nextSourceUrl = existing.source_url ?? null;
  if (patch.sourceUrl !== undefined) {
    if (!patch.sourceUrl || !patch.sourceUrl.trim()) {
      nextSourceUrl = null;
    } else {
      const check = validateOutboundWebhookUrlSyntax(patch.sourceUrl);
      if (!check.ok) {
        throw new Error(
          (check.error ?? "Invalid source API URL.").replace(
            /Outbound webhook/gi,
            "Source API",
          ),
        );
      }
      nextSourceUrl = check.normalizedUrl ?? null;
    }
  }

  let nextSourceAuthSealed = existing.source_auth_sealed ?? null;
  if (patch.sourceAuthHeader !== undefined) {
    nextSourceAuthSealed = patch.sourceAuthHeader?.trim()
      ? sealWebhookSecret(patch.sourceAuthHeader.trim())
      : null;
  }

  let nextDbConfigSealed = existing.db_config_sealed ?? null;
  if (patch.databaseUrl !== undefined) {
    if (!patch.databaseUrl || !patch.databaseUrl.trim()) {
      nextDbConfigSealed = null;
    } else {
      const check = validateDatabaseUrlSyntax(patch.databaseUrl);
      if (!check.ok) {
        throw new Error(check.error ?? "Invalid PostgreSQL database URI.");
      }
      nextDbConfigSealed = sealWebhookSecret(patch.databaseUrl.trim());
    }
  }

  const nextName = patch.name?.trim() || existing.name;
  const nextStatus = patch.status === "PAUSED" ? "PAUSED" : patch.status === "ACTIVE" ? "ACTIVE" : existing.status;
  const nextAutonomy = patch.autonomyMode ?? existing.autonomy_mode;
  const nextAutoTakeover =
    patch.autoTakeover !== undefined ? patch.autoTakeover : existing.auto_takeover !== false;
  const nextOutboundEvents = patch.outboundEvents ?? existing.outbound_events;
  const nextMapping = patch.fieldMapping ?? existing.field_mapping;
  const nextDbTables = patch.dbTables ?? existing.db_tables ?? [];

  const rows = await queryAs<IntegrationConnectorRecord>(
    orgId,
    `UPDATE integration_connectors
        SET name = $1,
            status = $2,
            autonomy_mode = $3,
            outbound_webhook_url = $4,
            outbound_events = $5::jsonb,
            field_mapping = $6::jsonb,
            auto_takeover = $7,
            source_url = $8,
            source_auth_sealed = $9,
            db_config_sealed = $10,
            db_tables = $11::jsonb,
            updated_at = now()
      WHERE id = $12 AND org_id = $13
      RETURNING *`,
    [
      nextName,
      nextStatus,
      nextAutonomy,
      nextWebhookUrl,
      JSON.stringify(nextOutboundEvents),
      JSON.stringify(nextMapping),
      nextAutoTakeover,
      nextSourceUrl,
      nextSourceAuthSealed,
      nextDbConfigSealed,
      JSON.stringify(nextDbTables),
      id,
      orgId,
    ],
  );
  return rows[0] ? toPublicConnector(rows[0]) : null;
}

export async function rotateOrgConnectorKey(
  id: string,
  orgId: string,
): Promise<{
  connector: PublicConnector;
  apiKey: string;
  webhookSecret: string;
} | null> {
  const existing = await getOrgConnector(id, orgId);
  if (!existing) return null;

  const key = generateConnectorApiKey();
  const secret = generateWebhookSecret();
  const rows = await queryAs<IntegrationConnectorRecord>(
    orgId,
    `UPDATE integration_connectors
        SET api_key_prefix = $1,
            api_key_hash = $2,
            webhook_secret_hash = $3,
            updated_at = now()
      WHERE id = $4 AND org_id = $5
      RETURNING *`,
    [key.prefix, key.hash, secret.sealed, id, orgId],
  );
  if (!rows[0]) return null;
  return {
    connector: toPublicConnector(rows[0]),
    apiKey: key.plaintext,
    webhookSecret: secret.plaintext,
  };
}

export async function deleteOrgConnector(id: string, orgId: string): Promise<boolean> {
  assertVerifiedOrgId(orgId, "deleteOrgConnector");
  await ensureIntegrationTables();
  const existing = await getOrgConnector(id, orgId);
  if (!existing) return false;
  await queryAs(
    orgId,
    `DELETE FROM integration_connectors WHERE id = $1 AND org_id = $2`,
    [id, orgId],
  );
  return true;
}

export async function bumpConnectorStats(
  connectorId: string,
  processedDelta: number,
  errorsDelta: number,
  orgId?: string,
): Promise<void> {
  await ensureIntegrationTables();
  if (orgId) {
    assertVerifiedOrgId(orgId, "bumpConnectorStats");
    await queryAs(
      orgId,
      `UPDATE integration_connectors
          SET events_processed = events_processed + $1,
              errors_count = errors_count + $2,
              last_sync_at = now(),
              updated_at = now()
        WHERE id = $3 AND org_id = $4`,
      [processedDelta, errorsDelta, connectorId, orgId],
    );
    return;
  }
  await identityQuery(
    `UPDATE integration_connectors
        SET events_processed = events_processed + $1,
            errors_count = errors_count + $2,
            last_sync_at = now(),
            updated_at = now()
      WHERE id = $3`,
    [processedDelta, errorsDelta, connectorId],
  );
}

export async function findDuplicateEvent(
  orgId: string,
  connectorId: string,
  idempotencyKey: string,
): Promise<PublicIntegrationEvent | null> {
  assertVerifiedOrgId(orgId, "findDuplicateEvent");
  await ensureIntegrationTables();
  const rows = await queryAs<IntegrationEventRecord>(
    orgId,
    `SELECT * FROM integration_events
      WHERE org_id = $1 AND connector_id = $2 AND idempotency_key = $3
      LIMIT 1`,
    [orgId, connectorId, idempotencyKey],
  );
  return rows[0] ? toPublicEvent(rows[0]) : null;
}

export async function recordIntegrationEvent(input: {
  orgId: string;
  connectorId: string;
  connectorName: string;
  direction: "INBOUND" | "OUTBOUND";
  format: string;
  entityType: string;
  status: "PROCESSED" | "DUPLICATE" | "FAILED" | "DELIVERED";
  idempotencyKey?: string | null;
  externalRef?: string | null;
  shipmentRef?: string | null;
  orderRef?: string | null;
  mappedBy: string;
  summary: string;
  delegatedAgents: string[];
  rawPreview: string;
  normalizedPayload: Record<string, unknown>;
  outboundStatus?: string | null;
  latencyMs: number;
  error?: string | null;
}): Promise<PublicIntegrationEvent> {
  assertVerifiedOrgId(input.orgId, "recordIntegrationEvent");
  await ensureIntegrationTables();
  const id = `iev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const rows = await queryAs<IntegrationEventRecord>(
    input.orgId,
    `INSERT INTO integration_events
       (id, org_id, connector_id, connector_name, direction, format, entity_type,
        status, idempotency_key, external_ref, shipment_ref, order_ref, mapped_by,
        summary, delegated_agents, raw_preview, normalized_payload, outbound_status,
        latency_ms, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18,$19,$20)
     RETURNING *`,
    [
      id,
      input.orgId,
      input.connectorId,
      input.connectorName,
      input.direction,
      input.format,
      input.entityType,
      input.status,
      input.idempotencyKey ?? null,
      input.externalRef ?? null,
      input.shipmentRef ?? null,
      input.orderRef ?? null,
      input.mappedBy,
      input.summary,
      JSON.stringify(input.delegatedAgents),
      input.rawPreview.slice(0, 800),
      JSON.stringify(input.normalizedPayload),
      input.outboundStatus ?? null,
      Math.max(1, Math.round(input.latencyMs)),
      input.error ?? null,
    ],
  );
  return toPublicEvent(rows[0]);
}

export async function listOrgIntegrationEvents(
  orgId: string,
  limit = 60,
): Promise<PublicIntegrationEvent[]> {
  assertVerifiedOrgId(orgId, "listOrgIntegrationEvents");
  await ensureIntegrationTables();
  const rows = await queryAs<IntegrationEventRecord>(
    orgId,
    `SELECT * FROM integration_events WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [orgId, limit],
  );
  return rows.map(toPublicEvent);
}
