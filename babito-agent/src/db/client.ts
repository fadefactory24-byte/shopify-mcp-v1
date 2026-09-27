import pg from "pg";

/**
 * Minimal database interface. Production uses node-postgres against Supabase;
 * tests use PGlite (in-process Postgres) through the same interface, so the
 * real SQL and migrations are exercised in tests.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs fn inside a transaction. The Db passed to fn is bound to that transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgDb(opts: { connectionString: string; ssl: boolean; sslCa?: string; max: number }): Db {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    // With a CA the server certificate is verified; without one the link is encrypted but unauthenticated.
    ssl: opts.ssl ? (opts.sslCa ? { ca: opts.sslCa, rejectUnauthorized: true } : { rejectUnauthorized: false }) : undefined,
    max: opts.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
  });

  const wrap = (client: pg.PoolClient | pg.Pool): Omit<Db, "tx" | "close"> => ({
    async query<T>(text: string, params?: unknown[]) {
      const res = await client.query(text, params as unknown[]);
      return { rows: res.rows as T[] };
    },
  });

  return {
    ...wrap(pool),
    async tx<T>(fn: (db: Db) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const inner: Db = {
          ...wrap(client),
          tx: (f) => f(inner), // nested -> same transaction
          close: async () => {},
        };
        const out = await fn(inner);
        await client.query("commit");
        return out;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
