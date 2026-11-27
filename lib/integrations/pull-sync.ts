import { Client } from "pg";
import {
  detectAndParseRawPayload,
  normalizeRecordDeterministically,
  type DetectedPayloadFormat,
} from "./mapper";
import {
  validateDatabaseUrlForConnect,
  validateOutboundWebhookUrlForDispatch,
} from "./security";

const MAX_EXTERNAL_API_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_DB_ROWS_PER_TABLE = 150;
const MAX_DB_TOTAL_RECORDS = 500;

export interface ExternalApiTestResult {
  ok: boolean;
  statusCode?: number;
  format?: DetectedPayloadFormat;
  totalRecords: number;
  entityBreakdown: Record<string, number>;
  records: Record<string, unknown>[];
  error?: string;
}

export interface DiscoveredDbTable {
  schema: string;
  table: string;
  qualifiedName: string;
  suggestedEntity: string;
  rowCount: number;
}

export interface PostgresDiscoveryResult {
  ok: boolean;
  host?: string;
  database?: string;
  tables: DiscoveredDbTable[];
  error?: string;
}

export interface PostgresPullResult {
  ok: boolean;
  tablesSynced: string[];
  totalRecords: number;
  records: Record<string, unknown>[];
  error?: string;
}

const TABLE_PRIORITY_ORDER: { pattern: RegExp; entity: string; rank: number }[] = [
  { pattern: /(warehouse|facility|facilities|depot|hub|location|site|plant)/i, entity: "WAREHOUSE", rank: 1 },
  { pattern: /(carrier|transporter|haulier|hauler|liner|airline|freight_partner)/i, entity: "CARRIER", rank: 2 },
  { pattern: /(customer|client|consignee|account|partner|company|buyer)/i, entity: "CUSTOMER", rank: 3 },
  { pattern: /(conveyance|vehicle|truck|fleet|trailer|vessel|aircraft|asset)/i, entity: "FLEET_VEHICLE", rank: 4 },
  { pattern: /(driver|operator|chauffeur|captain|pilot)/i, entity: "DRIVER", rank: 5 },
  { pattern: /(inventory|stock|sku|warehouse_item|product_stock)/i, entity: "INVENTORY_SYNC", rank: 6 },
  { pattern: /(order|booking|load|tender|dispatch|consignment|waybill|job|purchase_order)/i, entity: "ORDER", rank: 7 },
  { pattern: /(shipment|delivery|deliveries|freight|manifest)/i, entity: "ORDER", rank: 8 },
  { pattern: /(telemetry|gps|position|ping|tracking_event)/i, entity: "TELEMETRY", rank: 9 },
  { pattern: /(exception|incident|delay|alert|claim|issue)/i, entity: "EXCEPTION", rank: 10 },
];

export function classifyTableName(tableName: string): { entity: string; rank: number } {
  for (const rule of TABLE_PRIORITY_ORDER) {
    if (rule.pattern.test(tableName)) {
      return { entity: rule.entity, rank: rule.rank };
    }
  }
  return { entity: "ORDER", rank: 50 };
}

function quotePgIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function buildPgClient(databaseUrl: string): Client {
  const needsSsl =
    !/sslmode=disable/i.test(databaseUrl) &&
    (/sslmode=(require|verify-ca|verify-full|prefer)/i.test(databaseUrl) ||
      /\.(neon\.tech|supabase\.co|amazonaws\.com|render\.com|railway\.app|aivencloud\.com|cockroachlabs\.cloud|digitalocean\.com)/i.test(
        databaseUrl,
      ));

  return new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 10_000,
    query_timeout: 10_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
}

/**
 * Safely fetches an external REST API / storefront / ERP endpoint (with DNS + IP SSRF checks)
 * and parses all records so Control Tower can preview or immediately ingest them.
 */
export async function testAndFetchExternalApi({
  sourceUrl,
  authHeader,
}: {
  sourceUrl: string;
  authHeader?: string | null;
}): Promise<ExternalApiTestResult> {
  const check = await validateOutboundWebhookUrlForDispatch(sourceUrl);
  if (!check.ok || !check.normalizedUrl) {
    return {
      ok: false,
      totalRecords: 0,
      entityBreakdown: {},
      records: [],
      error: check.error ?? "Invalid external API URL.",
    };
  }

  const headers: Record<string, string> = {
    Accept: "application/json, text/csv, text/plain;q=0.9",
    "User-Agent": "ControlTower-Sync/1.0",
  };
  if (authHeader?.trim()) {
    const trimmedAuth = authHeader.trim();
    if (/^(Bearer|Basic|Token|ApiKey)\s+/i.test(trimmedAuth)) {
      headers.Authorization = trimmedAuth;
    } else {
      headers.Authorization = `Bearer ${trimmedAuth}`;
    }
  }

  try {
    const res = await fetch(check.normalizedUrl, {
      method: "GET",
      redirect: "error",
      headers,
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      return {
        ok: false,
        statusCode: res.status,
        totalRecords: 0,
        entityBreakdown: {},
        records: [],
        error: `Remote endpoint returned HTTP ${res.status}. Verify the URL and authentication header.`,
      };
    }

    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_EXTERNAL_API_BYTES) {
      return {
        ok: false,
        statusCode: res.status,
        totalRecords: 0,
        entityBreakdown: {},
        records: [],
        error: "Remote payload exceeds the 2 MB single-sync size limit.",
      };
    }

    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > MAX_EXTERNAL_API_BYTES) {
      return {
        ok: false,
        statusCode: res.status,
        totalRecords: 0,
        entityBreakdown: {},
        records: [],
        error: "Remote payload exceeds the 2 MB single-sync size limit.",
      };
    }

    const parsed = detectAndParseRawPayload(text, res.headers.get("content-type"));
    const breakdown: Record<string, number> = {};
    for (const rec of parsed.records.slice(0, 500)) {
      const { normalized } = normalizeRecordDeterministically(rec);
      breakdown[normalized.entityType] = (breakdown[normalized.entityType] ?? 0) + 1;
    }

    return {
      ok: true,
      statusCode: res.status,
      format: parsed.format,
      totalRecords: parsed.records.length,
      entityBreakdown: breakdown,
      records: parsed.records.slice(0, MAX_DB_TOTAL_RECORDS),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not reach external API.";
    return {
      ok: false,
      totalRecords: 0,
      entityBreakdown: {},
      records: [],
      error: `Failed to fetch external endpoint: ${msg}`,
    };
  }
}

