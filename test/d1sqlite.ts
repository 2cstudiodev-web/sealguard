// A D1Database stand-in over Node's built-in SQLite, with every migration applied, so tests run the real SQL
// (CASE, RETURNING, ON CONFLICT) instead of a hand-written fake.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function d1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const dir = join(__dirname, "..", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => {
    const conv = args.map((a) => (typeof a === "boolean" ? Number(a) : a === undefined ? null : a)) as any[];
    const s = {
      bind: (...a: unknown[]) => stmt(sql, a),
      run: async () => { const r = db.prepare(sql).run(...conv); return { success: true, meta: { changes: Number(r.changes) } }; },
      first: async <T>() => { const r = db.prepare(sql).get(...conv); return (r ? { ...r } : null) as T | null; },
      all: async <T>() => ({ results: db.prepare(sql).all(...conv).map((r) => ({ ...r })) as T[], success: true }),
    };
    return s;
  };
  return Object.assign({
    prepare: (sql: string) => stmt(sql),
    batch: async (list: any[]) => { db.exec("BEGIN"); try { const out = []; for (const s of list) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    exec: async (sql: string) => { db.exec(sql); return { count: 0, duration: 0 }; },
  }, { raw: db }) as any;
}
