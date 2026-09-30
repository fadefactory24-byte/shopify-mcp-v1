import { AnthropicProvider } from "./agent/anthropic.js";
import { KnowledgeService } from "./agent/knowledge.js";
import type { LLMProvider } from "./agent/llm.js";
import { publicBaseUrl, type Config } from "./config.js";
import type { Db } from "./db/client.js";
import type { Logger } from "./logger.js";
import { ChannelSender, EmailChannel } from "./email/channel.js";
import { dbTokenStore, GraphMailClient, type MailApi } from "./email/graph.js";
import { StaffNotifier, type HandoffNotifier } from "./pipeline/handoff.js";
import { MessageProcessor } from "./pipeline/processor.js";
import { ShopifyGraphQLClient } from "./shopify/client.js";
import { LiveShopifyService, type ShopifyService } from "./shopify/service.js";
import { SocialSender } from "./social/client.js";
import { SeventeenTrack, type TrackingService } from "./tracking/tracking.js";
import { WhatsAppCloudClient, type WhatsAppSender } from "./whatsapp/client.js";

export interface Services {
  db: Db;
  log: Logger;
  llm: LLMProvider;
  shopify: ShopifyService;
  whatsapp: WhatsAppSender;
  knowledge: KnowledgeService;
  notifier: HandoffNotifier;
  processor: MessageProcessor;
  /** Present when the email channel is enabled. */
  email: EmailChannel | null;
  /** Present when the Messenger/Instagram channel is enabled; app.ts's webhook route uses it to send. */
  social: WhatsAppSender | null;
}

/** Wire real implementations; tests pass fakes via `overrides`. */
export function buildServices(
  cfg: Config,
  db: Db,
  log: Logger,
  overrides: Partial<Pick<Services, "llm" | "shopify" | "whatsapp" | "notifier" | "social">> & { tracking?: TrackingService; mail?: MailApi } = {},
): Services {
  const tracking = overrides.tracking ?? (cfg.SEVENTEENTRACK_API_KEY ? new SeventeenTrack({ apiKey: cfg.SEVENTEENTRACK_API_KEY }) : undefined);
  const whatsapp =
    overrides.whatsapp ??
    new WhatsAppCloudClient({ accessToken: cfg.WHATSAPP_ACCESS_TOKEN, phoneNumberId: cfg.WHATSAPP_PHONE_NUMBER_ID, graphVersion: cfg.WHATSAPP_GRAPH_VERSION });
  const shopify =
    overrides.shopify ??
    new LiveShopifyService(
      new ShopifyGraphQLClient({
        storeDomain: cfg.SHOPIFY_STORE_DOMAIN,
        apiVersion: cfg.SHOPIFY_API_VERSION,
        staticToken: cfg.SHOPIFY_ADMIN_ACCESS_TOKEN || undefined,
        clientId: cfg.SHOPIFY_CLIENT_ID,
        clientSecret: cfg.SHOPIFY_CLIENT_SECRET,
      }),
      { storePublicUrl: cfg.STORE_PUBLIC_URL },
    );
  // Support mailbox (Microsoft Graph): the email channel and/or the staff alert emails.
  const mail: MailApi | null =
    overrides.mail ??
    (cfg.MS_CLIENT_ID
      ? new GraphMailClient({ clientId: cfg.MS_CLIENT_ID, tenant: cfg.MS_TENANT_ID, seedRefreshToken: cfg.MS_REFRESH_TOKEN, store: dbTokenStore(db) })
      : null);
  // The email channel and the processor need each other: bind the processor late.
  let processorRef: MessageProcessor | null = null;
  const email =
    mail && cfg.EMAIL_CHANNEL_ENABLED && cfg.EMAIL_MAILBOX
      ? new EmailChannel({
          db,
          mail,
          mailbox: cfg.EMAIL_MAILBOX,
          log,
          schedule: (id) => processorRef?.schedule(id),
          applyStaffReplies: async (echoes) => {
            await processorRef?.applyEchoes(echoes);
          },
        })
      : null;
  const social: WhatsAppSender | null =
    overrides.social ??
    (cfg.SOCIAL_CHANNEL_ENABLED && cfg.META_PAGE_ACCESS_TOKEN
      ? new SocialSender({ pageAccessToken: cfg.META_PAGE_ACCESS_TOKEN, pageId: cfg.META_PAGE_ID, instagramId: cfg.META_INSTAGRAM_ID, graphVersion: cfg.WHATSAPP_GRAPH_VERSION })
      : null);
  const sender = new ChannelSender(whatsapp, email, social);
  const alertTo = cfg.STAFF_NOTIFY_EMAIL.split(",").map((s) => s.trim()).filter(Boolean);
  const llm = overrides.llm ?? new AnthropicProvider({ apiKey: cfg.ANTHROPIC_API_KEY, refusalFallback: cfg.AI_REFUSAL_FALLBACK });
  const knowledge = new KnowledgeService(db, shopify);
  const notifier =
    overrides.notifier ??
    new StaffNotifier({
      webhookUrl: cfg.STAFF_NOTIFY_WEBHOOK_URL,
      staffNumbers: cfg.STAFF_WHATSAPP_NUMBERS.split(",").map((s) => s.trim()).filter(Boolean),
      whatsapp,
      adminBaseUrl: publicBaseUrl(cfg),
      email: mail && alertTo.length ? { send: (subject, text) => mail.sendMail(alertTo, subject, text) } : null,
      flagEmail: email ? (handle) => email.flagLatest(handle) : undefined,
      handoffTemplate: cfg.STAFF_HANDOFF_TEMPLATE ? { name: cfg.STAFF_HANDOFF_TEMPLATE, language: cfg.STAFF_HANDOFF_TEMPLATE_LANG } : undefined,
      log,
    });
  const processor = new MessageProcessor(
    {
      db,
      llm,
      shopify,
      knowledge,
      notifier,
      tracking,
      log,
      whatsapp: sender,
      config: { model: cfg.AI_MODEL_MAIN, effort: cfg.AI_MODEL_MAIN_EFFORT, maxIterations: cfg.AI_MAX_TOOL_ITERATIONS, historyMessages: cfg.AI_HISTORY_MESSAGES },
    },
    {
      debounceMs: cfg.DEBOUNCE_MS,
      maxInboundChars: cfg.MAX_INBOUND_CHARS,
      rateLimitPer10Min: cfg.RATE_LIMIT_PER_10_MIN,
      humanModeTimeoutHours: cfg.HUMAN_MODE_TIMEOUT_HOURS,
      maxAttempts: cfg.MAX_PROCESS_ATTEMPTS,
      typingIndicator: cfg.WHATSAPP_TYPING_INDICATOR,
      logBodies: cfg.LOG_MESSAGE_BODIES,
      fastModel: cfg.AI_MODEL_FAST,
    },
  );
  processorRef = processor;
  return { db, log, llm, shopify, whatsapp: sender, knowledge, notifier, processor, email, social };
}
