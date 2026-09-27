import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig, redactedConfigSummary } from "./config.js";
import { createPgDb } from "./db/client.js";
import { logger } from "./logger.js";
import { buildServices } from "./services.js";

const cfg = loadConfig();
const db = createPgDb({ connectionString: cfg.DATABASE_URL, ssl: cfg.DATABASE_SSL, sslCa: cfg.DATABASE_SSL_CA || undefined, max: cfg.DATABASE_POOL_MAX });
const services = buildServices(cfg, db, logger);

const app = createApp({
  db,
  log: logger,
  processor: services.processor,
  knowledge: services.knowledge,
  config: {
    verifyToken: cfg.WHATSAPP_VERIFY_TOKEN,
    appSecret: cfg.WHATSAPP_APP_SECRET,
    phoneNumberId: cfg.WHATSAPP_PHONE_NUMBER_ID,
    adminPassword: cfg.ADMIN_PASSWORD,
    cronSecret: cfg.CRON_SECRET,
    production: cfg.NODE_ENV === "production",
  },
});

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  logger.info({ ...redactedConfigSummary(cfg), port: info.port }, "babito-agent listening");
});

// Recovery loop: re-schedules stuck conversations and retries failed sends.
const sweeper = setInterval(() => {
  services.processor.sweep().catch((err) => logger.error({ err: String(err) }, "sweep failed"));
}, cfg.SWEEPER_INTERVAL_MS);
services.processor.sweep().catch(() => {});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  clearInterval(sweeper);
  server.close();
  // Let in-flight replies finish; unprocessed messages stay 'received' and the next instance picks them up.
  await services.processor.drain(20_000);
  services.processor.stopTimers();
  await db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
