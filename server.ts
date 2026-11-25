import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import next from "next";
import type { Pool } from "pg";
import { WebSocketServer, type WebSocket } from "ws";
import type { LiveServerMessage } from "@google/genai";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

const LIVE_MODEL = "gemini-3.8-live";
const SESSION_COOKIE = "logistics_session";
const LOCAL_STORE_PATH = path.join(tmpdir(), "logistics-local-store.json");
const ALLOWED_VOICES = new Set(["Zephyr", "Puck", "Charon", "Kore", "Fenrir"]);

interface AuthContext {
  userId: string;
  orgId: string;
  orgName: string;
  email: string;
  name: string | null;
  role: string;
}

interface LocalStoreShape {
  orgs?: Array<{ id: string; name: string; active?: boolean }>;
  users?: Array<{
    id: string;
    org_id: string;
    email: string;
    name?: string | null;
    role: string;
    active?: boolean;
  }>;
  sessions?: Array<{ token: string; user_id: string; expires_at: string }>;
  data?: {
    shipments?: Array<{
      reference: string;
      state: string;
      origin?: { city?: string };
      destination?: { city?: string };
      deadline?: string | null;
      cargo?: { description?: string; hazmat?: boolean; reefer?: boolean };
    }>;
    exceptions?: Array<{
      shipment_id?: string;
      kind?: string;
      severity?: string;
      resolved_at?: string | null;
      detail?: { summary?: string };
    }>;
    approvals?: Array<{ status?: string; reason?: string }>;
    orders?: Array<{ reference: string; state: string }>;
    channels?: Array<{ channel?: string; state?: string; enabled?: boolean; credentials?: unknown; config?: Record<string, unknown> }>;
  };
  dataByOrg?: Record<
    string,
    {
      channels?: Array<{ channel?: string; state?: string; enabled?: boolean; credentials?: unknown; config?: Record<string, unknown> }>;
    }
  >;
}

let pgPool: Pool | null = null;
let pgUnavailableUntil = 0;

async function getPgPool(): Promise<Pool | null> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (Date.now() < pgUnavailableUntil) return null;
  if (!pgPool) {
    const { Pool: PgPool } = await import("pg");
    pgPool = new PgPool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 3_000,
    });
  }
  return pgPool;
}

