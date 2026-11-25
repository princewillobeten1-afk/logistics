import assert from "node:assert/strict";
import test from "node:test";
import {
  extractBotTokenFromStored,
  sealTelegramCredentials,
  verifyTelegramBotToken,
} from "./telegram";

test("sealTelegramCredentials and extractBotTokenFromStored round-trip bot tokens cleanly", () => {
  const sampleToken = "123456789:AAExampleTelegramBotToken_1234567890";
  const sealed = sealTelegramCredentials(sampleToken);
  assert.notEqual(sealed, sampleToken);

  const extracted = extractBotTokenFromStored(Buffer.from(sealed, "utf8"), {});
  assert.equal(extracted, sampleToken);

  const fromLegacyConfig = extractBotTokenFromStored(null, { bot_token: sampleToken });
  assert.equal(fromLegacyConfig, sampleToken);
});

test("verifyTelegramBotToken rejects malformed tokens locally before making network calls", async () => {
  const bad = await verifyTelegramBotToken("not-a-valid-token");
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.error, /Invalid bot token format/i);
  }
});
