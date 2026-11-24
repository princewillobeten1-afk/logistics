import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_INPUT_SAMPLE_RATE,
  LIVE_OUTPUT_SAMPLE_RATE,
  computeAudioLevel,
  float32ToPcm16Base64,
  normalizeLiveVoice,
  pcm16Base64ToFloat32,
  resampleFloat32,
} from "./live-audio";

test("live audio constants match Gemini Live API 16kHz input and 24kHz output requirements", () => {
  assert.equal(LIVE_INPUT_SAMPLE_RATE, 16_000);
  assert.equal(LIVE_OUTPUT_SAMPLE_RATE, 24_000);
});

test("normalizeLiveVoice allows valid prebuilt voices and falls back safely to Zephyr", () => {
  assert.equal(normalizeLiveVoice("Zephyr"), "Zephyr");
  assert.equal(normalizeLiveVoice("Puck"), "Puck");
  assert.equal(normalizeLiveVoice("Kore"), "Kore");
  assert.equal(normalizeLiveVoice("UnknownVoice"), "Zephyr");
  assert.equal(normalizeLiveVoice(null), "Zephyr");
});

test("float32ToPcm16Base64 and pcm16Base64ToFloat32 round-trip samples accurately with clamping", () => {
  const input = new Float32Array([-1.5, -1, -0.5, 0, 0.5, 1, 1.8]);
  const encoded = float32ToPcm16Base64(input, LIVE_INPUT_SAMPLE_RATE);
  const decoded = pcm16Base64ToFloat32(encoded);

  assert.equal(decoded.length, input.length);
  assert.ok(Math.abs(decoded[0] - -1) < 0.001);
  assert.ok(Math.abs(decoded[1] - -1) < 0.001);
  assert.ok(Math.abs(decoded[2] - -0.5) < 0.001);
  assert.ok(Math.abs(decoded[3] - 0) < 0.001);
  assert.ok(Math.abs(decoded[4] - 0.5) < 0.001);
  assert.ok(Math.abs(decoded[5] - 1) < 0.001);
  assert.ok(Math.abs(decoded[6] - 1) < 0.001);
});

test("resampleFloat32 downsamples 48kHz microphone capture cleanly to 16kHz", () => {
  const src = new Float32Array(480);
  for (let i = 0; i < src.length; i += 1) {
    src[i] = Math.sin((2 * Math.PI * i) / 48);
  }
  const down = resampleFloat32(src, 48_000, 16_000);
  assert.equal(down.length, 160);
  assert.equal(resampleFloat32(new Float32Array(0), 48_000, 16_000).length, 0);
});

test("computeAudioLevel returns 0 for silence and bounded 0..1 energy for speech", () => {
  assert.equal(computeAudioLevel(new Float32Array(0)), 0);
  assert.equal(computeAudioLevel(new Float32Array([0, 0, 0, 0])), 0);
  const loud = computeAudioLevel(new Float32Array([0.8, -0.8, 0.8, -0.8]));
  assert.equal(loud, 1);
  const moderate = computeAudioLevel(new Float32Array([0.1, -0.1, 0.1, -0.1]));
  assert.ok(moderate > 0.2 && moderate < 0.5);
});
