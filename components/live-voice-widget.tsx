"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  AudioLines,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  Send,
  Volume2,
  X,
} from "lucide-react";
import {
  LIVE_INPUT_SAMPLE_RATE,
  LIVE_OUTPUT_SAMPLE_RATE,
  LIVE_VOICES,
  classifyVoiceMediaError,
  computeAudioLevel,
  float32ToPcm16Base64,
  getAudioConstraintCandidates,
  isOverconstrainedMediaError,
  pcm16Base64ToFloat32,
  type LiveServerPacket,
  type LiveVoiceName,
} from "@/lib/live-audio";

type SessionStatus = "idle" | "connecting" | "live" | "error";
type SessionMode = "voice" | "text";

interface VoiceTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

const WAVE_BARS = [0.42, 0.78, 1.0, 0.88, 0.56, 0.94, 0.68, 0.45];

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const win = window as Window & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return win.AudioContext || win.webkitAudioContext || null;
}

function createCompatibleAudioContext(preferredSampleRate?: number): AudioContext {
  const Ctor = getAudioContextConstructor();
  if (!Ctor) {
    throw new Error("Web Audio API is unavailable in this browser.");
  }
  if (preferredSampleRate) {
    try {
      return new Ctor({ sampleRate: preferredSampleRate });
    } catch {
      // Mobile Safari / some Android WebViews reject non-hardware sample rates
      return new Ctor();
    }
  }
  return new Ctor();
}

function unlockOutputAudioContext(ctx: AudioContext): void {
  try {
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    // Playing a 1-sample silent buffer inside the tap handler satisfies iOS Safari playback locks
    const silentBuffer = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
    const silentSource = ctx.createBufferSource();
    silentSource.buffer = silentBuffer;
    silentSource.connect(ctx.destination);
    silentSource.start(0);
  } catch {
    // Best-effort gesture unlock
  }
}

async function requestMicrophoneStream(): Promise<MediaStream> {
  const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
    throw new Error("MEDIA_DEVICES_UNAVAILABLE");
  }

  const candidates = getAudioConstraintCandidates();
  let lastError: unknown;
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      return await mediaDevices.getUserMedia(candidates[i]);
    } catch (err) {
      lastError = err;
      const hasNext = i < candidates.length - 1;
      if (!hasNext || !isOverconstrainedMediaError(err)) {
        throw err;
      }
    }
  }
  throw lastError;
}

