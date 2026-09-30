/**
 * Applies supabase/migrations/*.sql in filename order, once each, tracked in
 * app_migrations. Alternative: `supabase db push` with the Supabase CLI
 * (both read the same files — use one or the other per database). The
 * production server can also apply these itself via POST /cron/migrate.
 *
 *   DATABASE_URL=postgres://... npm run db:migrate
 */
import pg from "pg";
import type { Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString: url, ssl: process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  try {
    const db: Db = {
      query: async (text, params) => ({ rows: (await client.query(text, params as unknown[])).rows }),
      tx: async (fn) => {
        await client.query("begin");
        try {
          const out = await fn(db);
          await client.query("commit");
          return out;
        } catch (err) {
          await client.query("rollback");
          throw err;
        }
      },
      close: async () => {},
    };
    const { applied } = await runMigrations(db);
    for (const f of applied) console.log(`applied ${f}`);
    console.log(applied.length ? "done" : "migrations up to date");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
