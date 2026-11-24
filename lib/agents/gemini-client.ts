import { GoogleGenAI, ThinkingLevel, type Schema } from "@google/genai";

export const AGENT_GEMINI_MODEL = "gemini-4-hydrogen";
export const AGENT_GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-lite";

export interface GeminiGenerationMeta {
  model: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
}

export class MissingGeminiKeyError extends Error {
  readonly status = 503;
  constructor() {
    super("GEMINI_API_KEY is not configured on the server.");
    this.name = "MissingGeminiKeyError";
  }
}

export function getServerGeminiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function getGeminiClient(): GoogleGenAI {
  const apiKey = getServerGeminiKey();
  if (!apiKey) {
    throw new MissingGeminiKeyError();
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function mapThinkingLevel(depth: "LOW" | "MEDIUM" | "HIGH"): ThinkingLevel {
  if (depth === "LOW") return ThinkingLevel.LOW;
  if (depth === "HIGH") return ThinkingLevel.HIGH;
  return ThinkingLevel.MEDIUM;
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
  if (/PerDay|GenerateRequestsPerDay|requests?\s+per\s+day|daily.*(quota|limit)/i.test(msg)) {
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
  if (status === 500 || status === 502 || status === 503 || status === 504) {
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
    sleepFn = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
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
      throw lastErr ?? new Error("Gemini request timed out.");
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
          ? Math.min(14_000, 3_000 * 2 ** attempt) + Math.floor(Math.random() * 600)
          : Math.min(6_000, 1_200 * 2 ** attempt) + Math.floor(Math.random() * 400);
      const boundedDelay = Math.min(rawDelay, Math.max(500, timeLeftAfterErr - 5_000));
      await sleepFn(boundedDelay);
    }
  }
  throw lastErr;
}

export async function generateAgentJson<T>({
  systemInstruction,
  prompt,
  responseSchema,
  thinkingDepth = "LOW",
  seed,
  timeoutMs = 65_000,
  perAttemptTimeoutMs = 25_000,
}: {
  systemInstruction: string;
  prompt: string;
  responseSchema: Schema;
  thinkingDepth?: "LOW" | "MEDIUM" | "HIGH";
  seed?: number;
  timeoutMs?: number;
  perAttemptTimeoutMs?: number;
}): Promise<{ data: T; meta: GeminiGenerationMeta }> {
  const ai = getGeminiClient();
  const startedAt = Date.now();

  const invokeModel = (modelName: string) =>
    withBackoff(
      (attemptSignal) =>
        ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            abortSignal: attemptSignal,
            systemInstruction,
            responseMimeType: "application/json",
            responseSchema,
            thinkingConfig: {
              thinkingLevel: mapThinkingLevel(thinkingDepth),
            },
            ...(typeof seed === "number" ? { seed } : {}),
          },
        }),
      {
        maxAttempts: 4,
        totalTimeoutMs: timeoutMs,
        perAttemptTimeoutMs,
      },
    );

  let usedModel = AGENT_GEMINI_MODEL;
  let response;
  try {
    response = await invokeModel(AGENT_GEMINI_MODEL);
  } catch (err) {
    if (isDailyQuotaExhausted(err)) {
      usedModel = AGENT_GEMINI_FALLBACK_MODEL;
      response = await invokeModel(AGENT_GEMINI_FALLBACK_MODEL);
    } else {
      throw err;
    }
  }

  const latencyMs = Math.max(1, Date.now() - startedAt);
  const rawText = (response.text ?? "{}").trim();

  let parsed: T;
  try {
    parsed = JSON.parse(rawText) as T;
  } catch {
    const startIdx = rawText.indexOf("{");
    const endIdx = rawText.lastIndexOf("}");
    if (startIdx >= 0 && endIdx > startIdx) {
      parsed = JSON.parse(rawText.slice(startIdx, endIdx + 1)) as T;
    } else {
      throw new Error("Gemini returned non-JSON structured output.");
    }
  }

  return {
    data: parsed,
    meta: {
      model: usedModel,
      latencyMs,
      promptTokens: response.usageMetadata?.promptTokenCount ?? null,
      completionTokens: response.usageMetadata?.candidatesTokenCount ?? null,
    },
  };
}
