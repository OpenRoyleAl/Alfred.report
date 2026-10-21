import type { D1Database } from "@cloudflare/workers-types";
import type { RecordRow, Record as KRecord, RecordType, Edge, Observation, InboxItem } from "../types";

/**
 * D1 database helper — knowledge graph operations.
 * All functions take a D1Database binding and return typed results.
 */

// ─── ID Generation ─────────────────────────────────────────────

export function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${ts}${rand}`;
}

/** Human mission codes: M-XXXXXXXX (Crockford). Double-click / copy friendly. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function generateMissionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "M-";
  for (let i = 0; i < 8; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

// ─── Records ───────────────────────────────────────────────────

export async function createRecord(
  db: D1Database,
  data: {
    type: RecordType;
    title: string;
    content?: string | null;
    content_r2_key?: string | null;
    status?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<KRecord> {
  const id = generateId(data.type.slice(0, 4));
  const now = Date.now();
  const metadata = data.metadata ? JSON.stringify(data.metadata) : null;

  await db
    .prepare(
      `INSERT INTO records (id, type, title, content, content_r2_key, status, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, data.type, data.title, data.content ?? null, data.content_r2_key ?? null, data.status ?? "active", now, now, metadata)
    .run();

  return {
    id,
    type: data.type,
    title: data.title,
    content: data.content ?? null,
    content_r2_key: data.content_r2_key ?? null,
    status: data.status ?? "active",
    created_at: now,
    updated_at: now,
    metadata: data.metadata ?? {},
  };
}

export async function getRecord(db: D1Database, id: string): Promise<KRecord | null> {
  const row = await db.prepare(`SELECT * FROM records WHERE id = ?`).bind(id).first<RecordRow>();
  return row ? rowToRecord(row) : null;
}

export async function getRecordsByType(db: D1Database, type: RecordType, limit = 100): Promise<KRecord[]> {
  const rows = await db
    .prepare(`SELECT * FROM records WHERE type = ? AND status = 'active' ORDER BY updated_at DESC LIMIT ?`)
    .bind(type, limit)
    .all<RecordRow>();
  return (rows.results ?? []).map(rowToRecord);
}

export async function getRecordsByStatus(db: D1Database, status: string, limit = 100): Promise<KRecord[]> {
  const rows = await db
    .prepare(`SELECT * FROM records WHERE status = ? ORDER BY updated_at DESC LIMIT ?`)
    .bind(status, limit)
    .all<RecordRow>();
  return (rows.results ?? []).map(rowToRecord);
}

export async function updateRecord(
  db: D1Database,
  id: string,
  updates: Partial<Pick<KRecord, "title" | "content" | "status" | "metadata">>
): Promise<void> {
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];

  if (updates.title !== undefined) { sets.push("title = ?"); binds.push(updates.title); }
  if (updates.content !== undefined) { sets.push("content = ?"); binds.push(updates.content); }
  if (updates.status !== undefined) { sets.push("status = ?"); binds.push(updates.status); }
  if (updates.metadata !== undefined) { sets.push("metadata = ?"); binds.push(JSON.stringify(updates.metadata)); }

  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  binds.push(Date.now());
  binds.push(id);

  await db.prepare(`UPDATE records SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
}

export async function deleteRecord(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM records WHERE id = ?`).bind(id).run();
  await db.prepare(`DELETE FROM edges WHERE source_id = ? OR target_id = ?`).bind(id, id).run();
}

export async function searchRecords(db: D1Database, query: string, limit = 50): Promise<KRecord[]> {
  const rows = await db
    .prepare(`SELECT * FROM records WHERE title LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT ?`)
    .bind(`%${query}%`, `%${query}%`, limit)
    .all<RecordRow>();
  return (rows.results ?? []).map(rowToRecord);
}

