import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./client.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "supabase", "migrations");

/**
 * Applies supabase/migrations/*.sql in filename order, once each, tracked in app_migrations.
 * Shared by scripts/migrate.ts (run from a developer machine) and the production /cron/migrate
 * endpoint (run against the server's own DB connection, so no one needs to handle DATABASE_URL
 * by hand to apply a migration after a deploy).
 */
export async function runMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<{ applied: string[] }> {
  await db.query(`create table if not exists app_migrations (name text primary key, applied_at timestamptz not null default now())`);
  await db.query(`alter table app_migrations enable row level security`);
  const { rows } = await db.query<{ name: string }>(`select name from app_migrations`);
  const already = new Set(rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (already.has(f)) continue;
    const sql = await readFile(join(dir, f), "utf8");
    await db.tx(async (tx) => {
      await tx.query(sql);
      await tx.query(`insert into app_migrations (name) values ($1)`, [f]);
    });
    applied.push(f);
  }
  return { applied };
}
