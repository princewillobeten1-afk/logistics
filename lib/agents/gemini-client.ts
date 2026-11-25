export const Type = {
  OBJECT: "OBJECT",
  ARRAY: "ARRAY",
  STRING: "STRING",
  NUMBER: "NUMBER",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
} as const;

export type SchemaType = (typeof Type)[keyof typeof Type];

export interface Schema {
  type?: SchemaType | string;
  description?: string;
  enum?: string[];
  nullable?: boolean;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
}

export const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
export const DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const AGENT_GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-lite";

// Retained for backwards compatibility with existing callers/logs.
export const AGENT_GEMINI_MODEL =
  process.env.NVIDIA_MODEL?.trim() ||
  process.env.GEMINI_MODEL?.trim() ||
  DEFAULT_NVIDIA_MODEL;

export type AiProvider = "nvidia" | "gemini";

export interface GeminiGenerationMeta {
  model: string;
  provider?: AiProvider;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export class MissingGeminiKeyError extends Error {
  readonly status = 503;
  constructor() {
    super(
      "Neither NVIDIA_API_KEY nor GEMINI_API_KEY is configured on the server.",
    );
    this.name = "MissingGeminiKeyError";
  }
}

export function getServerNvidiaKey(): string | null {
  const key = process.env.NVIDIA_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function getRawGeminiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

/**
 * Returns the active AI provider based on environment configuration.
 * Prefers NVIDIA Nemotron (`nvidia/nemotron-3.5-super-vl-120b-a12b`) when
 * `NVIDIA_API_KEY` is configured (unless `AI_PROVIDER=gemini` is explicitly set).
 */
export function getActiveAiProvider(): AiProvider | null {
  const nvidiaKey = getServerNvidiaKey();
  const geminiKey = getRawGeminiKey();
  const explicit = process.env.AI_PROVIDER?.trim().toLowerCase();

  if (explicit === "gemini" && geminiKey) return "gemini";
  if (explicit === "nvidia" && nvidiaKey) return "nvidia";
  if (nvidiaKey) return "nvidia";
  if (geminiKey) return "gemini";
  return null;
}

/**
 * Returns the active server LLM API key (NVIDIA NIM or Gemini).
 * Kept under the historical name `getServerGeminiKey` so all existing agent
 * call sites activate automatically with either `NVIDIA_API_KEY` or `GEMINI_API_KEY`.
 */
export function getServerGeminiKey(): string | null {
  const provider = getActiveAiProvider();
  if (provider === "nvidia") return getServerNvidiaKey();
  if (provider === "gemini") return getRawGeminiKey();
  return null;
}

export function getActiveModelName(provider?: AiProvider | null): string {
  const active = provider ?? getActiveAiProvider();
  if (active === "gemini") {
    return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  }
  return process.env.NVIDIA_MODEL?.trim() || DEFAULT_NVIDIA_MODEL;
}

export function parseRetryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const match =
    msg.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i) ??
    msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (!match) return null;
  const secs = Number(match[1]);
  return Number.isFinite(secs) && secs > 0 ? Math.ceil(secs * 1000) : null;
}

export function isDailyQuotaExhausted(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (
    /PerDay|GenerateRequestsPerDay|requests?\s+per\s+day|daily.*(quota|limit)/i.test(
      msg,
    )
  ) {
    return true;
  }
  const hinted = parseRetryDelayMs(err);
  return hinted !== null && hinted > 60_000;
}

export function isRateLimitError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (status === 429) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /RESOURCE_EXHAUSTED|rate limit|quota|429/i.test(msg);
}

export function isTransientError(err: unknown): boolean {
  if (isDailyQuotaExhausted(err)) return false;
  if (isRateLimitError(err)) return true;
  const status = (err as { status?: unknown })?.status;
  if (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /ECONNRESET|ETIMEDOUT|UNAVAILABLE|DEADLINE_EXCEEDED|overloaded|timed out|aborted|fetch failed/i.test(
    msg,
  );
}

export async function withBackoff<T>(
  fn: (attemptSignal: AbortSignal) => Promise<T>,
  {
    maxAttempts = 4,
    totalTimeoutMs = 65_000,
    perAttemptTimeoutMs = 25_000,
    sleepFn = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    maxAttempts?: number;
    totalTimeoutMs?: number;
    perAttemptTimeoutMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const deadline = Date.now() + totalTimeoutMs;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 1_500) {
      throw lastErr ?? new Error("AI model request timed out.");
    }

    const attemptBudget = Math.min(perAttemptTimeoutMs, remainingMs);
    const attemptSignal = AbortSignal.timeout(attemptBudget);

    try {
      return await fn(attemptSignal);
    } catch (err) {
      lastErr = err;
      const timeLeftAfterErr = deadline - Date.now();
      if (
        attempt + 1 >= maxAttempts ||
        !isTransientError(err) ||
        timeLeftAfterErr <= 5_000
      ) {
        throw err;
      }

      const hintedDelay = parseRetryDelayMs(err);
      if (hintedDelay && hintedDelay > timeLeftAfterErr - 5_000) {
        throw err;
      }

      const rawDelay = hintedDelay
        ? hintedDelay + Math.floor(Math.random() * 500)
        : isRateLimitError(err)
          ? Math.min(14_000, 3_000 * 2 ** attempt) +
            Math.floor(Math.random() * 600)
          : Math.min(6_000, 1_200 * 2 ** attempt) +
            Math.floor(Math.random() * 400);
      const boundedDelay = Math.min(
        rawDelay,
        Math.max(500, timeLeftAfterErr - 5_000),
      );
      await sleepFn(boundedDelay);
    }
  }
  throw lastErr;
}

