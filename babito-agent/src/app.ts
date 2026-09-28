import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { timingSafeEqual } from "node:crypto";
import type { Db } from "./db/client.js";
import type { Logger } from "./logger.js";
import type { MessageProcessor } from "./pipeline/processor.js";
import { adminRoutes } from "./admin/routes.js";
import type { KnowledgeService } from "./agent/knowledge.js";
import type { WhatsAppSender } from "./whatsapp/client.js";
import { MalformedWebhookError, parseWebhook, verifySignature } from "./whatsapp/webhook.js";

export interface AppDeps {
  db: Db;
  log: Logger;
  processor: MessageProcessor;
  knowledge: KnowledgeService;
  /** Used by the dashboard to show customer photos/videos/documents. */
  media?: Pick<WhatsAppSender, "downloadMedia">;
  config: {
    verifyToken: string;
    appSecret: string;
    phoneNumberId: string;
    adminPassword: string;
    cronSecret: string;
    production: boolean;
  };
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

    // Persist synchronously (durable before we ack), process asynchronously.
    // If this throws, we return 500 and Meta retries — dedupe makes that safe.
    const { conversationIds } = await deps.processor.ingest(parsed.messages);
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

  app.post("/cron/maintenance", async (c) => {
    if (!cronAuth(c.req.header("authorization"))) return c.text("unauthorized", 401);
    const { rows } = await deps.db.query<{ purge_old_data: unknown }>(`select purge_old_data()`);
    log.info({ event: "maintenance", result: rows[0]?.purge_old_data }, "retention purge done");
    return c.json(rows[0]?.purge_old_data ?? {});
  });

  if (deps.config.adminPassword) app.route("/admin", adminRoutes(deps));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse(); // e.g. 401 from basic auth
    log.error({ err: err.message, path: c.req.path }, "unhandled error");
    return c.text("internal error", 500);
  });

  return app;
}
