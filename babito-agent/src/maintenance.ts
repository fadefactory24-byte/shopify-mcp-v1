import type { Db } from "./db/client.js";
import type { Logger } from "./logger.js";

/** Retention purge (see purge_old_data() in the migrations). Idempotent, so overlapping runs are harmless. */
export async function runMaintenance(db: Db, log: Logger): Promise<unknown> {
  const { rows } = await db.query<{ purge_old_data: unknown }>(`select purge_old_data()`);
  const result = rows[0]?.purge_old_data ?? {};
  log.info({ event: "maintenance", result }, "retention purge done");
  return result;
}