/**
 * Converts our Gemini-style Schema (uppercase types, `nullable: true`) into
 * standard JSON Schema (lowercase types, type unions for nullable fields) for
 * OpenAI-compatible NVIDIA NIM structured outputs.
 */
export function toStandardJsonSchema(schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rawType = schema.type ? String(schema.type).toLowerCase() : "object";
  out.type = schema.nullable ? [rawType, "null"] : rawType;

  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (schema.items) out.items = toStandardJsonSchema(schema.items);
  if (schema.properties) {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      props[key] = toStandardJsonSchema(value);
    }
    out.properties = props;
  }
  if (Array.isArray(schema.required)) {
    out.required = schema.required;
  }
  return out;
}

/**
 * Extracts a JSON object from model output, safely stripping reasoning
 * `<think>...</think>` blocks and markdown code fences.
 */
export function extractJsonObject<T>(rawText: string): T {
  const stripped = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  if (!stripped) {
    throw new Error("Model returned empty structured output.");
  }

  try {
    return JSON.parse(stripped) as T;
  } catch {
    const startIdx = stripped.indexOf("{");
    const endIdx = stripped.lastIndexOf("}");
    if (startIdx >= 0 && endIdx > startIdx) {
      return JSON.parse(stripped.slice(startIdx, endIdx + 1)) as T;
    }
    throw new Error("Model returned non-JSON structured output.");
  }
}

function makeHttpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

async function generateWithNvidia<T>({
  apiKey,
  systemInstruction,
  prompt,
  responseSchema,
  thinkingDepth,
  seed,
  schemaName,
  timeoutMs = 65_000,
  perAttemptTimeoutMs = 45_000,
}: {
  apiKey: string;
  systemInstruction: string;
  prompt: string;
  responseSchema: Schema;
  thinkingDepth: "LOW" | "MEDIUM" | "HIGH";
  seed?: number;
  schemaName: string;
  timeoutMs?: number;
  perAttemptTimeoutMs?: number;
}): Promise<{ data: T; meta: GeminiGenerationMeta }> {
  const baseUrl = (
    process.env.NVIDIA_BASE_URL?.trim() || DEFAULT_NVIDIA_BASE_URL
  ).replace(/\/+$/, "");
  const model = process.env.NVIDIA_MODEL?.trim() || DEFAULT_NVIDIA_MODEL;
  const jsonSchema = toStandardJsonSchema(responseSchema);
  const enableThinking = thinkingDepth !== "LOW";
  const maxTokens =
    thinkingDepth === "HIGH" ? 16384 : thinkingDepth === "MEDIUM" ? 8192 : 2048;

  const fullSystem = [
    systemInstruction,
    "Return ONLY valid JSON conforming strictly to this JSON Schema (no markdown fences, no commentary):",
    JSON.stringify(jsonSchema),
  ].join("\n\n");

  const startedAt = Date.now();
  const backoffOpts = {
    maxAttempts: 4,
    totalTimeoutMs: timeoutMs,
    perAttemptTimeoutMs,
  };

  const invoke = async (
    useStrictJsonSchema: boolean,
    thinkingOverride = enableThinking,
    maxTokensOverride = maxTokens,
    signal?: AbortSignal,
  ) => {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: fullSystem },
        { role: "user", content: prompt },
      ],
      temperature: thinkingDepth === "LOW" ? 0.15 : 0.25,
      top_p: 0.95,
      max_tokens: maxTokensOverride,
      chat_template_kwargs: {
        enable_thinking: thinkingOverride,
      },
      response_format: useStrictJsonSchema
        ? {
            type: "json_schema",
            json_schema: {
              name: schemaName,
              strict: false,
              schema: jsonSchema,
            },
          }
        : { type: "json_object" },
      ...(typeof seed === "number" ? { seed } : {}),
    };

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw makeHttpError(
        `NVIDIA NIM error (${res.status}): ${errText.slice(0, 300)}`,
        res.status,
      );
    }

    return (await res.json()) as {
      model?: string;
      choices?: Array<{
        finish_reason?: string | null;
        message?: { content?: string | null; reasoning_content?: string | null };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
  };

  let payload: Awaited<ReturnType<typeof invoke>>;
  try {
    payload = await withBackoff(
      (signal) => invoke(true, enableThinking, maxTokens, signal),
      backoffOpts,
    );
  } catch (err) {
    const status = (err as { status?: number })?.status;
    // Some OpenAI-compatible NIM gateways reject complex json_schema forms with 400/422;
    // retry cleanly with json_object mode while keeping the schema in the system prompt.
    if (status === 400 || status === 422) {
      payload = await withBackoff(
        (signal) => invoke(false, enableThinking, maxTokens, signal),
        backoffOpts,
      );
    } else {
      throw err;
    }
  }

  let rawText = payload.choices?.[0]?.message?.content ?? "";
  let parsed: T;
  try {
    if (payload.choices?.[0]?.finish_reason === "length" && !rawText.trim()) {
      throw new Error("Model output truncated while reasoning.");
    }
    parsed = extractJsonObject<T>(rawText);
  } catch {
    // Reasoning models can exhaust max_tokens inside reasoning_content or produce
    // incomplete JSON under strict schema mode; retry once without thinking in json_object mode.
    const retryPayload = await withBackoff(
      (signal) => invoke(false, false, Math.max(maxTokens, 4096), signal),
      backoffOpts,
    );
    payload = retryPayload;
    rawText = retryPayload.choices?.[0]?.message?.content ?? "";
    parsed = extractJsonObject<T>(rawText);
  }

  const latencyMs = Math.max(1, Date.now() - startedAt);

  return {
    data: parsed,
    meta: {
      model: payload.model || model,
      provider: "nvidia",
      latencyMs,
      promptTokens: payload.usage?.prompt_tokens ?? null,
      completionTokens: payload.usage?.completion_tokens ?? null,
    },
  };
}

