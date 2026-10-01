import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { timingSafeEqual } from "node:crypto";
import type { Db } from "./db/client.js";
import type { Logger } from "./logger.js";
import type { MessageProcessor } from "./pipeline/processor.js";
import { adminRoutes } from "./admin/routes.js";
import type { KnowledgeService } from "./agent/knowledge.js";
import { runMaintenance } from "./maintenance.js";
import type { WhatsAppSender } from "./whatsapp/client.js";
import { MalformedWebhookError, parseWebhook, verifySignature } from "./whatsapp/webhook.js";
import { MalformedSocialWebhookError, parseSocialWebhook } from "./social/webhook.js";
import { runMigrations } from "./db/migrate.js";
import type { StaffRelay } from "./pipeline/relay.js";

export interface AppDeps {
  db: Db;
  log: Logger;
  processor: MessageProcessor;
  knowledge: KnowledgeService;
  /** Staff replies to alerts (answer in plain words, approve a drafted customer message). */
  relay?: StaffRelay;
  /** Dashboard test button: sends the staff handoff alert now and reports per number. */
  sendTestStaffAlert?: () => Promise<{ to: string; ok: boolean; detail: string }[]>;
  /** Used by the dashboard to show customer photos/videos/documents. */
  media?: Pick<WhatsAppSender, "downloadMedia">;
  config: {
    verifyToken: string;
    appSecret: string;
    phoneNumberId: string;
    adminPassword: string;
    cronSecret: string;
    production: boolean;
    /** Facebook Page / Instagram professional account ids; present only when that channel is enabled. */
    metaPageId?: string;
    metaInstagramId?: string;
    socialMaxAgeMs?: number;
    /** Embedded Signup page (/admin/whatsapp-connect); optional. */
    metaAppId?: string;
    embeddedSignupConfigId?: string;
    graphVersion?: string;
  };
  /** Outgoing HTTP for the admin's Meta calls; tests inject a fake. */
  fetchImpl?: typeof fetch;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const { log } = deps;

  app.get("/health", async (c) => {
    try {
      await deps.db.query("select 1");
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, db: "down" }, 503);
    }
  });

  // Meta webhook verification handshake.
  app.get("/webhook", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token") ?? "";
    const challenge = c.req.query("hub.challenge") ?? "";
    if (mode === "subscribe" && safeEqual(token, deps.config.verifyToken)) return c.text(challenge);
    log.warn({ event: "webhook_verify_failed" }, "webhook verification failed");
    return c.text("forbidden", 403);
  });

  // Checked from Content-Length, or while the body streams in: an oversized body is never read whole.
  const webhookBodyLimit = bodyLimit({ maxSize: 1_000_000, onError: (c) => c.text("payload too large", 413) });

  app.post("/webhook", webhookBodyLimit, async (c) => {
    const raw = await c.req.text();

    if (deps.config.appSecret) {
      if (!verifySignature(raw, c.req.header("x-hub-signature-256"), deps.config.appSecret)) {
        log.warn({ event: "webhook_bad_signature" }, "rejected webhook with invalid signature");
        return c.text("invalid signature", 401);
      }
    } else if (deps.config.production) {
      return c.text("signature check not configured", 500);
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      log.warn({ event: "webhook_malformed", reason: "invalid_json" }, "malformed webhook");
      return c.text("bad request", 400);
    }

    // Same app, same webhook URL: WhatsApp Business Account payloads and Page/Instagram
    // messaging payloads are told apart by the top-level `object` field.
    const object = typeof body === "object" && body !== null ? (body as { object?: unknown }).object : undefined;
    if (object === "page" || object === "instagram") {
      let social;
      try {
        social = parseSocialWebhook(body, {
          expectedPageId: deps.config.metaPageId,
          expectedIgId: deps.config.metaInstagramId,
          maxAgeMs: deps.config.socialMaxAgeMs,
        });
      } catch (err) {
        if (err instanceof MalformedSocialWebhookError) {
          log.warn({ event: "webhook_malformed", reason: err.message }, "unsupported social webhook payload");
          return c.text("ignored", 200);
        }
        throw err;
      }
      if (social.skipped) log.warn({ event: "webhook_items_skipped", count: social.skipped }, "some social webhook items could not be parsed");
      const { conversationIds } = await deps.processor.ingest(social.messages);
      if (social.echoes.length) await deps.processor.applyEchoes(social.echoes);
      for (const id of conversationIds) deps.processor.schedule(id);
      return c.text("ok", 200);
    }

    let parsed;
    try {
      parsed = parseWebhook(body, deps.config.phoneNumberId);
    } catch (err) {
      if (err instanceof MalformedWebhookError) {
        // Signed by Meta but not something we handle: ack so Meta doesn't retry forever.
        log.warn({ event: "webhook_malformed", reason: err.message }, "unsupported webhook payload");
        return c.text("ignored", 200);
      }
      throw err;
    }
    if (parsed.skipped) log.warn({ event: "webhook_items_skipped", count: parsed.skipped }, "some webhook items could not be parsed");

    // Messages from a staff number that answer an alert or a draft belong to the relay, not to the customer pipeline.
    let customerMessages = parsed.messages;
    if (deps.relay) {
      customerMessages = [];
      for (const m of parsed.messages) {
        if (!(await deps.relay.accept(m))) customerMessages.push(m);
      }
    }

    // Persist synchronously (durable before we ack), process asynchronously.
    // If this throws, we return 500 and Meta retries — dedupe makes that safe.
    const { conversationIds } = await deps.processor.ingest(customerMessages);
    await deps.processor.applyStatuses(parsed.statuses);
    if (parsed.echoes.length) await deps.processor.applyEchoes(parsed.echoes);
    for (const id of conversationIds) deps.processor.schedule(id);
    return c.text("ok", 200);
  });

  // For platforms without a long-running process (or as an external heartbeat).
  const cronAuth = (h: string | undefined) => Boolean(deps.config.cronSecret) && safeEqual(h ?? "", `Bearer ${deps.config.cronSecret}`);

  app.post("/cron/sweep", async (c) => {
    if (!cronAuth(c.req.header("authorization"))) return c.text("unauthorized", 401);
    return c.json(await deps.processor.sweep());
  });

  // Applies any not-yet-applied supabase/migrations/*.sql against this server's own DB
  // connection, so a deploy can be followed up without anyone handling DATABASE_URL by hand.
  app.post("/cron/migrate", async (c) => {
    if (!cronAuth(c.req.header("authorization"))) return c.text("unauthorized", 401);
    try {
      const { applied } = await runMigrations(deps.db);
      log.info({ event: "migrations_applied", applied }, "migrations checked");
      return c.json({ applied });
    } catch (err) {
      log.error({ event: "migration_failed", err: String(err) }, "migration failed");
      return c.text(`migration failed: ${String(err)}`, 500);
    }
  });

  app.post("/cron/maintenance", async (c) => {
    if (!cronAuth(c.req.header("authorization"))) return c.text("unauthorized", 401);
    return c.json((await runMaintenance(deps.db, log)) as object);
  });

  if (deps.config.adminPassword) app.route("/admin", adminRoutes(deps));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse(); // e.g. 401 from basic auth
    log.error({ err: err.message, path: c.req.path }, "unhandled error");
    return c.text("internal error", 500);
  });

  return app;
}
