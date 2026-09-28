import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { runMaintenance } from "./maintenance.js";
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
  media: services.whatsapp,
  config: {
    verifyToken: cfg.WHATSAPP_VERIFY_TOKEN,
    appSecret: cfg.WHATSAPP_APP_SECRET,
    phoneNumberId: cfg.WHATSAPP_PHONE_NUMBER_ID,
    adminPassword: cfg.ADMIN_PASSWORD,
    cronSecret: cfg.CRON_SECRET,
    production: cfg.NODE_ENV === "production",
    metaAppId: cfg.META_APP_ID,
    embeddedSignupConfigId: cfg.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID,
    graphVersion: cfg.WHATSAPP_GRAPH_VERSION,
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

// Daily retention purge, so no external cron is needed. First run 10 minutes after start (not during a deploy).
const maintenanceMs = cfg.MAINTENANCE_INTERVAL_HOURS * 3600_000;
const maintain = () => runMaintenance(db, logger).catch((err) => logger.error({ err: String(err) }, "maintenance failed"));
const maintenanceStart = maintenanceMs > 0 ? setTimeout(maintain, 10 * 60_000) : null;
const maintenance = maintenanceMs > 0 ? setInterval(maintain, maintenanceMs) : null;

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  clearInterval(sweeper);
  if (maintenanceStart) clearTimeout(maintenanceStart);
  if (maintenance) clearInterval(maintenance);
  server.close();
  // Let scheduled and in-flight agent runs finish (a multi-tool run can take over a minute; the
  // platform's stop timeout must allow for this). Runs still going after that are abandoned: their
  // messages go back to 'received' and their leases are released, so the next instance's sweeper
  // answers them within seconds instead of after lease expiry.
  await services.processor.drain(90_000);
  services.processor.stopTimers();
  await services.processor.releaseLeases();
  await db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