/**
 * Connects read-only to a customer's external PostgreSQL database (after DNS + IP SSRF checks)
 * and discovers all user tables along with estimated row counts and suggested Control Tower entity mappings.
 */
export async function discoverExternalPostgresTables(
  databaseUrl: string,
): Promise<PostgresDiscoveryResult> {
  const check = await validateDatabaseUrlForConnect(databaseUrl);
  if (!check.ok) {
    return { ok: false, tables: [], error: check.error ?? "Invalid PostgreSQL URL." };
  }

  const client = buildPgClient(databaseUrl);
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");

    const tableRes = await client.query<{
      table_schema: string;
      table_name: string;
      est_rows: string | number | null;
    }>(
      `SELECT t.table_schema,
              t.table_name,
              COALESCE(s.n_live_tup, 0) AS est_rows
         FROM information_schema.tables t
         LEFT JOIN pg_stat_user_tables s
           ON s.schemaname = t.table_schema AND s.relname = t.table_name
        WHERE t.table_type = 'BASE TABLE'
          AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY t.table_schema, t.table_name
        LIMIT 80`,
    );

    const tables: DiscoveredDbTable[] = tableRes.rows
      .map((r) => {
        const { entity } = classifyTableName(r.table_name);
        return {
          schema: r.table_schema,
          table: r.table_name,
          qualifiedName: `${r.table_schema}.${r.table_name}`,
          suggestedEntity: entity,
          rowCount: Math.max(0, Number(r.est_rows) || 0),
        };
      })
      .sort(
        (a, b) =>
          classifyTableName(a.table).rank - classifyTableName(b.table).rank ||
          a.qualifiedName.localeCompare(b.qualifiedName),
      );

    return {
      ok: true,
      host: check.host,
      database: check.database,
      tables,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Database connection failed.";
    return {
      ok: false,
      tables: [],
      error: `Could not connect to PostgreSQL: ${msg}`,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Pulls rows read-only from discovered/selected tables in dependency order
 * (warehouses → carriers → customers → fleet → drivers → inventory → orders → shipments → telemetry → exceptions)
 * so every downstream foreign key and autonomous booking succeeds on the first pass.
 */
export async function pullExternalPostgresRecords(
  databaseUrl: string,
  selectedTables?: string[],
  maxRowsPerTable = MAX_DB_ROWS_PER_TABLE,
): Promise<PostgresPullResult> {
  const check = await validateDatabaseUrlForConnect(databaseUrl);
  if (!check.ok) {
    return {
      ok: false,
      tablesSynced: [],
      totalRecords: 0,
      records: [],
      error: check.error ?? "Invalid PostgreSQL URL.",
    };
  }

  const client = buildPgClient(databaseUrl);
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");

    const availableRes = await client.query<{
      table_schema: string;
      table_name: string;
    }>(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND table_schema NOT IN ('pg_catalog', 'information_schema')
        LIMIT 80`,
    );

    const requestedSet =
      Array.isArray(selectedTables) && selectedTables.length > 0
        ? new Set(selectedTables.map((t) => t.trim().toLowerCase()))
        : null;

    const targetTables = availableRes.rows
      .filter((r) => {
        if (!requestedSet) return true;
        return (
          requestedSet.has(`${r.table_schema}.${r.table_name}`.toLowerCase()) ||
          requestedSet.has(r.table_name.toLowerCase())
        );
      })
      .sort(
        (a, b) =>
          classifyTableName(a.table_name).rank - classifyTableName(b.table_name).rank ||
          a.table_name.localeCompare(b.table_name),
      );

    const records: Record<string, unknown>[] = [];
    const tablesSynced: string[] = [];
    const rowLimit = Math.max(1, Math.min(maxRowsPerTable, MAX_DB_ROWS_PER_TABLE));

    for (const tbl of targetTables) {
      if (records.length >= MAX_DB_TOTAL_RECORDS) break;
      const remaining = MAX_DB_TOTAL_RECORDS - records.length;
      const limit = Math.min(rowLimit, remaining);
      const safeSql = `SELECT * FROM ${quotePgIdent(tbl.table_schema)}.${quotePgIdent(tbl.table_name)} LIMIT $1`;

      try {
        const res = await client.query<Record<string, unknown>>(safeSql, [limit]);
        tablesSynced.push(`${tbl.table_schema}.${tbl.table_name}`);
        for (const row of res.rows) {
          records.push({
            ...row,
            _tableHint: tbl.table_name,
          });
        }
      } catch {
        // Skip unreadable table cleanly and continue syncing remaining tables
      }
    }

    return {
      ok: true,
      tablesSynced,
      totalRecords: records.length,
      records,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Database sync failed.";
    return {
      ok: false,
      tablesSynced: [],
      totalRecords: 0,
      records: [],
      error: `PostgreSQL sync failed: ${msg}`,
    };
  } finally {
    await client.end().catch(() => {});
  }
}
