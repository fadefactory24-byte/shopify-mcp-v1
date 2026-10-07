import { z } from "zod";

/**
 * All configuration comes from environment variables (see .env.example).
 * Secrets are never logged: `redactedConfigSummary()` is the only thing we print.
 */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: int(8080),
  LOG_LEVEL: z.string().default("info"),
  /** Include message bodies in logs. Keep false in production (bodies are in the DB anyway). */
  LOG_MESSAGE_BODIES: bool(false),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool(true),
  /** Optional PEM CA (Supabase: Database settings -> SSL certificate) to fully verify the server. */
  DATABASE_SSL_CA: z.string().optional().default(""),
  DATABASE_POOL_MAX: int(5),

  // WhatsApp Cloud API
  WHATSAPP_VERIFY_TOKEN: z.string().min(8),
  WHATSAPP_APP_SECRET: z.string().optional().default(""),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_GRAPH_VERSION: z.string().default("v23.0"),
  WHATSAPP_TYPING_INDICATOR: bool(true),
  /**
   * Answer customers only during business hours (settings.business_hours): outside them the message waits
   * for the next opening, with one short acknowledgment. WhatsApp/Messenger/Instagram messages that would
   * wait longer than 20h are answered at once (their 24h reply window would close). Emergencies are never held.
   */
  REPLY_ONLY_IN_BUSINESS_HOURS: bool(false),
  /** Only for /admin/whatsapp-connect (Embedded Signup for a WhatsApp Business app number). */
  META_APP_ID: z.string().optional().default(""),
  WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: z.string().optional().default(""),

  // Shopify Admin GraphQL API
  SHOPIFY_STORE_DOMAIN: z.string().min(1), // e.g. my-store.myshopify.com
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().optional().default(""),
  SHOPIFY_CLIENT_ID: z.string().optional().default(""),
  SHOPIFY_CLIENT_SECRET: z.string().optional().default(""),
  SHOPIFY_API_VERSION: z.string().default("2026-07"),
  STORE_PUBLIC_URL: z.string().url().default("https://mybabito.com"),

  // LLM
  LLM_PROVIDER: z.enum(["anthropic"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  AI_MODEL_MAIN: z.string().default("claude-opus-5"),
  AI_MODEL_MAIN_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  AI_MODEL_FAST: z.string().default("claude-haiku-4-5"),
  AI_REFUSAL_FALLBACK: bool(true),
  AI_MAX_TOOL_ITERATIONS: int(6),
  AI_HISTORY_MESSAGES: int(16),

  // Pipeline behaviour
  DEBOUNCE_MS: int(2500),
  MAX_INBOUND_CHARS: int(2000),
  RATE_LIMIT_PER_10_MIN: int(25),
  HUMAN_MODE_TIMEOUT_HOURS: int(24),
  SWEEPER_INTERVAL_MS: int(15000),
  MAX_PROCESS_ATTEMPTS: int(3),
  /** In-process retention purge every N hours (0 = off, e.g. if an external cron calls /cron/maintenance). */
  MAINTENANCE_INTERVAL_HOURS: int(24),

  /** Optional 17TRACK API key: live parcel status for order questions (100 new parcels/month free). */
  SEVENTEENTRACK_API_KEY: z.string().optional().default(""),

  // Staff notifications on handoff (both optional)
  STAFF_NOTIFY_WEBHOOK_URL: z.string().optional().default(""),
  STAFF_WHATSAPP_NUMBERS: z.string().optional().default(""),
  /** Staff alert emails (handoffs, customer waiting, system problems), sent from the support mailbox. */
  STAFF_NOTIFY_EMAIL: z.string().optional().default(""),
  /**
   * Approved WhatsApp message template for staff handoff alerts (body params: customer, reason,
   * summary, in that order). Delivers even outside the 24h window, unlike a plain sendText to
   * STAFF_WHATSAPP_NUMBERS. Leave empty until the template is approved in WhatsApp Manager.
   */
  STAFF_HANDOFF_TEMPLATE: z.string().optional().default(""),
  STAFF_HANDOFF_TEMPLATE_LANG: z.string().default("en"),
  /** Optional Groq API key: staff can answer alerts with WhatsApp voice notes (speech-to-text, free tier). */
  GROQ_API_KEY: z.string().optional().default(""),
  TRANSCRIBE_MODEL: z.string().default("whisper-large-v3"),

  // Email channel: the support mailbox (Microsoft 365) through Microsoft Graph, delegated access.
  EMAIL_CHANNEL_ENABLED: bool(false),
  EMAIL_MAILBOX: z.string().optional().default(""),
  MS_TENANT_ID: z.string().default("organizations"),
  MS_CLIENT_ID: z.string().optional().default(""),
  /** Seed only: the server keeps the rotated token in integration_state afterwards. */
  MS_REFRESH_TOKEN: z.string().optional().default(""),
  EMAIL_POLL_SECONDS: int(60),
  /** Public https URL of this server, for links in alerts. Defaults to Railway's public domain. */
  PUBLIC_BASE_URL: z.string().optional().default(""),

  // Social channel: Facebook Page Messenger + Instagram DMs, same Meta app as WhatsApp.
  SOCIAL_CHANNEL_ENABLED: bool(false),
  META_PAGE_ID: z.string().optional().default(""),
  META_INSTAGRAM_ID: z.string().optional().default(""),
  META_PAGE_ACCESS_TOKEN: z.string().optional().default(""),
  /** Never auto-reply to (or even store) a Messenger/Instagram message older than this. */
  SOCIAL_MAX_AGE_DAYS: int(7),

  // Admin dashboard / API (HTTP Basic auth, user "admin")
  ADMIN_PASSWORD: z.string().optional().default(""),
  CRON_SECRET: z.string().optional().default(""),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const cfg = parsed.data;
  if (!cfg.SHOPIFY_ADMIN_ACCESS_TOKEN && !(cfg.SHOPIFY_CLIENT_ID && cfg.SHOPIFY_CLIENT_SECRET)) {
    throw new Error("Set SHOPIFY_ADMIN_ACCESS_TOKEN or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET");
  }
  if (cfg.NODE_ENV === "production") {
    if (!cfg.WHATSAPP_APP_SECRET) throw new Error("WHATSAPP_APP_SECRET is required in production (webhook signature check)");
    if (!cfg.ADMIN_PASSWORD || cfg.ADMIN_PASSWORD.length < 12) throw new Error("ADMIN_PASSWORD (>=12 chars) is required in production");
    if (!cfg.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required in production");
  }
  return cfg;
}

export function redactedConfigSummary(cfg: Config) {
  return {
    env: cfg.NODE_ENV,
    port: cfg.PORT,
    shopifyStore: cfg.SHOPIFY_STORE_DOMAIN,
    shopifyAuth: cfg.SHOPIFY_ADMIN_ACCESS_TOKEN ? "static_token" : "client_credentials",
    shopifyApiVersion: cfg.SHOPIFY_API_VERSION,
    whatsappGraphVersion: cfg.WHATSAPP_GRAPH_VERSION,
    signatureCheck: Boolean(cfg.WHATSAPP_APP_SECRET),
    llm: { provider: cfg.LLM_PROVIDER, main: cfg.AI_MODEL_MAIN, effort: cfg.AI_MODEL_MAIN_EFFORT, fast: cfg.AI_MODEL_FAST },
    staffWebhook: Boolean(cfg.STAFF_NOTIFY_WEBHOOK_URL),
    staffEmail: Boolean(cfg.MS_CLIENT_ID && cfg.STAFF_NOTIFY_EMAIL),
    emailChannel: cfg.EMAIL_CHANNEL_ENABLED && Boolean(cfg.MS_CLIENT_ID),
    socialChannel: cfg.SOCIAL_CHANNEL_ENABLED && Boolean(cfg.META_PAGE_ACCESS_TOKEN),
    liveTracking: Boolean(cfg.SEVENTEENTRACK_API_KEY),
    staffVoice: Boolean(cfg.GROQ_API_KEY),
    adminEnabled: Boolean(cfg.ADMIN_PASSWORD),
  };
}

export function publicBaseUrl(cfg: Config): string {
  if (cfg.PUBLIC_BASE_URL) return cfg.PUBLIC_BASE_URL.replace(/\/$/, "");
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN;
  return railway ? `https://${railway}` : "";
}
