export const LIVE_INPUT_SAMPLE_RATE = 16_000;
export const LIVE_OUTPUT_SAMPLE_RATE = 24_000;

export const LIVE_VOICES = [
  { id: "Zephyr", label: "Zephyr", tone: "Bright & clear" },
  { id: "Puck", label: "Puck", tone: "Upbeat & responsive" },
  { id: "Charon", label: "Charon", tone: "Calm & informative" },
  { id: "Kore", label: "Kore", tone: "Firm & concise" },
  { id: "Fenrir", label: "Fenrir", tone: "Direct & energetic" },
] as const;

export type LiveVoiceName = (typeof LIVE_VOICES)[number]["id"];

const VALID_VOICE_SET = new Set<string>(LIVE_VOICES.map((v) => v.id));

export function normalizeLiveVoice(voice?: string | null): LiveVoiceName {
  if (voice && VALID_VOICE_SET.has(voice)) {
    return voice as LiveVoiceName;
  }
  return "Zephyr";
}

/**
 * Linearly resamples mono Float32 PCM audio from `sourceRate` to `targetRate`.
 */
export function resampleFloat32(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (input.length === 0 || sourceRate <= 0 || targetRate <= 0) {
    return new Float32Array(0);
  }
  if (sourceRate === targetRate) {
    return input;
  }
  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, input.length - 1);
    const frac = srcPos - idx0;
    output[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
  }
  return output;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(base64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encodes Float32 PCM audio (-1..1) into raw 16-bit little-endian PCM base64
 * at 16 kHz for Gemini Live API (`audio/pcm;rate=16000`).
 */
export function float32ToPcm16Base64(
  samples: Float32Array,
  sourceSampleRate = LIVE_INPUT_SAMPLE_RATE,
): string {
  const resampled = resampleFloat32(samples, sourceSampleRate, LIVE_INPUT_SAMPLE_RATE);
  const buffer = new ArrayBuffer(resampled.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < resampled.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, resampled[i]));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(i * 2, int16, true);
  }
  return bytesToBase64(new Uint8Array(buffer));
}

/**
 * Decodes raw 16-bit little-endian PCM base64 from Gemini Live API (24 kHz)
 * into mono Float32 samples suitable for Web Audio API playback.
 */
export function pcm16Base64ToFloat32(base64: string): Float32Array {
  if (!base64) return new Float32Array(0);
  const bytes = base64ToBytes(base64);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const output = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    output[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return output;
}

/**
 * Computes a smooth normalized 0..1 audio energy meter from Float32 PCM samples.
 */
export function computeAudioLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sumSquares += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return Math.max(0, Math.min(1, rms * 3.5));
}

export type LiveServerPacket =
  | { type: "ready"; voice: LiveVoiceName; model: string; orgName: string }
  | { type: "audio"; audio: string }
  | { type: "inputTranscript"; text: string }
  | { type: "outputTranscript"; text: string }
  | { type: "interrupted" }
  | { type: "turnComplete" }
  | { type: "error"; message: string };

/**
 * Returns progressive `getUserMedia` audio constraint candidates so mobile
 * browsers / Bluetooth headsets with strict channel rules fall back cleanly.
 */
export function getAudioConstraintCandidates(): MediaStreamConstraints[] {
  return [
    {
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    },
    {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    },
    { audio: true },
  ];
}

export function isOverconstrainedMediaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String((err as { name?: unknown }).name ?? "") : "";
  return (
    name === "OverconstrainedError" ||
    name === "ConstraintNotSatisfiedError" ||
    name === "NotFoundError"
  );
}

/**
 * Maps browser microphone errors and mobile context limits to clear operator guidance.
 */
export function classifyVoiceMediaError(
  err: unknown,
  options?: { isSecureContext?: boolean; hasMediaDevices?: boolean },
): string {
  if (options?.isSecureContext === false) {
    return "Microphone capture requires a secure HTTPS connection on mobile browsers. Switch to Text mode or open over HTTPS.";
  }
  if (options?.hasMediaDevices === false) {
    return "This mobile browser or in-app view does not expose microphone access. Use Text mode to converse with audio replies.";
  }
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name?: unknown }).name ?? "")
      : "";

  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "Microphone permission was blocked. Enable microphone access in your browser settings, or use Text mode.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found on this device. Switch to Text mode to continue with live audio replies.";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "Microphone is busy in another app or phone call. Close the other audio app or switch to Text mode.";
  }
  return "Microphone access was unavailable on this device. Allow microphone permissions or switch to Text mode.";
}