export async function countRecords(db: D1Database, type?: RecordType): Promise<number> {
  if (type) {
    const row = await db
      .prepare(`SELECT COUNT(*) as cnt FROM records WHERE type = ? AND status = 'active'`)
      .bind(type)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }
  const row = await db.prepare(`SELECT COUNT(*) as cnt FROM records WHERE status = 'active'`).first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

// ─── Edges ──────────────────────────────────────────────────────

export async function createEdge(
  db: D1Database,
  sourceId: string,
  targetId: string,
  relation: string,
  weight = 1.0
): Promise<Edge> {
  const id = generateId("edge");
  const now = Date.now();
  await db
    .prepare(`INSERT INTO edges (id, source_id, target_id, relation, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, sourceId, targetId, relation, weight, now)
    .run();
  return { id, source_id: sourceId, target_id: targetId, relation, weight, created_at: now };
}

export async function getEdges(db: D1Database, recordId: string): Promise<Edge[]> {
  const rows = await db
    .prepare(`SELECT * FROM edges WHERE source_id = ? OR target_id = ? ORDER BY created_at DESC`)
    .bind(recordId, recordId)
    .all<Edge>();
  return rows.results ?? [];
}

export async function deleteEdge(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM edges WHERE id = ?`).bind(id).run();
}

export async function findBrokenEdges(db: D1Database): Promise<Edge[]> {
  const rows = await db
    .prepare(`
      SELECT e.* FROM edges e
      LEFT JOIN records r1 ON e.source_id = r1.id
      LEFT JOIN records r2 ON e.target_id = r2.id
      WHERE r1.id IS NULL OR r2.id IS NULL
    `)
    .all<Edge>();
  return rows.results ?? [];
}

export async function findOrphanRecords(db: D1Database): Promise<KRecord[]> {
  const rows = await db
    .prepare(`
      SELECT r.* FROM records r
      LEFT JOIN edges e ON r.id = e.source_id OR r.id = e.target_id
      WHERE e.id IS NULL AND r.status = 'active'
    `)
    .all<RecordRow>();
  return (rows.results ?? []).map(rowToRecord);
}

export async function findStaleRecords(db: D1Database, maxAgeDays = 90): Promise<KRecord[]> {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const rows = await db
    .prepare(`SELECT * FROM records WHERE updated_at < ? AND status = 'active' ORDER BY updated_at ASC`)
    .bind(cutoff)
    .all<RecordRow>();
  return (rows.results ?? []).map(rowToRecord);
}

// ─── Observations ──────────────────────────────────────────────

export async function createObservation(
  db: D1Database,
  data: { record_id?: string | null; signal: string; source: string; confidence?: number }
): Promise<Observation> {
  const id = generateId("obs");
  const now = Date.now();
  await db
    .prepare(`INSERT INTO observations (id, record_id, signal, source, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, data.record_id ?? null, data.signal, data.source, data.confidence ?? 1.0, now)
    .run();
  return {
    id,
    record_id: data.record_id ?? null,
    signal: data.signal,
    source: data.source,
    confidence: data.confidence ?? 1.0,
    created_at: now,
  };
}

export async function getRecentObservations(db: D1Database, limit = 50): Promise<Observation[]> {
  const rows = await db
    .prepare(`SELECT * FROM observations ORDER BY created_at DESC LIMIT ?`)
    .bind(limit)
    .all<Observation>();
  return rows.results ?? [];
}

export async function getObservationsSince(db: D1Database, since: number): Promise<Observation[]> {
  const rows = await db
    .prepare(`SELECT * FROM observations WHERE created_at >= ? ORDER BY created_at DESC`)
    .bind(since)
    .all<Observation>();
  return rows.results ?? [];
}

// ─── Inbox ─────────────────────────────────────────────────────

export async function addToInbox(
  db: D1Database,
  data: { source: string; raw_content: string; metadata?: Record<string, unknown> }
): Promise<InboxItem> {
  const id = generateId("inbox");
  const now = Date.now();
  const metadata = data.metadata ? JSON.stringify(data.metadata) : null;
  await db
    .prepare(`INSERT INTO inbox (id, source, raw_content, metadata, received_at, processed) VALUES (?, ?, ?, ?, ?, 0)`)
    .bind(id, data.source, data.raw_content, metadata, now)
    .run();
  return {
    id,
    source: data.source,
    raw_content: data.raw_content,
    metadata: data.metadata ?? {},
    received_at: now,
    processed: false,
  };
}

export async function getUnprocessedInbox(db: D1Database, limit = 50): Promise<InboxItem[]> {
  const rows = await db
    .prepare(`SELECT * FROM inbox WHERE processed = 0 ORDER BY received_at ASC LIMIT ?`)
    .bind(limit)
    .all<InboxItem>();
  return rows.results ?? [];
}

export async function markInboxProcessed(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE inbox SET processed = 1 WHERE id = ?`).bind(id).run();
}

// ─── Helpers ───────────────────────────────────────────────────

function rowToRecord(row: RecordRow): KRecord {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  };
}