function hasConfiguredTelegramChannel(): boolean {
  if (process.env.TELEGRAM_BOT_TOKEN?.trim()) return true;
  if (process.env.DATABASE_URL?.trim()) return true;
  const store = readLocalStore();
  if (!store) return false;
  const buckets = [
    ...(store.data?.channels ?? []),
    ...Object.values(store.dataByOrg ?? {}).flatMap((b) => b.channels ?? []),
  ];
  return buckets.some(
    (c) =>
      c.channel === "TELEGRAM" &&
      c.enabled === true &&
      c.state === "VERIFIED" &&
      Boolean(c.credentials || c.config?.bot_token),
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

function readLocalStore(): LocalStoreShape | null {
  try {
    if (!existsSync(LOCAL_STORE_PATH)) return null;
    return JSON.parse(readFileSync(LOCAL_STORE_PATH, "utf8")) as LocalStoreShape;
  } catch {
    return null;
  }
}

async function authenticateUpgrade(req: IncomingMessage): Promise<AuthContext | null> {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const pool = await getPgPool();
  if (pool) {
    try {
      const res = await pool.query<{
        id: string;
        org_id: string;
        org_name: string;
        email: string;
        name: string | null;
        role: string;
      }>(
        `SELECT u.id, u.org_id, o.name AS org_name, u.email, u.name, u.role
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           JOIN organisations o ON o.id = u.org_id
          WHERE s.token = $1 AND s.expires_at > now()
            AND u.active AND o.active
          LIMIT 1`,
        [token],
      );
      if (res.rows[0]) {
        const r = res.rows[0];
        return {
          userId: r.id,
          orgId: r.org_id,
          orgName: r.org_name,
          email: r.email,
          name: r.name,
          role: r.role,
        };
      }
    } catch {
      pgUnavailableUntil = Date.now() + 60_000;
    }
  }

  const store = readLocalStore();
  if (!store) return null;
  const now = Date.now();
  const sess = (store.sessions ?? []).find(
    (s) => s.token === token && new Date(s.expires_at).getTime() > now,
  );
  if (!sess) return null;
  const user = (store.users ?? []).find((u) => u.id === sess.user_id && u.active !== false);
  if (!user) return null;
  const org = (store.orgs ?? []).find((o) => o.id === user.org_id && o.active !== false);
  if (!org) return null;

  return {
    userId: user.id,
    orgId: org.id,
    orgName: org.name,
    email: user.email,
    name: user.name ?? null,
    role: user.role,
  };
}

async function buildLiveOperationalBriefing(auth: AuthContext): Promise<string> {
  const pool = await getPgPool();
  if (pool) {
    let client;
    try {
      client = await pool.connect();
      await client.query("SET ROLE logistics_app");
      await client.query("SELECT set_config('app.current_org', $1, false)", [auth.orgId]);
      const [shipRes, excRes, appRes] = await Promise.all([
        client.query<{
          reference: string;
          state: string;
          origin_city: string | null;
          dest_city: string | null;
          cargo_desc: string | null;
        }>(
          `SELECT reference, state,
                  origin->>'city' AS origin_city,
                  destination->>'city' AS dest_city,
                  cargo->>'description' AS cargo_desc
             FROM shipments
            ORDER BY updated_at DESC
            LIMIT 8`,
        ),
        client.query<{ severity: string; kind: string }>(
          `SELECT severity, kind
             FROM exceptions
            WHERE resolved_at IS NULL
            ORDER BY created_at DESC
            LIMIT 6`,
        ),
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM approvals
            WHERE status = 'PENDING'`,
        ),
      ]);
      const ships = shipRes.rows
        .map(
          (s) =>
            `${s.reference} (${s.state}, ${s.origin_city ?? "?"} -> ${s.dest_city ?? "?"}${s.cargo_desc ? `, ${s.cargo_desc.slice(0, 50)}` : ""})`,
        )
        .join("; ");
      const excs = excRes.rows.map((e) => `${e.severity} ${e.kind}`).join("; ");
      const pendingApprovals = Number(appRes.rows[0]?.count ?? 0);
      return [
        `Active shipments (${shipRes.rows.length} shown): ${ships || "none currently recorded"}.`,
        `Open exceptions (${excRes.rows.length}): ${excs || "none"}.`,
        `Pending spending approvals: ${pendingApprovals}.`,
      ].join(" ");
    } catch {
      pgUnavailableUntil = Date.now() + 60_000;
    } finally {
      if (client) {
        try {
          await client.query("RESET ROLE; SELECT set_config('app.current_org', '', false)");
          client.release();
        } catch (err) {
          client.release(err as Error);
        }
      }
    }
  }

  const store = readLocalStore();
  const shipments = (store?.data?.shipments ?? []).slice(0, 8);
  const openExceptions = (store?.data?.exceptions ?? []).filter((e) => !e.resolved_at).slice(0, 6);
  const pendingApprovals = (store?.data?.approvals ?? []).filter((a) => a.status === "PENDING").length;

  const shipsSummary = shipments
    .map(
      (s) =>
        `${s.reference} (${s.state}, ${s.origin?.city ?? "?"} -> ${s.destination?.city ?? "?"}${s.cargo?.hazmat ? ", HAZMAT" : ""}${s.cargo?.reefer ? ", REEFER" : ""})`,
    )
    .join("; ");
  const excSummary = openExceptions
    .map((e) => `${e.severity ?? "OPEN"} ${e.kind ?? "EXCEPTION"}${e.detail?.summary ? `: ${e.detail.summary.slice(0, 60)}` : ""}`)
    .join("; ");

  return [
    `Active shipments (${shipments.length} shown): ${shipsSummary || "none currently recorded"}.`,
    `Open exceptions (${openExceptions.length}): ${excSummary || "none"}.`,
    `Pending spending approvals: ${pendingApprovals}.`,
  ].join(" ");
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function writeHttpRejection(socket: Duplex, statusCode: number, statusText: string) {
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

let isAppReady = false;
const readyPromise = app.prepare().then(() => {
  isAppReady = true;
});

readyPromise.catch((err: unknown) => {
  console.error("[Server] Next.js prepare failed:", err);
  process.exit(1);
});

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (clientWs: WebSocket, req: IncomingMessage, auth: AuthContext) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    sendJson(clientWs, {
      type: "error",
      message: "GEMINI_API_KEY is not configured on the server. Add it in Settings > Secrets.",
    });
    clientWs.close(1011, "Missing API key");
    return;
  }

  const reqUrl = new URL(req.url ?? "/api/live", `http://${req.headers.host ?? "localhost"}`);
  const requestedVoice = reqUrl.searchParams.get("voice") ?? "Zephyr";
  const voiceName = ALLOWED_VOICES.has(requestedVoice) ? requestedVoice : "Zephyr";

  let closed = false;

  const sessionPromise = (async () => {
    const [{ GoogleGenAI, Modality }, briefing] = await Promise.all([
      import("@google/genai"),
      buildLiveOperationalBriefing(auth),
    ]);

    const ai = new GoogleGenAI({
      apiKey,
      apiVersion: "v1beta",
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });

    const operatorLabel = auth.name?.trim() || auth.email;
    const systemInstruction = [
      `You are the real-time Voice Operations Copilot for ${auth.orgName}'s Logistics Control Tower.`,
      `You are speaking live with ${operatorLabel} (role: ${auth.role}).`,
      "Speak naturally, concisely, and clearly in short operational sentences suited for voice playback (avoid markdown, bullet lists, or reading raw JSON).",
      "Ground every factual statement in the live workspace snapshot below. Never invent shipment references, carriers, or rates that are not in the snapshot.",
      `Live workspace snapshot: ${briefing}`,
    ].join(" ");

    return ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction,
      },
      callbacks: {
        onopen: () => {
          sendJson(clientWs, {
            type: "ready",
            voice: voiceName,
            model: LIVE_MODEL,
            orgName: auth.orgName,
          });
        },
        onmessage: (message: LiveServerMessage) => {
          const content = message.serverContent;
          if (!content) return;

          if (content.inputTranscription?.text) {
            sendJson(clientWs, {
              type: "inputTranscript",
              text: content.inputTranscription.text,
            });
          }

          if (content.outputTranscription?.text) {
            sendJson(clientWs, {
              type: "outputTranscript",
              text: content.outputTranscription.text,
            });
          }

          for (const part of content.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) {
              sendJson(clientWs, {
                type: "audio",
                audio: part.inlineData.data,
              });
            }
          }

          if (content.interrupted) {
            sendJson(clientWs, { type: "interrupted" });
          }

          if (content.turnComplete) {
            sendJson(clientWs, { type: "turnComplete" });
          }
        },
        onerror: (event: ErrorEvent) => {
          const detail =
            (event as unknown as { message?: string; error?: { message?: string } })?.message ||
            (event as unknown as { error?: { message?: string } })?.error?.message ||
            "Live voice session encountered a connection error.";
          sendJson(clientWs, { type: "error", message: detail });
        },
        onclose: () => {
          if (!closed && clientWs.readyState === clientWs.OPEN) {
            clientWs.close(1000, "Live session closed");
          }
        },
      },
    });
  })();

  sessionPromise.catch((err: unknown) => {
    const msg =
      err instanceof Error ? err.message : "Failed to connect to Gemini Live voice service.";
    sendJson(clientWs, {
      type: "error",
      message: /429|RESOURCE_EXHAUSTED|quota/i.test(msg)
        ? "Gemini Live API quota or rate limit reached. Retry shortly or select a billing-enabled key in Settings > Secrets."
        : msg,
    });
    if (clientWs.readyState === clientWs.OPEN) {
      clientWs.close(1011, "Upstream live connection failed");
    }
  });

  clientWs.on("message", (raw) => {
    if (closed) return;
    let parsed: { type?: string; audio?: string; text?: string };
    try {
      parsed = JSON.parse(raw.toString()) as { type?: string; audio?: string; text?: string };
    } catch {
      return;
    }

    sessionPromise
      .then((session) => {
        if (closed) return;
        if (typeof parsed.audio === "string" && parsed.audio.length > 0) {
          session.sendRealtimeInput({
            audio: {
              data: parsed.audio,
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } else if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
          session.sendRealtimeInput({
            text: parsed.text.trim().slice(0, 1000),
          });
        }
      })
      .catch(() => {
        // Handled by sessionPromise.catch above
      });
  });

  clientWs.on("close", () => {
    closed = true;
    sessionPromise
      .then((session) => {
        try {
          session.close();
        } catch {
          // Ignore close errors
        }
      })
      .catch(() => {
        // Session never opened
      });
  });
});

const server = createServer((req, res) => {
  const run = async () => {
    if (!isAppReady) {
      await readyPromise;
    }
    await handle(req, res);
  };
  void run().catch((err: unknown) => {
    console.error("[Server] Request handling error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });
});

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  if (pathname !== "/api/live") {
    return;
  }

  void readyPromise
    .then(() => authenticateUpgrade(req))
    .then((auth) => {
      if (!auth) {
        writeHttpRejection(socket, 401, "Unauthorized");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, auth);
      });
    })
    .catch(() => {
      writeHttpRejection(socket, 500, "Internal Server Error");
    });
});

const workerSecret = randomBytes(24).toString("hex");
(globalThis as typeof globalThis & { __telegramWorkerSecret?: string }).__telegramWorkerSecret =
  workerSecret;

let telegramSyncTimer: ReturnType<typeof setTimeout> | null = null;
let telegramKeepAlive: ReturnType<typeof setInterval> | null = null;
let telegramWorkerBooted = false;

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error("[Server] HTTP server error:", err);
  process.exit(1);
});