export function LiveVoiceWidget() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [sessionMode, setSessionMode] = useState<SessionMode>("voice");
  const [voice, setVoice] = useState<LiveVoiceName>("Zephyr");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTextFallback, setShowTextFallback] = useState(false);
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [textInput, setTextInput] = useState("");
  const [inputLevel, setInputLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Refs for callbacks (onaudioprocess / ws.onmessage) to avoid stale closures
  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const mutedRef = useRef(false);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia("(max-width: 720px)");
    const syncViewport = () => setIsMobile(mq.matches);
    syncViewport();
    mq.addEventListener("change", syncViewport);
    return () => mq.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns, open]);

  // Mobile Safari can suspend AudioContexts after backgrounding/locking screen
  useEffect(() => {
    if (status !== "live") return;
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (outputCtxRef.current?.state === "suspended") {
        void outputCtxRef.current.resume().catch(() => {});
      }
      if (inputCtxRef.current?.state === "suspended") {
        void inputCtxRef.current.resume().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [status]);

  const stopPlaybackQueue = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Source already ended
      }
    }
    activeSourcesRef.current.clear();
    if (outputCtxRef.current) {
      nextStartTimeRef.current = outputCtxRef.current.currentTime;
    } else {
      nextStartTimeRef.current = 0;
    }
    setIsSpeaking(false);
    setOutputLevel(0);
  }, []);

  const teardownSession = useCallback(
    (nextStatus: SessionStatus = "idle") => {
      stopPlaybackQueue();

      if (processorRef.current) {
        processorRef.current.onaudioprocess = null;
        try {
          processorRef.current.disconnect();
        } catch {
          // Ignore
        }
        processorRef.current = null;
      }

      if (silentGainRef.current) {
        try {
          silentGainRef.current.disconnect();
        } catch {
          // Ignore
        }
        silentGainRef.current = null;
      }

      if (sourceRef.current) {
        try {
          sourceRef.current.disconnect();
        } catch {
          // Ignore
        }
        sourceRef.current = null;
      }

      if (mediaStreamRef.current) {
        for (const track of mediaStreamRef.current.getTracks()) {
          track.stop();
        }
        mediaStreamRef.current = null;
      }

      if (inputCtxRef.current) {
        void inputCtxRef.current.close().catch(() => {});
        inputCtxRef.current = null;
      }

      if (outputCtxRef.current) {
        void outputCtxRef.current.close().catch(() => {});
        outputCtxRef.current = null;
      }

      if (wsRef.current) {
        const ws = wsRef.current;
        wsRef.current = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, "User ended voice session");
        }
      }

      setInputLevel(0);
      setOutputLevel(0);
      setIsSpeaking(false);
      setStatus(nextStatus);
    },
    [stopPlaybackQueue],
  );

  useEffect(() => {
    return () => {
      teardownSession("idle");
    };
  }, [teardownSession]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const appendTranscript = useCallback((role: "user" | "assistant", chunk: string) => {
    const clean = chunk;
    if (!clean.trim()) return;
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role) {
        const needsSpace =
          last.text.length > 0 &&
          !last.text.endsWith(" ") &&
          !clean.startsWith(" ") &&
          !/^[.,!?;:'")]/.test(clean);
        const updated: VoiceTurn = {
          ...last,
          text: `${last.text}${needsSpace ? " " : ""}${clean}`,
        };
        return [...prev.slice(0, -1), updated];
      }
      return [
        ...prev.slice(-24),
        {
          id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role,
          text: clean.trimStart(),
        },
      ];
    });
  }, []);

  const schedulePcmPlayback = useCallback((base64Audio: string) => {
    const ctx = outputCtxRef.current;
    if (!ctx) return;

    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }

    const samples = pcm16Base64ToFloat32(base64Audio);
    if (samples.length === 0) return;

    setOutputLevel(computeAudioLevel(samples));
    setIsSpeaking(true);

    const buffer = ctx.createBuffer(1, samples.length, LIVE_OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.015, nextStartTimeRef.current);
    node.start(startAt);
    nextStartTimeRef.current = startAt + buffer.duration;

    activeSourcesRef.current.add(node);
    node.onended = () => {
      activeSourcesRef.current.delete(node);
      if (activeSourcesRef.current.size === 0) {
        setIsSpeaking(false);
        setOutputLevel(0);
      }
    };
  }, []);

  const startVoiceSession = useCallback(
    async (mode: SessionMode = "voice") => {
      if (status === "connecting" || status === "live") return;
      setError(null);
      setShowTextFallback(false);
      setSessionMode(mode);
      setMuted(false);
      setStatus("connecting");

      // Synchronously create & unlock AudioContexts inside the tap gesture before any `await`
      // so iOS Safari and mobile Chrome permit audio playback and mic capture.
      let inputCtx: AudioContext | null = null;
      let outputCtx: AudioContext | null = null;
      try {
        outputCtx = createCompatibleAudioContext(LIVE_OUTPUT_SAMPLE_RATE);
        unlockOutputAudioContext(outputCtx);
        if (mode === "voice") {
          inputCtx = createCompatibleAudioContext(LIVE_INPUT_SAMPLE_RATE);
          if (inputCtx.state === "suspended") {
            void inputCtx.resume().catch(() => {});
          }
        }
      } catch {
        if (inputCtx) void inputCtx.close().catch(() => {});
        if (outputCtx) void outputCtx.close().catch(() => {});
        setError("Web Audio playback is unavailable in this browser.");
        setStatus("error");
        return;
      }

      let stream: MediaStream | null = null;
      if (mode === "voice") {
        try {
          stream = await requestMicrophoneStream();
        } catch (err) {
          void inputCtx?.close().catch(() => {});
          void outputCtx.close().catch(() => {});
          const hasMediaDevices = Boolean(
            typeof navigator !== "undefined" &&
              navigator.mediaDevices &&
              typeof navigator.mediaDevices.getUserMedia === "function",
          );
          const isSecure = typeof window !== "undefined" ? window.isSecureContext : true;
          setError(
            classifyVoiceMediaError(err, {
              isSecureContext: isSecure,
              hasMediaDevices,
            }),
          );
          setShowTextFallback(true);
          setStatus("error");
          return;
        }
      }

      try {
        await Promise.all([
          outputCtx.resume().catch(() => {}),
          inputCtx ? inputCtx.resume().catch(() => {}) : Promise.resolve(),
        ]);

        mediaStreamRef.current = stream;
        inputCtxRef.current = inputCtx;
        outputCtxRef.current = outputCtx;
        nextStartTimeRef.current = outputCtx.currentTime;

        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${proto}//${window.location.host}/api/live?voice=${encodeURIComponent(voice)}`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          if (mode === "voice" && stream && inputCtx) {
            if (inputCtx.state === "suspended") {
              void inputCtx.resume().catch(() => {});
            }
            const micSource = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            sourceRef.current = micSource;
            processorRef.current = processor;

            processor.onaudioprocess = (event) => {
              const currentWs = wsRef.current;
              if (!currentWs || currentWs.readyState !== WebSocket.OPEN) return;
              if (mutedRef.current) {
                setInputLevel(0);
                return;
              }
              const channelData = event.inputBuffer.getChannelData(0);
              setInputLevel(computeAudioLevel(channelData));
              const pcmBase64 = float32ToPcm16Base64(channelData, inputCtx.sampleRate);
              currentWs.send(JSON.stringify({ type: "audio", audio: pcmBase64 }));
            };

            micSource.connect(processor);
            // Connect to a silent gain node so onaudioprocess fires without mic feedback echo
            const silentGain = inputCtx.createGain();
            silentGain.gain.value = 0;
            silentGainRef.current = silentGain;
            processor.connect(silentGain);
            silentGain.connect(inputCtx.destination);
          }
        };

        ws.onmessage = (event) => {
          let packet: LiveServerPacket;
          try {
            packet = JSON.parse(String(event.data)) as LiveServerPacket;
          } catch {
            return;
          }

          if (packet.type === "ready") {
            setStatus("live");
            setError(null);
            setShowTextFallback(false);
          } else if (packet.type === "audio") {
            schedulePcmPlayback(packet.audio);
          } else if (packet.type === "inputTranscript") {
            appendTranscript("user", packet.text);
          } else if (packet.type === "outputTranscript") {
            appendTranscript("assistant", packet.text);
          } else if (packet.type === "interrupted") {
            stopPlaybackQueue();
          } else if (packet.type === "error") {
            setError(packet.message);
            teardownSession("error");
          }
        };

        ws.onerror = () => {
          setError("Unable to reach the Live Voice server. Please try again.");
          teardownSession("error");
        };

        ws.onclose = () => {
          if (wsRef.current === ws) {
            teardownSession("idle");
          }
        };
      } catch {
        if (stream) {
          for (const track of stream.getTracks()) track.stop();
        }
        setError("Failed to initialize browser audio session.");
        teardownSession("error");
      }
    },
    [appendTranscript, schedulePcmPlayback, status, stopPlaybackQueue, teardownSession, voice],
  );

  function sendTextTurn(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = textInput.trim();
    if (!trimmed || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setTextInput("");
    appendTranscript("user", trimmed);
    wsRef.current.send(JSON.stringify({ type: "text", text: trimmed }));
  }

  const activeEnergy = isSpeaking
    ? Math.max(0.25, outputLevel)
    : sessionMode === "text" || muted
      ? 0.04
      : inputLevel;

  const panelContent = (
    <motion.section
      className="voice-panel"
      role="dialog"
      aria-modal={isMobile ? "true" : undefined}
      aria-label="Live Voice Operations Copilot"
      initial={isMobile ? { opacity: 0, y: 24 } : { opacity: 0, y: -10, scale: 0.98 }}
      animate={isMobile ? { opacity: 1, y: 0 } : { opacity: 1, y: 0, scale: 1 }}
      exit={isMobile ? { opacity: 0, y: 24 } : { opacity: 0, y: -10, scale: 0.98 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <header className="voice-panel-head">
        <div>
          <strong>Live Voice Copilot</strong>
          <span>
            {status === "live" && sessionMode === "text"
              ? "Text input · live audio replies"
              : "Real-time operations conversation"}
          </span>
        </div>
        <button
          type="button"
          className="voice-icon-btn"
          aria-label="Close Live Voice panel"
          onClick={() => setOpen(false)}
        >
          <X size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>

      <div className="voice-stage" data-status={status}>
        <div className="voice-meter" aria-hidden="true">
          {WAVE_BARS.map((weight, idx) => {
            const pct =
              status === "live"
                ? Math.max(14, Math.min(100, Math.round((0.18 + activeEnergy * weight) * 100)))
                : status === "connecting"
                  ? 28
                  : 14;
            return (
              <motion.span
                key={idx}
                className="voice-bar"
                data-speaking={isSpeaking}
                animate={{ height: `${pct}%` }}
                transition={{ duration: 0.12, ease: "easeOut" }}
              />
            );
          })}
        </div>

        <div className="voice-stage-meta">
          <span className="voice-status-text">
            {status === "connecting"
              ? sessionMode === "text"
                ? "Connecting live audio session…"
                : "Connecting microphone & live session…"
              : status === "live"
                ? isSpeaking
                  ? "Speaking — talk or send a message anytime"
                  : sessionMode === "text"
                    ? "Connected in text mode — type below for voice replies"
                    : muted
                      ? "Microphone muted"
                      : "Listening — ask about shipments, exceptions, or routes"
                : "Start a live two-way voice session with your Control Tower"}
          </span>

          <div className="voice-controls-row">
            <label className="voice-select-wrap">
              <span className="visually-hidden">Voice selection</span>
              <Volume2 size={13} strokeWidth={1.75} aria-hidden="true" />
              <select
                value={voice}
                disabled={status === "live" || status === "connecting"}
                onChange={(e) => setVoice(e.target.value as LiveVoiceName)}
                aria-label="Assistant voice"
              >
                {LIVE_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} · {v.tone}
                  </option>
                ))}
              </select>
            </label>

            {status === "live" || status === "connecting" ? (
              <div className="voice-action-btns">
                {sessionMode === "voice" ? (
                  <button
                    type="button"
                    className="voice-btn-secondary"
                    aria-pressed={muted}
                    onClick={() => setMuted((prev) => !prev)}
                    title={muted ? "Unmute microphone" : "Mute microphone"}
                  >
                    {muted ? (
                      <MicOff size={14} strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <Mic size={14} strokeWidth={2} aria-hidden="true" />
                    )}
                    <span>{muted ? "Unmute" : "Mute"}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="voice-btn-danger"
                  onClick={() => teardownSession("idle")}
                >
                  <PhoneOff size={14} strokeWidth={2} aria-hidden="true" />
                  <span>End</span>
                </button>
              </div>
            ) : (
              <div className="voice-action-btns">
                <button
                  type="button"
                  className="voice-btn-primary"
                  onClick={() => void startVoiceSession("voice")}
                >
                  <Mic size={14} strokeWidth={2} aria-hidden="true" />
                  <span>{showTextFallback ? "Retry mic" : "Start conversation"}</span>
                </button>
                {showTextFallback ? (
                  <button
                    type="button"
                    className="voice-btn-secondary"
                    onClick={() => void startVoiceSession("text")}
                  >
                    <MessageSquare size={14} strokeWidth={2} aria-hidden="true" />
                    <span>Text mode</span>
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>

      {error ? (
        <p className="voice-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="voice-transcript" aria-live="polite">
        {turns.length === 0 ? (
          <p className="voice-empty">
            Live transcripts appear here as you speak. Try asking:
            &ldquo;Give me a status briefing on active shipments and open exceptions.&rdquo;
          </p>
        ) : (
          turns.map((turn) => (
            <div key={turn.id} className="voice-turn" data-role={turn.role}>
              <span className="voice-turn-label">
                {turn.role === "user" ? "You" : voice}
              </span>
              <p>{turn.text}</p>
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>

      {status === "live" ? (
        <form className="voice-text-form" onSubmit={sendTextTurn}>
          <label htmlFor="live-voice-text" className="visually-hidden">
            Type a message into the live voice session
          </label>
          <input
            id="live-voice-text"
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder={
              sessionMode === "text"
                ? "Ask Control Tower Copilot…"
                : "Or type into the live voice session…"
            }
            maxLength={500}
          />
          <button
            type="submit"
            disabled={!textInput.trim()}
            aria-label="Send message to live voice session"
          >
            <Send size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </form>
      ) : null}
    </motion.section>
  );

  return (
    <div className="voice-anchor">
      <button
        type="button"
        className="voice-trigger"
        data-active={status === "live" || status === "connecting"}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-label="Open Live Voice Conversation"
      >
        <AudioLines size={14} strokeWidth={2} aria-hidden="true" />
        <span>{status === "live" ? "Voice live" : "Voice"}</span>
        {status === "live" ? <span className="voice-live-dot" aria-hidden="true" /> : null}
      </button>

      {isMobile && mounted
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <div className="voice-mobile-portal">
                  <motion.div
                    className="voice-mobile-backdrop"
                    aria-hidden="true"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    onClick={() => setOpen(false)}
                  />
                  {panelContent}
                </div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : (
            <AnimatePresence>{open ? panelContent : null}</AnimatePresence>
          )}
    </div>
  );
}
