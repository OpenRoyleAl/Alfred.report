// src/types.ts — Shared TypeScript types for Alfred system v2

export interface Env {
  // Static assets
  ASSETS: Fetcher;

  // Service bindings
  AGENT_ALFRED: Fetcher;
  ALFRED_REPORT: Fetcher;

  // Agent Memory (Cloudflare Agent Memory — NOT KV)
  ALFRED_MEMORY: AgentMemoryNamespace;

  // KV (CF Artifacts source storage only)
  ALFRED_COMMAND: KVNamespace;

  // D1 database
  DB: D1Database;

  // R2 buckets
  ALFRED_DATA: R2Bucket;
  ALFRED_SNAPSHOTS: R2Bucket;

  // Durable Objects
  MISSION_STATE: DurableObjectNamespace;
  VOICE_SESSION: DurableObjectNamespace;

  // Workers AI
  AI: Ai;

  // AI Search
  AI_SEARCH: AiSearchNamespace;

  // Browser Run
  BROWSER: Fetcher;

  // Analytics Engine (COP Map)
  ALFRED_COP: AnalyticsEngineDataset;

  // Secrets Store
  OPENAI_API_KEY: SecretStoreSecret;
  MIMO_API_KEY: SecretStoreSecret;
  XAI_API_KEY: SecretStoreSecret;
  CF_API_TOKEN: SecretStoreSecret;
  SIRI_BRIEFING_TOKEN: SecretStoreSecret;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;

  EMAIL?: {
    send(message: {
      to: string;
      from: string;
      subject: string;
      text?: string;
      html?: string;
    }): Promise<{ messageId?: string }>;
  };

  WALLET_HANDLE?: string;

  // Non-secret env vars
  ENVIRONMENT: string;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  AI_GATEWAY_URL: string;
  TTS_PROVIDER: string;
  STT_PROVIDER: string;
  VOICE_MODEL: string;
  ALFRED_PERSONALITY: string;
}

export interface SecretStoreSecret {
  get(): Promise<string>;
}

// --- Agent Memory types ---
// Reference: https://developers.cloudflare.com/agent-memory/api/workers-api/
export interface AgentMemoryNamespace {
  getProfile(profileName: string): Promise<AgentMemoryProfile>;
  deleteProfile(profileName: string): Promise<void>;
}

export interface AgentMemoryProfile {
  ingest(messages: Array<{ role: string; content: string }>, options?: { sessionId?: string | null }): Promise<void>;
  remember(memory: { content: string; sessionId?: string | null }): Promise<void>;
  recall(query: string, options?: {
    thinkingLevel?: "low" | "medium" | "high";
    responseLength?: "short" | "medium" | "long";
    referenceDate?: Date | string;
  }): Promise<{ count: number; answer: string; candidates: any[] }>;
  getSummary(options?: { sessionId?: string | null }): Promise<{ summary: string }>;
}

// --- AI Search types ---
export interface AiSearchNamespace {
  get(name: string): AiSearchInstance;
}

export interface AiSearchInstance {
  search(input: { query: string; filter?: Record<string, string> }): Promise<any>;
  chat(input: { messages: any[] }): Promise<any>;
}

// --- Mission lifecycle ---
export type MissionStatus = "pending" | "active" | "paused" | "completed" | "failed" | "cancelled";

export interface Mission {
  id: string;
  user_id: string;
  title: string;
  description?: string;
  status: MissionStatus;
  priority: number;
  oral_directives?: string;
  result?: string;
  budget_usd?: number;
  spent_usd?: number;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
}

export type MissionPhase =
  | "intent"          // User expresses intent
  | "contract"        // Mission contract formed
  | "execution"      // Bounded execution in progress
  | "evidence"       // Typed evidence collected
  | "gate"          // Independent gate verification
  | "durable_state"  // State persisted to DO + D1
  | "voice_report"  // Voice report generated
  | "completed";    // Server-derived completion

export interface MissionEvent {
  id: number;
  mission_id: string;
  event_type: string;
  event_data?: string;
  actor?: string;
  created_at: string;
}

// --- Voice ---
export type VoiceSessionStatus = "active" | "ended" | "error" | "timeout";

export interface VoiceSession {
  id: string;
  user_id: string;
  mission_id?: string;
  do_id: string;
  status: VoiceSessionStatus;
  tts_provider: string;
  stt_provider: string;
  voice_model?: string;
  language: string;
  transcript?: string;
  duration_seconds?: number;
  created_at: string;
  ended_at?: string;
}

// --- User preferences ---
export interface UserPreferences {
  user_id: string;
  tts_provider: string;
  stt_provider: string;
  voice_model: string;
  language: string;
  voice_sample_key?: string;
  updated_at: string;
}

// --- Voice samples ---
export type VoiceSampleStatus = "uploaded" | "processing" | "ready" | "failed";

export interface VoiceSample {
  id: string;
  user_id: string;
  r2_key: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  duration_seconds?: number;
  status: VoiceSampleStatus;
  created_at: string;
}

// --- COP Map ---
export interface CopOverview {
  active_missions: number;
  active_voice_sessions: number;
  cost_today_usd: number;
  token_burn_per_min: number;
  timestamp: string;
}

// --- TTS/STT interfaces ---
export interface TTSProvider {
  synthesize(text: string, options?: TTSOptions): Promise<ArrayBuffer>;
}

export interface TTSOptions {
  voice?: string;
  language?: string;
  speed?: number;
}

export interface STTProvider {
  transcribe(audio: ArrayBuffer, options?: STTOptions): Promise<string>;
}

export interface STTOptions {
  language?: string;
}

// --- Alfred personality ---
export const ALFRED_PERSONALITY = {
  formality: "warm-british-male",
  tone: "authoritative",
  verbosity: "concise",
  humor: "dry-wit",
  proactivity: "high",
  systemPrompt: `You are Alfred, a warm British male ORAL operator. You are authoritative yet approachable. You speak concisely with dry wit. You are highly proactive. You manage missions, interact via voice, and generate reports. Respond naturally as if speaking aloud — keep responses spoken-style and concise.`,
};
