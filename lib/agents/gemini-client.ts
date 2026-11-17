import { GoogleGenAI, ThinkingLevel, type Schema } from "@google/genai";

export const AGENT_GEMINI_MODEL = "gemini-4-hydrogen";

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

function isTransientError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /ECONNRESET|ETIMEDOUT|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded/i.test(msg);
}

async function withBackoff<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt + 1 >= maxAttempts || !isTransientError(err)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
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
}: {
  systemInstruction: string;
  prompt: string;
  responseSchema: Schema;
  thinkingDepth?: "LOW" | "MEDIUM" | "HIGH";
  seed?: number;
}): Promise<{ data: T; meta: GeminiGenerationMeta }> {
  const ai = getGeminiClient();
  const startedAt = Date.now();

  const response = await withBackoff(() =>
    ai.models.generateContent({
      model: AGENT_GEMINI_MODEL,
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema,
        thinkingConfig: {
          thinkingLevel: mapThinkingLevel(thinkingDepth),
        },
        ...(typeof seed === "number" ? { seed } : {}),
      },
    }),
  );

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
      model: AGENT_GEMINI_MODEL,
      latencyMs,
      promptTokens: response.usageMetadata?.promptTokenCount ?? null,
      completionTokens: response.usageMetadata?.candidatesTokenCount ?? null,
    },
  };
}
