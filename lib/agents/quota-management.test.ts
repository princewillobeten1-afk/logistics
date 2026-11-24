import assert from "node:assert/strict";
import test from "node:test";
import { classifyGeminiError } from "./catalog";
import {
  isDailyQuotaExhausted,
  isRateLimitError,
  isTransientError,
  parseRetryDelayMs,
  withBackoff,
} from "./gemini-client";
import { isQuotaErrorMessage } from "../maps-grounding";

test("parseRetryDelayMs extracts retry hints from both prose and JSON RetryInfo errors", () => {
  assert.equal(parseRetryDelayMs(new Error("Please retry in 12.4s.")), 12400);
  assert.equal(parseRetryDelayMs(new Error('{"retryDelay":"45s"}')), 45000);
  assert.equal(parseRetryDelayMs(new Error('{"retryDelay":"43232.1s"}')), 43232100);
  assert.equal(parseRetryDelayMs(new Error("retry in 0s")), null);
  assert.equal(parseRetryDelayMs(new Error("Generic upstream error")), null);
});

test("isDailyQuotaExhausted distinguishes daily RPD limits from short per-minute RPM bursts", () => {
  assert.equal(
    isDailyQuotaExhausted(
      new Error("Generate content requests per day limit exceeded on Free Tier."),
    ),
    true,
  );
  assert.equal(
    isDailyQuotaExhausted(new Error("Quota metric GenerateRequestsPerDayPerProject exceeded")),
    true,
  );
  assert.equal(
    isDailyQuotaExhausted(new Error('429 RESOURCE_EXHAUSTED {"retryDelay":"43200s"}')),
    true,
  );

  // Short 15-second per-minute burst is NOT daily quota exhaustion
  assert.equal(
    isDailyQuotaExhausted(
      Object.assign(new Error('429 RESOURCE_EXHAUSTED {"retryDelay":"15s"}'), { status: 429 }),
    ),
    false,
  );
});

test("isRateLimitError and isTransientError classify retryable vs fail-fast failures accurately", () => {
  const rpm429 = Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429 });
  assert.equal(isRateLimitError(rpm429), true);
  assert.equal(isTransientError(rpm429), true);

  // Daily quota exhaustion must NOT be treated as transient so callers fail fast to fallback
  const rpd429 = Object.assign(
    new Error("Generate content requests per day limit exceeded on Free Tier"),
    { status: 429 },
  );
  assert.equal(isRateLimitError(rpd429), true);
  assert.equal(isTransientError(rpd429), false);

  // 503, timeouts, and network resets are transient
  assert.equal(isTransientError(Object.assign(new Error("Service unavailable"), { status: 503 })), true);
  assert.equal(isTransientError(Object.assign(new Error("Aborted"), { name: "TimeoutError" })), true);
  assert.equal(isTransientError(new Error("fetch failed: ECONNRESET")), true);

  // 400, 401, 403, 404 are non-transient client/auth errors
  assert.equal(isTransientError(Object.assign(new Error("INVALID_ARGUMENT"), { status: 400 })), false);
  assert.equal(isTransientError(Object.assign(new Error("API_KEY_INVALID"), { status: 401 })), false);
  assert.equal(isTransientError(Object.assign(new Error("PERMISSION_DENIED"), { status: 403 })), false);
  assert.equal(isTransientError(Object.assign(new Error("NOT_FOUND"), { status: 404 })), false);
});

test("withBackoff recovers after transient 503 and 429 RPM errors using fresh AbortSignals", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const signals: AbortSignal[] = [];

  const result = await withBackoff(
    async (signal) => {
      attempts += 1;
      signals.push(signal);
      if (attempts === 1) {
        throw Object.assign(new Error("503 UNAVAILABLE"), { status: 503 });
      }
      if (attempts === 2) {
        throw Object.assign(new Error('429 RESOURCE_EXHAUSTED {"retryDelay":"4s"}'), { status: 429 });
      }
      return "recovered";
    },
    {
      maxAttempts: 4,
      totalTimeoutMs: 65_000,
      perAttemptTimeoutMs: 25_000,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    },
  );

  assert.equal(result, "recovered");
  assert.equal(attempts, 3);
  assert.equal(delays.length, 2);
  // First delay is 503 backoff (~1200..1600ms), second honors 4s retryDelay hint (~4000..4500ms)
  assert.ok(delays[0] >= 1200 && delays[0] <= 1700, `Unexpected 503 delay: ${delays[0]}`);
  assert.ok(delays[1] >= 4000 && delays[1] <= 4600, `Unexpected 429 hinted delay: ${delays[1]}`);
  // Every attempt receives a distinct AbortSignal instance
  assert.notEqual(signals[0], signals[1]);
  assert.notEqual(signals[1], signals[2]);
});

