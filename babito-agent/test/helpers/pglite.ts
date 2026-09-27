import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../../src/db/client.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "supabase", "migrations");

/** In-process Postgres (PGlite) with the real migrations applied. */
export async function createTestDb(): Promise<Db & { pg: PGlite }> {
  const pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
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
