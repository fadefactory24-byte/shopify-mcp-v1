import pino from "pino";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { buildServices } from "../../src/services.js";
import { FakeMail, FakeNotifier, FakeShopify, FakeTracking, FakeWhatsApp, ScriptedLLM, sign } from "./fakes.js";
import { createTestDb } from "./pglite.js";

export const APP_SECRET = "test-app-secret";

export async function createHarness(envOverrides: Record<string, string> = {}) {
  const cfg = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://memory",
    WHATSAPP_VERIFY_TOKEN: "verify-token-123",
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_ACCESS_TOKEN: "x",
    WHATSAPP_PHONE_NUMBER_ID: "PNID",
    SHOPIFY_STORE_DOMAIN: "test.myshopify.com",
    SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_test",
    ANTHROPIC_API_KEY: "test",
    DEBOUNCE_MS: "30",
    ADMIN_PASSWORD: "admin-password-123",
    CRON_SECRET: "cron-secret",
    ...envOverrides,
  });
  const db = await createTestDb();
  const log = pino({ level: "silent" });
  const llm = new ScriptedLLM();
  const shopify = new FakeShopify();
  const whatsapp = new FakeWhatsApp();
  const notifier = new FakeNotifier();
  const tracking = new FakeTracking();
  const mail = new FakeMail();
  const services = buildServices(cfg, db, log, { llm, shopify, whatsapp, notifier, tracking, mail });
  /** Fake Graph API for the admin's Embedded Signup calls; tests replace it. */
  let metaFetch: typeof fetch = async () => new Response(JSON.stringify({ error: { message: "no fake set" } }), { status: 500 });
  const app = createApp({
    db,
    log,
    processor: services.processor,
    knowledge: services.knowledge,
    media: services.whatsapp,
    config: {
      verifyToken: cfg.WHATSAPP_VERIFY_TOKEN,
      appSecret: cfg.WHATSAPP_APP_SECRET,
      phoneNumberId: cfg.WHATSAPP_PHONE_NUMBER_ID,
      adminPassword: cfg.ADMIN_PASSWORD,
      cronSecret: cfg.CRON_SECRET,
      production: false,
      metaAppId: cfg.META_APP_ID,
      embeddedSignupConfigId: cfg.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID,
      graphVersion: cfg.WHATSAPP_GRAPH_VERSION,
    },
    fetchImpl: (...args: Parameters<typeof fetch>) => metaFetch(...args),
  });

  /** POST a signed webhook payload, like Meta does. */
  async function post(payload: unknown, opts: { signature?: string | null } = {}) {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    const sig = opts.signature === undefined ? sign(body, APP_SECRET) : opts.signature;
    if (sig) headers["x-hub-signature-256"] = sig;
    return app.request("/webhook", { method: "POST", body, headers });
  }

  /** Send a customer message through the webhook and wait for processing to finish. */
  async function customerSays(payload: unknown) {
    const res = await post(payload);
    await services.processor.drain();
    return res;
  }

  async function q<T = any>(sql: string, params?: unknown[]) {
    return (await db.query<T>(sql, params)).rows;
  }

  const setMetaFetch = (f: typeof fetch) => {
    metaFetch = f;
  };

  return { cfg, db, app, llm, shopify, whatsapp, notifier, tracking, services, post, customerSays, q, setMetaFetch, mail, email: services.email, processor: services.processor };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
