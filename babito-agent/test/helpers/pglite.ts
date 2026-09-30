import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../../src/db/client.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "supabase", "migrations");

/** In-process Postgres (PGlite) with the real migrations applied. */
export async function createTestDb(): Promise<Db & { pg: PGlite }> {
  const pg = new PGlite();
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  // Matches a real (already-migrated) production DB: /cron/migrate's tracking table, pre-filled
  // so it doesn't try to re-run this schema's own (non-idempotent) create-table statements.
  await pg.exec(`create table if not exists app_migrations (name text primary key, applied_at timestamptz not null default now())`);
  for (const f of files) await pg.query(`insert into app_migrations (name) values ($1) on conflict do nothing`, [f]);
  const db: Db & { pg: PGlite } = {
    pg,
    async query<T>(text: string, params?: unknown[]) {
      return { rows: (await pg.query<T>(text, params as any[])).rows };
    },
    tx<T>(fn: (d: Db) => Promise<T>) {
      return pg.transaction(async (t) => {
        const inner: Db = {
          query: async <R>(text: string, params?: unknown[]) => ({ rows: (await t.query<R>(text, params as any[])).rows }),
          tx: (f) => f(inner),
          close: async () => {},
        };
        return fn(inner);
      }) as Promise<T>;
    },
    async close() {
      await pg.close();
    },
  };
  return db;
}
