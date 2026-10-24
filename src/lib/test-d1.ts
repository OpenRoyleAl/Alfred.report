// Test-only D1 stand-in on node:sqlite (same prepare/bind/first/run/all/batch surface the code uses).
import { DatabaseSync } from "node:sqlite";

export function testD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async <T>() => (db.prepare(sql).get(...(args as never[])) as T) ?? null,
    all: async <T>() => ({ results: db.prepare(sql).all(...(args as never[])) as T[] }),
    run: async () => {
      if (/^\s*create/i.test(sql)) {
        db.exec(sql);
        return { success: true, meta: { changes: 0 } };
      }
      const r = db.prepare(sql).run(...(args as never[]));
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: Array<{ sql: string; run(): Promise<unknown>; all(): Promise<unknown> }>) => {
      const out = [];
      for (const s of list) out.push(/^\s*select/i.test(s.sql) ? await s.all() : await s.run());
      return out;
    },
  } as unknown as D1Database;
}