async function generateWithGeminiRest<T>({
  apiKey,
  systemInstruction,
  prompt,
  responseSchema,
  thinkingDepth,
  seed,
  timeoutMs = 65_000,
  perAttemptTimeoutMs = 25_000,
}: {
  apiKey: string;
  systemInstruction: string;
  prompt: string;
  responseSchema: Schema;
  thinkingDepth: "LOW" | "MEDIUM" | "HIGH";
  seed?: number;
  timeoutMs?: number;
  perAttemptTimeoutMs?: number;
}): Promise<{ data: T; meta: GeminiGenerationMeta }> {
  const primaryModel = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const startedAt = Date.now();

  const invokeGeminiModel = (modelName: string) => {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    return withBackoff(
      async (attemptSignal) => {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema,
              temperature: thinkingDepth === "LOW" ? 0.15 : 0.25,
              ...(typeof seed === "number" ? { seed } : {}),
            },
          }),
          signal: attemptSignal,
          cache: "no-store",
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw makeHttpError(
            `Gemini API error (${res.status}): ${errText.slice(0, 300)}`,
            res.status,
          );
        }

        return (await res.json()) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
          usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
          };
        };
      },
      {
        maxAttempts: 4,
        totalTimeoutMs: timeoutMs,
        perAttemptTimeoutMs,
      },
    );
  };

  let usedModel = primaryModel;
  let payload;
  try {
    payload = await invokeGeminiModel(primaryModel);
  } catch (err) {
    if (isDailyQuotaExhausted(err) && primaryModel !== AGENT_GEMINI_FALLBACK_MODEL) {
      usedModel = AGENT_GEMINI_FALLBACK_MODEL;
      payload = await invokeGeminiModel(AGENT_GEMINI_FALLBACK_MODEL);
    } else {
      throw err;
    }
  }

  const latencyMs = Math.max(1, Date.now() - startedAt);
  const rawText =
    payload.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("") ?? "";
  const parsed = extractJsonObject<T>(rawText);

  return {
    data: parsed,
    meta: {
      model: usedModel,
      provider: "gemini",
      latencyMs,
      promptTokens: payload.usageMetadata?.promptTokenCount ?? null,
      completionTokens: payload.usageMetadata?.candidatesTokenCount ?? null,
    },
  };
}

