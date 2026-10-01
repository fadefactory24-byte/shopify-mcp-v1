import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { runMaintenance } from "./maintenance.js";
import { loadConfig, redactedConfigSummary } from "./config.js";
import { createPgDb } from "./db/client.js";
import { logger } from "./logger.js";
import { StaffNotifier } from "./pipeline/handoff.js";
import { buildServices } from "./services.js";

const cfg = loadConfig();
const db = createPgDb({ connectionString: cfg.DATABASE_URL, ssl: cfg.DATABASE_SSL, sslCa: cfg.DATABASE_SSL_CA || undefined, max: cfg.DATABASE_POOL_MAX });
const services = buildServices(cfg, db, logger);

const staffNotifier = services.notifier instanceof StaffNotifier ? services.notifier : null;

const app = createApp({
  db,
  log: logger,
  processor: services.processor,
  knowledge: services.knowledge,
  media: services.whatsapp,
  sendTestStaffAlert: staffNotifier ? () => staffNotifier.sendTest() : undefined,
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
    metaPageId: cfg.META_PAGE_ID || undefined,
    metaInstagramId: cfg.META_INSTAGRAM_ID || undefined,
    socialMaxAgeMs: cfg.SOCIAL_MAX_AGE_DAYS * 24 * 3600_000,
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

// Email channel: poll the support mailbox.
const emailPoll = services.email ? setInterval(() => void services.email!.poll(), cfg.EMAIL_POLL_SECONDS * 1000) : null;
if (services.email) void services.email.poll();

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
  if (emailPoll) clearInterval(emailPoll);
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
