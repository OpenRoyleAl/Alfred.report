/**
 * Owner notices (kingdom model): Alfred tells the default king when someone joins alfred.report.
 * Metadata only, taken from the signup itself (Rust notice.rs builds the record); nothing from
 * inside the new kingdom is ever read here. Shown in the owner's Report attention list.
 */
import { memoryOp } from "../alfred/core.ts";

export interface OwnerNotice { id: string; kind: string; tenant_id: string; text: string; at: number }

async function ensure(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS alfred_report_owner_notices (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, tenant_id TEXT NOT NULL, email TEXT, name TEXT,
        method TEXT, text TEXT NOT NULL, at INTEGER NOT NULL)`
    )
    .run();
}

/** Best-effort: a notice must never block a signup, but a failure is logged. */
export async function noticeNewUser(db: D1Database | undefined, u: { tenant_id: string; email: string; name?: string; method: "password" | "google" }): Promise<void> {
  if (!db) return;
  try {
    const n = memoryOp<{ kind: string; tenant_id: string; email: string; name: string; method: string; text: string; at: number }>("notice", { ...u, at: Date.now() });
    await ensure(db);
    await db
      .prepare(`INSERT INTO alfred_report_owner_notices (id, kind, tenant_id, email, name, method, text, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), n.kind, n.tenant_id, n.email, n.name, n.method, n.text, n.at)
      .run();
  } catch (err) {
    console.error(`owner notice failed: ${(err as Error).message}`);
  }
}

export async function recentNotices(db: D1Database | undefined, days = 14, limit = 5): Promise<OwnerNotice[]> {
  if (!db) return [];
  await ensure(db);
  const r = await db
    .prepare(`SELECT id, kind, tenant_id, text, at FROM alfred_report_owner_notices WHERE at >= ? ORDER BY at DESC LIMIT ?`)
    .bind(Date.now() - days * 86_400_000, limit)
    .all<OwnerNotice>();
  return r.results ?? [];
}