export async function generateAgentJson<T>({
  systemInstruction,
  prompt,
  responseSchema,
  thinkingDepth = "LOW",
  seed,
  schemaName = "agent_response",
  timeoutMs = 65_000,
  perAttemptTimeoutMs,
}: {
  systemInstruction: string;
  prompt: string;
  responseSchema: Schema;
  thinkingDepth?: "LOW" | "MEDIUM" | "HIGH";
  seed?: number;
  schemaName?: string;
  timeoutMs?: number;
  perAttemptTimeoutMs?: number;
}): Promise<{ data: T; meta: GeminiGenerationMeta }> {
  const provider = getActiveAiProvider();
  if (!provider) {
    throw new MissingGeminiKeyError();
  }

  const nvidiaKey = getServerNvidiaKey();
  const geminiKey = getRawGeminiKey();

  if (provider === "nvidia" && nvidiaKey) {
    try {
      return await generateWithNvidia<T>({
        apiKey: nvidiaKey,
        systemInstruction,
        prompt,
        responseSchema,
        thinkingDepth,
        seed,
        schemaName,
        timeoutMs,
        perAttemptTimeoutMs: perAttemptTimeoutMs ?? 45_000,
      });
    } catch (err) {
      if (geminiKey) {
        console.warn(
          "[Agents] NVIDIA NIM failed; failing over to Gemini:",
          err instanceof Error ? err.message : err,
        );
        return generateWithGeminiRest<T>({
          apiKey: geminiKey,
          systemInstruction,
          prompt,
          responseSchema,
          thinkingDepth,
          seed,
          timeoutMs,
          perAttemptTimeoutMs: perAttemptTimeoutMs ?? 25_000,
        });
      }
      throw err;
    }
  }

  if (geminiKey) {
    try {
      return await generateWithGeminiRest<T>({
        apiKey: geminiKey,
        systemInstruction,
        prompt,
        responseSchema,
        thinkingDepth,
        seed,
        timeoutMs,
        perAttemptTimeoutMs: perAttemptTimeoutMs ?? 25_000,
      });
    } catch (err) {
      if (nvidiaKey) {
        console.warn(
          "[Agents] Gemini failed; failing over to NVIDIA NIM:",
          err instanceof Error ? err.message : err,
        );
        return generateWithNvidia<T>({
          apiKey: nvidiaKey,
          systemInstruction,
          prompt,
          responseSchema,
          thinkingDepth,
          seed,
          schemaName,
          timeoutMs,
          perAttemptTimeoutMs: perAttemptTimeoutMs ?? 45_000,
        });
      }
      throw err;
    }
  }

  throw new MissingGeminiKeyError();
}

export async function generateCorridorText({
  prompt,
  lat,
  lng,
}: {
  prompt: string;
  lat?: number;
  lng?: number;
}): Promise<{
  text: string;
  candidates?: Array<{
    groundingMetadata?: {
      groundingChunks?: Array<{
        maps?: {
          uri?: string;
          title?: string;
          placeAnswerSources?: { reviewSnippets?: Array<{ content?: string }> };
        };
      }>;
    };
  }>;
  provider: AiProvider;
  model: string;
}> {
  const geminiKey = getRawGeminiKey();
  const nvidiaKey = getServerNvidiaKey();
  const hasCoords =
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng);

  // Maps grounding tool is Gemini-specific when GEMINI_API_KEY is available.
  if (geminiKey) {
    const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ googleMaps: {} }],
        ...(hasCoords
          ? {
              toolConfig: {
                retrievalConfig: {
                  latLng: { latitude: lat, longitude: lng },
                },
              },
            }
          : {}),
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw makeHttpError(
        `Gemini Maps Grounding error (${res.status}): ${errText.slice(0, 300)}`,
        res.status,
      );
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        groundingMetadata?: {
          groundingChunks?: Array<{
            maps?: {
              uri?: string;
              title?: string;
              placeAnswerSources?: {
                reviewSnippets?: Array<{ content?: string }>;
              };
            };
          }>;
        };
      }>;
    };
    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("")
        .trim() || "No corridor details were returned for this query.";
    return { text, candidates: data.candidates, provider: "gemini", model };
  }

  if (nvidiaKey) {
    const baseUrl = (
      process.env.NVIDIA_BASE_URL?.trim() || DEFAULT_NVIDIA_BASE_URL
    ).replace(/\/+$/, "");
    const model = process.env.NVIDIA_MODEL?.trim() || DEFAULT_NVIDIA_MODEL;
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${nvidiaKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a freight corridor and logistics operations analyst. Provide concise, practical routing, customs, port/airport access, fuel/staging, and transit risk guidance in markdown.",
          },
          {
            role: "user",
            content: hasCoords
              ? `${prompt}\nReference coordinates: ${lat}, ${lng}`
              : prompt,
          },
        ],
        temperature: 0.25,
        max_tokens: 1024,
        chat_template_kwargs: { enable_thinking: false },
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw makeHttpError(
        `NVIDIA NIM error (${res.status}): ${errText.slice(0, 300)}`,
        res.status,
      );
    }

    const data = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const text =
      raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() ||
      "No corridor details were returned for this query.";
    return { text, candidates: [], provider: "nvidia", model: data.model || model };
  }

  throw new MissingGeminiKeyError();
}