test("withBackoff fails fast without retrying on daily quota exhaustion, auth errors, or oversized retryDelay", async () => {
  const sleepCalls: number[] = [];
  const sleepFn = async (ms: number) => {
    sleepCalls.push(ms);
  };

  // Daily quota exhaustion -> 1 attempt, 0 sleeps
  let dailyAttempts = 0;
  await assert.rejects(
    withBackoff(
      async () => {
        dailyAttempts += 1;
        throw Object.assign(new Error("requests per day limit exceeded"), { status: 429 });
      },
      { maxAttempts: 4, totalTimeoutMs: 65_000, sleepFn },
    ),
  );
  assert.equal(dailyAttempts, 1);
  assert.equal(sleepCalls.length, 0);

  // Oversized retryDelay exceeding remaining timeout budget -> 1 attempt, 0 sleeps
  let oversizedAttempts = 0;
  await assert.rejects(
    withBackoff(
      async () => {
        oversizedAttempts += 1;
        throw Object.assign(new Error('429 RESOURCE_EXHAUSTED {"retryDelay":"50s"}'), { status: 429 });
      },
      { maxAttempts: 4, totalTimeoutMs: 20_000, sleepFn },
    ),
  );
  assert.equal(oversizedAttempts, 1);
  assert.equal(sleepCalls.length, 0);

  // Non-transient 403 -> 1 attempt, 0 sleeps
  let authAttempts = 0;
  await assert.rejects(
    withBackoff(
      async () => {
        authAttempts += 1;
        throw Object.assign(new Error("PERMISSION_DENIED"), { status: 403 });
      },
      { maxAttempts: 4, totalTimeoutMs: 65_000, sleepFn },
    ),
  );
  assert.equal(authAttempts, 1);
  assert.equal(sleepCalls.length, 0);
});

test("classifyGeminiError maps all error categories cleanly and redacts sensitive keys/URLs", () => {
  const quota = classifyGeminiError(Object.assign(new Error("429 RESOURCE_EXHAUSTED"), { status: 429 }));
  assert.equal(quota.status, 429);
  assert.equal(quota.quotaExceeded, true);

  const timeout = classifyGeminiError(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }));
  assert.equal(timeout.status, 504);
  assert.equal(timeout.quotaExceeded, false);

  const unavailable = classifyGeminiError(Object.assign(new Error("503 UNAVAILABLE"), { status: 503 }));
  assert.equal(unavailable.status, 503);

  const badJson = classifyGeminiError(new Error("Gemini returned non-JSON structured output."));
  assert.equal(badJson.status, 502);

  const leaky = classifyGeminiError(
    new Error("Unexpected crash for AIzaSySecretTestKey123456 at https://internal.example.com/secret"),
  );
  assert.equal(leaky.status, 502);
  assert.equal(leaky.message.includes("AIzaSySecretTestKey123456"), false);
  assert.equal(leaky.message.includes("https://internal.example.com"), false);
  assert.ok(leaky.message.includes("[REDACTED]"));
});

test("isQuotaErrorMessage detects Maps quota and billing failures without false positives", () => {
  assert.equal(isQuotaErrorMessage("Google Maps JavaScript API error: OverQuotaMapError"), true);
  assert.equal(isQuotaErrorMessage("OVER_QUERY_LIMIT reached for project"), true);
  assert.equal(isQuotaErrorMessage("BillingNotEnabledMapError"), true);
  assert.equal(isQuotaErrorMessage("Shipment LG-79177 arrived at Abuja warehouse"), false);
  assert.equal(isQuotaErrorMessage("Carrier quote submitted for Lagos corridor"), false);
});
