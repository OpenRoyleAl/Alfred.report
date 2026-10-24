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
      if (/^\s*create/i.test(sql)) db.exec(sql);
      else db.prepare(sql).run(...(args as never[]));
      return { success: true };
    },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: Array<{ run(): Promise<unknown> }>) => {
      const out = [];
      for (const s of list) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}