server.listen(port, hostname, () => {
  console.log(`> Logistics Control Tower ready on http://${hostname}:${port}`);

  const maybeStartTelegramSync = () => {
    if (!isAppReady || telegramWorkerBooted) return;
    if (!hasConfiguredTelegramChannel()) return;

    void fetch(`http://127.0.0.1:${port}/api/channels/telegram/sync`, {
      method: "POST",
      headers: { "x-internal-worker-secret": workerSecret },
      signal: AbortSignal.timeout(15_000),
    })
      .then((res) => {
        if (res.ok) {
          telegramWorkerBooted = true;
        }
      })
      .catch(() => {
        // Retry on next keep-alive tick if Next.js is still finishing first compile
      });
  };

  void readyPromise.then(() => {
    telegramSyncTimer = setTimeout(maybeStartTelegramSync, 10_000);
    telegramSyncTimer.unref();
    telegramKeepAlive = setInterval(maybeStartTelegramSync, 120_000);
    telegramKeepAlive.unref();
  });
});

const shutdown = (signal: string) => {
  console.log(`[Server] Received ${signal}, shutting down cleanly...`);
  if (telegramSyncTimer) clearTimeout(telegramSyncTimer);
  if (telegramKeepAlive) clearInterval(telegramKeepAlive);
  wss.close();
  server.close(() => {
    if (pgPool) {
      void pgPool.end().finally(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });
  setTimeout(() => process.exit(0), 3_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
