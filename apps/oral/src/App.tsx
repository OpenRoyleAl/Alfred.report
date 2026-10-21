import { useEffect, useRef, useState, useCallback } from "react";
import type { VoiceClient } from "@cloudflare/voice/client";

function toStatus(s: string): SessionStatus {
  return (["idle", "connecting", "listening", "thinking", "speaking", "error"] as const).includes(s as SessionStatus)
    ? (s as SessionStatus)
    : "idle";
}

type SessionStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

interface WhoAmI {
  tenant: string;
  isOwner: boolean;
  brand: string;
  wakeWord: string;
}

/**
 * ORAL voice UI (voice-listen stage). Listening is continuous; saying the instance brand
 * (the wake word) gives The Report. The owner can say "start a mission ..." then "Go Max AI!".
 * The agent instance is the signed-in tenant (from /api/whoami; the Worker enforces it).
 */
export function AlfredOral() {
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [interim, setInterim] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [turnMetrics, setTurnMetrics] = useState<{ outcome: string; totalMs: number } | null>(null);
  const [muted, setMuted] = useState(false);

  const [me, setMe] = useState<WhoAmI | null>(null);
  const clientRef = useRef<VoiceClient | null>(null);

  useEffect(() => {
    fetch("/api/whoami", { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<WhoAmI>) : Promise.reject(new Error("Sign in required"))))
      .then(setMe)
      .catch((e: Error) => setError(e.message));
  }, []);
  const brand = me?.brand ?? "Alfred.report!";
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript, interim]);

  const startCall = useCallback(async () => {
    if (!me) return;
    setError(null);
    setStatus("connecting");
    try {
      const { VoiceClient } = await import("@cloudflare/voice/client");
      const client = new VoiceClient({ agent: "alfred-oral", name: me.tenant });
      clientRef.current = client;

      client.addEventListener("statuschange", (st) => setStatus(toStatus(String(st))));
      client.addEventListener("interimtranscript", (text) => setInterim(text || ""));
      client.addEventListener("transcriptchange", (messages) => {
        setInterim("");
        setTranscript(
          messages
            .filter((m) => (m.text || "").trim())
            .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", text: m.text, timestamp: m.timestamp ?? Date.now() }))
        );
      });
      client.addEventListener("turnmetrics", (m) =>
        setTurnMetrics({ outcome: String(m.outcome ?? ""), totalMs: Number((m as { turnTotalMs?: number }).turnTotalMs ?? 0) })
      );
      client.addEventListener("error", (msg) => {
        if (!msg) return;
        setError(msg);
        setStatus("error");
      });
      client.addEventListener("connectionchange", (connected) => {
        if (!connected) setStatus("idle");
      });
      client.addEventListener("mutechange", (m) => setMuted(m));

      client.connect();
      await client.startCall();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start voice session");
      setStatus("error");
    }
  }, [me]);

  const endCall = useCallback(() => {
    clientRef.current?.endCall();
    clientRef.current?.disconnect();
    clientRef.current = null;
    setStatus("idle");
    setInterim("");
  }, []);

  const toggleMute = useCallback(() => {
    clientRef.current?.toggleMute();
  }, []);

  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
    };
  }, []);

  const statusConfig: Record<SessionStatus, { label: string; color: string; pulse: boolean }> = {
    idle: { label: `Tap to speak with ${brand}`, color: "#475569", pulse: false },
    connecting: { label: "Connecting…", color: "#f59e0b", pulse: true },
    listening: {
      label: `Listening — say ${me?.wakeWord ?? brand} for The Report`,
      color: "#22c55e",
      pulse: true,
    },
    thinking: { label: "Thinking…", color: "#8b5cf6", pulse: true },
    speaking: { label: "Speaking…", color: "#3b82f6", pulse: true },
    error: { label: "Connection lost — try again", color: "#ef4444", pulse: false },
  };
  const s = statusConfig[status];

  return (
    <div className="alfred-oral">
      <header className="header">
        <h1 className="title">{brand}</h1>
        <p className="subtitle">ORAL · continuous listen · Cloudflare Workers AI</p>
      </header>

      <div className="status-bar" style={{ borderColor: s.color }}>
        <span
          className={`status-dot ${s.pulse ? "pulse" : ""}`}
          style={{ backgroundColor: s.color }}
        />
        <span className="status-label">{s.label}</span>
        {turnMetrics && status !== "idle" && (
          <span className="turn-metric">
            {turnMetrics.outcome} · {turnMetrics.totalMs}ms
          </span>
        )}
      </div>

      {error && (
        <div className="error-banner">
          ⚠️ {error}
          <button className="retry-btn" onClick={() => { endCall(); startCall(); }}>
            Retry
          </button>
        </div>
      )}

      <div className="transcript-container" ref={transcriptRef}>
        {transcript.length === 0 && status === "idle" && (
          <div className="empty-state">
            <p className="empty-icon">🎙️</p>
            <p>Start a call — continuous listening is on.</p>
            <p className="hint">
              Say <strong>{me?.wakeWord ?? brand}</strong> for The Report
              {me?.isOwner ? <> · “start a mission …” then <strong>Go Max AI!</strong></> : null}
            </p>
          </div>
        )}
        {transcript.length === 0 && status === "listening" && (
          <div className="empty-state">
            <p className="empty-icon">👂</p>
            <p>Listening… speak anytime.</p>
            <p className="hint">Say <strong>{me?.wakeWord ?? brand}</strong> for The Report.</p>
          </div>
        )}
        {transcript.map((entry, i) => (
          <div key={i} className={`transcript-entry ${entry.role}`}>
            <span className="role-badge">
              {entry.role === "user" ? "You" : brand}
            </span>
            <span className="transcript-text">{entry.text}</span>
          </div>
        ))}
        {interim && (
          <div className="transcript-entry user interim">
            <span className="role-badge">You</span>
            <span className="transcript-text">{interim}…</span>
          </div>
        )}
      </div>

      <div className="controls">
        {status === "idle" || status === "error" ? (
          <button className="btn btn-start" onClick={startCall} disabled={!me}>
            🎙️ Speak
          </button>
        ) : (
          <>
            <button
              className={`btn ${muted ? "btn-muted" : "btn-mic"}`}
              onClick={toggleMute}
              disabled={status === "connecting"}
            >
              {muted ? "🔇 Unmute" : "🎤 Mute"}
            </button>
            <button className="btn btn-end" onClick={endCall}>
              ⏹️ End
            </button>
          </>
        )}
      </div>

      <footer className="footer">
        <p>ORAL · Cloudflare Workers AI · Flux + Aura</p>
      </footer>
    </div>
  );
}
