/**
 * Applies supabase/migrations/*.sql in filename order, once each, tracked in
 * app_migrations. Alternative: `supabase db push` with the Supabase CLI
 * (both read the same files — use one or the other per database).
 *
 *   DATABASE_URL=postgres://... npm run db:migrate
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const dir = join(import.meta.dirname, "..", "supabase", "migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString: url, ssl: process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(`create table if not exists app_migrations (name text primary key, applied_at timestamptz not null default now())`);
    await client.query(`alter table app_migrations enable row level security`);
    const applied = new Set((await client.query<{ name: string }>(`select name from app_migrations`)).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = await readFile(join(dir, f), "utf8");
      process.stdout.write(`applying ${f} ... `);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(`insert into app_migrations (name) values ($1)`, [f]);
        await client.query("commit");
        console.log("ok");
      } catch (err) {
        await client.query("rollback");
        console.log("FAILED");
        throw err;
      }
    }
    console.log("migrations up to date");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
