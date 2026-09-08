// src/do/voice-session.ts — WebSocket voice session Durable Object (v2)
// Uses Agents SDK voice primitives: withVoice-style flow with Workers AI
// STT (Flux/Whisper) + TTS (Aura-2), Alfred personality, COP telemetry.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { recordCop } from "../cop/cop";
import { ALFRED_PERSONALITY } from "../types";

export class VoiceSessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    await this.ctx.storage.put("startedAt", new Date().toISOString());
    await this.ctx.storage.put("status", "active");
    await this.ctx.storage.put("transcript", []);
    const greeting = "Good evening. Alfred at your service. How may I assist?";
    wsSend(server, JSON.stringify({ type: "response", text: greeting }));
    try { const audio = await this.env.AI.run("@cf/deepgram/aura-2-en", { text: greeting }) as ArrayBuffer; wsSend(server, audio); } catch {}
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === "string") await this.processTextInput(ws, message);
    else await this.processAudioChunk(ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code, reason);
    const startedAt = (await this.ctx.storage.get("startedAt")) as string;
    const duration = startedAt ? Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000) : 0;
    const transcript = (await this.ctx.storage.get("transcript")) as any[];
    await this.env.DB.prepare(`UPDATE voice_sessions SET status = 'ended', ended_at = ?, duration_seconds = ?, transcript = ? WHERE do_id = ?`).bind(new Date().toISOString(), duration, transcript ? JSON.stringify(transcript) : null, this.ctx.id.toString()).run();
    recordCop(this.env, { userId: await this.getUserId(), missionId: "voice", agent: "voice", provider: this.env.STT_PROVIDER, model: "voice-session", eventType: "tool", tokensIn: 0, tokensOut: 0, durationMs: duration * 1000 });
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error("WebSocket error:", error);
    await this.env.DB.prepare(`UPDATE voice_sessions SET status = 'error', ended_at = ? WHERE do_id = ?`).bind(new Date().toISOString(), this.ctx.id.toString()).run();
  }

  async processTextInput(ws: WebSocket, text: string) {
    await this.appendToTranscript("user", text);
    let oralResponse: string;
    try {
      const response = await this.env.AGENT_ALFRED.fetch("https://agent-alfred/internal/process", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, sessionId: this.ctx.id.toString(), userId: await this.getUserId(), personality: this.env.ALFRED_PERSONALITY }) });
      const data = await response.json<{ response: string }>();
      oralResponse = data.response;
    } catch (err) {
      console.error("ORAL operator error:", err);
      wsSend(ws, JSON.stringify({ type: "error", message: "Failed to process request" }));
      return;
    }
    await this.appendToTranscript("alfred", oralResponse);
    wsSend(ws, JSON.stringify({ type: "response", text: oralResponse }));
    try {
      const start = Date.now();
      const audioBuffer = await this.env.AI.run("@cf/deepgram/aura-2-en", { text: oralResponse }) as ArrayBuffer;
      recordCop(this.env, { userId: await this.getUserId(), missionId: "voice", agent: "voice", provider: "workers-ai", model: "@cf/deepgram/aura-2-en", eventType: "tts", tokensIn: 0, tokensOut: Math.ceil(oralResponse.length / 4), durationMs: Date.now() - start });
      wsSend(ws, audioBuffer);
    } catch (err) { console.error("TTS error:", err); wsSend(ws, JSON.stringify({ type: "tts_error", message: "Speech synthesis failed" })); }
  }

  async processAudioChunk(ws: WebSocket, audio: ArrayBuffer) {
    try {
      const start = Date.now();
      const transcription = await this.env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: Array.from(new Uint8Array(audio)) }) as { text: string };
      const text = transcription.text;
      recordCop(this.env, { userId: await this.getUserId(), missionId: "voice", agent: "voice", provider: "workers-ai", model: "@cf/openai/whisper-large-v3-turbo", eventType: "stt", tokensIn: 0, tokensOut: Math.ceil(text.length / 4), durationMs: Date.now() - start });
      if (!text || text.trim().length === 0) return;
      wsSend(ws, JSON.stringify({ type: "transcript", text }));
      await this.processTextInput(ws, text);
    } catch (err) { console.error("STT error:", err); wsSend(ws, JSON.stringify({ type: "stt_error", message: "Speech recognition failed" })); }
  }

  private async appendToTranscript(speaker: string, text: string): Promise<void> {
    const transcript = (await this.ctx.storage.get("transcript")) as any[] || [];
    transcript.push({ speaker, text, timestamp: new Date().toISOString() });
    await this.ctx.storage.put("transcript", transcript);
  }

  private async getUserId(): Promise<string> {
    const session = await this.env.DB.prepare(`SELECT user_id FROM voice_sessions WHERE do_id = ?`).bind(this.ctx.id.toString()).first<{ user_id: string }>();
    return session?.user_id || "anonymous";
  }
}

function wsSend(ws: WebSocket, data: string | ArrayBuffer): void {
  try { ws.send(data); } catch {}
}