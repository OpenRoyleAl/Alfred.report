import { secretGet } from "./secret";
/**
 * Cloudflare Agent Memory client for Workers.
 * Calls the Agent Memory HTTP API directly via fetch().
 *
 * API docs: https://developers.cloudflare.com/agent-memory/api/http-api/
 */

const BASE = 'https://api.cloudflare.com/client/v4/accounts';

export interface CFMemoryEntry {
  id: string;
  type: string;
  summary: string;
  content?: string;
  sessionId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CFRecallResult {
  answer: string;
  candidates: CFMemoryEntry[];
}

export interface CFMemoryClientOptions {
  accountId: string;
  apiToken: string;
  namespace?: string;
  profile?: string;
}

function profilePath(ns: string, profile: string, ...parts: string[]): string {
  return `/namespaces/${ns}/profiles/${profile}` + (parts.length ? '/' + parts.join('/') : '');
}

function check(data: any): any {
  if (!data.success) {
    const err = data.errors?.[0] || { code: 0, message: 'unknown' };
    throw new Error(`CF Agent Memory [${err.code}]: ${err.message}`);
  }
  return data;
}

export class CFMemory {
  private baseUrl: string;
  private headers: Record<string, string>;
  private ns: string;
  private profile: string;

  constructor(opts: CFMemoryClientOptions) {
    this.baseUrl = `${BASE}/${opts.accountId}/agent-memory`;
    this.headers = {
      'Authorization': `Bearer ${opts.apiToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'alfred-report/2.0',
    };
    this.ns = opts.namespace || 'alfred';
    this.profile = opts.profile || 'default';
  }

  /** Store one memory. Latency: 1.3–3.8s. */
  async remember(content: string, sessionId?: string): Promise<CFMemoryEntry> {
    const body: Record<string, unknown> = { content };
    if (sessionId) body.sessionId = sessionId;
    const resp = await fetch(
      `${this.baseUrl}${profilePath(this.ns, this.profile, 'remember')}`,
      { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
    );
    const data = check(await resp.json());
    return data.result as CFMemoryEntry;
  }

  /** Semantic recall. Latency: ~5s. Returns synthesized answer + candidates. */
  async recall(query: string): Promise<CFRecallResult> {
    const resp = await fetch(
      `${this.baseUrl}${profilePath(this.ns, this.profile, 'recall')}`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          query,
          thinkingLevel: 'low',
          responseLength: 'short',
        }),
      },
    );
    const data = check(await resp.json());
    return data.result as CFRecallResult;
  }

  /** List memories (omits content). Fast ~0.4s. */
  async list(page = 1, perPage = 20): Promise<CFMemoryEntry[]> {
    const resp = await fetch(
      `${this.baseUrl}${profilePath(this.ns, this.profile, 'memories')}?page=${page}&perPage=${perPage}`,
      { method: 'GET', headers: this.headers },
    );
    const data = check(await resp.json());
    return (data.result || []) as CFMemoryEntry[];
  }

  /** Get one memory by ID (includes content). ~1.4s. */
  async get(memoryId: string): Promise<CFMemoryEntry> {
    const resp = await fetch(
      `${this.baseUrl}${profilePath(this.ns, this.profile, 'memories', memoryId)}`,
      { method: 'GET', headers: this.headers },
    );
    const data = check(await resp.json());
    return data.result as CFMemoryEntry;
  }

  /** Delete a memory by ID. */
  async delete(memoryId: string): Promise<void> {
    const resp = await fetch(
      `${this.baseUrl}${profilePath(this.ns, this.profile, 'memories', memoryId)}`,
      { method: 'DELETE', headers: this.headers },
    );
    check(await resp.json());
  }

  /** Ingest conversation messages. Returns immediately; writes land 3–8s later. */
  async ingest(messages: Array<{ role: string; content: string }>, sessionId?: string): Promise<void> {
    const body: Record<string, unknown> = { messages };
    if (sessionId) body.sessionId = sessionId;
    const resp = await fetch(
      `${this.baseUrl}${profilePath(this.ns, this.profile, 'ingest')}`,
      { method: 'POST', headers: this.headers, body: JSON.stringify(body) },
    );
    check(await resp.json());
  }

  /** Markdown summary of the profile's memories. */
  async summary(): Promise<string> {
    const resp = await fetch(
      `${this.baseUrl}${profilePath(this.ns, this.profile, 'summary')}`,
      { method: 'POST', headers: this.headers, body: '{}' },
    );
    const data = check(await resp.json());
    return data.result?.summary || '';
  }
}

/**
 * Build a CFMemory instance from Env bindings.
 * Returns null if credentials are not configured (graceful fallback).
 */
export function createCFMemory(env: {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}): CFMemory | null {
  const _tok = await secretGet(env.CF_API_TOKEN as any);
  const _acc = await secretGet(env.CF_ACCOUNT_ID as any);
  if (!_tok || !_acc) return null;
  return new CFMemory({
    accountId: _acc,
    apiToken: _tok,
    namespace: 'alfred',
    profile: 'default',
  });
}
