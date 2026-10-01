import { createHmac } from "node:crypto";
import type { ChatBlock, LLMProvider, LLMRequest, LLMResponse } from "../../src/agent/llm.js";
import type { HandoffNotice, HandoffNotifier, WaitingNotice } from "../../src/pipeline/handoff.js";
import type { InboxMessage, MailApi, SentMessage } from "../../src/email/graph.js";
import { ShopifyError } from "../../src/shopify/client.js";
import type { CatalogItem, OrderDetail, ProductDetail, ShopifyService } from "../../src/shopify/service.js";
import type { TrackingService, TrackingStatus } from "../../src/tracking/tracking.js";
import { WhatsAppApiError, type WhatsAppSender } from "../../src/whatsapp/client.js";

// ------------------------------------------------------------------ Shopify

export const CHOKING_ID = "gid://shopify/Product/9666971042149";
export const CHAIR_ID = "gid://shopify/Product/9632686211429";

export const CATALOG: CatalogItem[] = [
  {
    id: CHOKING_ID,
    title: "מכשיר הצלה למקרי חנק לילדים ולמבוגרים",
    handle: "מכשיר-הצלה-מחנק",
    productType: "מכשיר עזרה ראשונה למצבי חנק",
    vendor: "BABITO",
    tags: ["anti choking device", "choking rescue device", "מכשיר נגד חנק", "עזרה ראשונה"],
    url: "https://mybabito.com/products/choking",
    priceMin: 299.99,
    priceMax: 599.99,
    compareAtMax: null,
    currency: "ILS",
  },
  {
    id: CHAIR_ID,
    title: "כיסא האכלה לתינוק עם חיבור לשולחן",
    handle: "כיסא-האכלה-לתינוק",
    productType: "כיסא האכלה לתינוק",
    vendor: "BABITO",
    tags: ["portable high chair", "כיסא האכלה"],
    url: "https://mybabito.com/products/chair",
    priceMin: 297.99,
    priceMax: 297.99,
    compareAtMax: null,
    currency: "ILS",
  },
];

export const PRODUCTS: Record<string, ProductDetail> = {
  [CHOKING_ID]: {
    id: CHOKING_ID,
    title: CATALOG[0]!.title,
    description: "מכשיר עזר לשעת חירום לשחרור חסימה בדרכי הנשימה.",
    productType: "first aid",
    url: CATALOG[0]!.url,
    active: true,
    options: [{ name: "כמות", values: ["יחידה", "2 יחידות", "3 יחידות"] }],
    variants: [
      { id: "gid://shopify/ProductVariant/1", title: "יחידה", price: 299.99, compareAtPrice: null, available: true },
      { id: "gid://shopify/ProductVariant/2", title: "2 יחידות", price: 499.99, compareAtPrice: null, available: true },
      { id: "gid://shopify/ProductVariant/3", title: "3 יחידות", price: 599.99, compareAtPrice: null, available: false },
    ],
  },
  [CHAIR_ID]: {
    id: CHAIR_ID,
    title: CATALOG[1]!.title,
    description: "כיסא קומפקטי שמתחבר לשולחן.",
    productType: "chair",
    url: CATALOG[1]!.url,
    active: true,
    options: [],
    variants: [{ id: "gid://shopify/ProductVariant/9", title: "אפור", price: 297.99, compareAtPrice: null, available: true }],
  },
};

export const CUSTOMER_PHONE = "972501234567";

export function makeOrder(over: Partial<OrderDetail> = {}): OrderDetail {
  return {
    id: "gid://shopify/Order/1",
    name: "#1001",
    createdAt: "2026-09-20T10:00:00Z",
    stage: "shipped",
    financialStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    items: [{ name: "מכשיר הצלה למקרי חנק", quantity: 1 }],
    tracking: [{ company: "Israel Post", number: "RR123456789IL", url: "https://track.example/RR123456789IL" }],
    estimatedDeliveryAt: null,
    deliveredAt: null,
    shippingCity: "חיפה",
    contact: { phones: ["+972 50-123-4567"], emails: ["mom@example.com"] },
    ...over,
  };
}

export class FakeShopify implements ShopifyService {
  down = false;
  orders: OrderDetail[] = [makeOrder(), makeOrder({ id: "gid://shopify/Order/2", name: "#2002", stage: "processing", fulfillmentStatus: "UNFULFILLED", tracking: [], contact: { phones: ["+972529999999"], emails: ["other@example.com"] } })];
  calls: string[] = [];

  private check(name: string) {
    this.calls.push(name);
    if (this.down) throw new ShopifyError("Shopify network error: ECONNRESET", "unavailable");
  }
  async listCatalog() {
    this.check("listCatalog");
    return CATALOG;
  }
  async getProduct(id: string) {
    this.check("getProduct");
    return PRODUCTS[id] ?? null;
  }
  async findOrderByName(n: string) {
    this.check("findOrderByName");
    const digits = n.replace(/\D/g, "");
    return this.orders.find((o) => o.name.replace(/\D/g, "") === digits) ?? null;
  }
  async findOrdersByPhone(phone: string) {
    this.check("findOrdersByPhone");
    const mine = this.orders.filter((o) => o.contact.phones.some((p) => p.replace(/\D/g, "").endsWith(phone.slice(-9))));
    return mine.length ? { customerId: "gid://shopify/Customer/1", firstName: "Dana", orders: mine } : null;
  }
  async findOrdersByEmail(email: string) {
    this.check("findOrdersByEmail");
    const mine = this.orders.filter((o) => o.contact.emails.includes(email.toLowerCase()));
    return mine.length ? { customerId: "gid://shopify/Customer/1", firstName: "Dana", orders: mine } : null;
  }
  async getPolicies() {
    this.check("getPolicies");
    return [{ type: "shipping_policy", title: "Shipping", body: "זמני אספקה: 7-14 ימי עסקים", url: "https://mybabito.com/policies/shipping-policy" }];
  }
}

// ------------------------------------------------------------------ Tracking

export class FakeTracking implements TrackingService {
  statuses = new Map<string, TrackingStatus>([["RR123456789IL", { stage: "final_leg", lastUpdate: "2026-09-26" }]]);
  asked: { number: string; carrier?: number }[] = [];
  async status(number: string, carrier?: number) {
    this.asked.push({ number, carrier });
    return this.statuses.get(number) ?? null;
  }
}

// ------------------------------------------------------------------ WhatsApp

export class FakeWhatsApp implements WhatsAppSender {
  sent: { to: string; body: string; id: string }[] = [];
  reads: string[] = [];
  /** Message ids a typing indicator was shown for. */
  typing: string[] = [];
  failNext = 0;
  /** What a failing send throws (default: a retryable 500). */
  failWith = () => new WhatsAppApiError("WhatsApp API 500: boom", 500);
  private n = 0;
  async sendText(to: string, body: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw this.failWith();
    }
    const id = `wamid.out.${++this.n}`;
    this.sent.push({ to, body, id });
    return { waMessageId: id };
  }
  async markRead(id: string, typing: boolean) {
    this.reads.push(id);
    if (typing) this.typing.push(id);
  }
  /** What downloadMedia returns (tests can swap in other content types). */
  media = { contentType: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff]).buffer as ArrayBuffer };
  downloaded: string[] = [];
  async downloadMedia(id: string) {
    this.downloaded.push(id);
    return this.media;
  }
}

export class FakeNotifier implements HandoffNotifier {
  notices: HandoffNotice[] = [];
  waiting: WaitingNotice[] = [];
  alerts: { kind: string; message: string }[] = [];
  async notify(n: HandoffNotice) {
    this.notices.push(n);
  }
  async customerWaiting(n: WaitingNotice) {
    this.waiting.push(n);
  }
  async systemAlert(kind: string, message: string) {
    this.alerts.push({ kind, message });
  }
}

// ------------------------------------------------------------------ LLM

type Step = (req: LLMRequest) => LLMResponse | Promise<LLMResponse>;

/** Scripted LLM: each call consumes the next step. Records every request. */
export class ScriptedLLM implements LLMProvider {
  requests: LLMRequest[] = [];
  constructor(private steps: Step[] = []) {}
  push(...steps: Step[]) {
    this.steps.push(...steps);
  }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error("ScriptedLLM: no more steps");
    return step(req);
  }
}

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 };

export const say = (text: string): Step => () => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage, model: "fake" });

export const callTool = (name: string, input: unknown, id = `tu_${name}_${Math.random().toString(36).slice(2, 7)}`): Step => () => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
  usage,
  model: "fake",
});

export const refuse: Step = () => ({ content: [], stopReason: "refusal", usage, model: "fake" });

/** Last tool_result blocks the model received, parsed. */
export function lastToolResults(req: LLMRequest): { content: any; isError?: boolean }[] {
  const last = req.messages[req.messages.length - 1]!;
  return last.content
    .filter((b): b is Extract<ChatBlock, { type: "tool_result" }> => b.type === "tool_result")
    .map((b) => ({ content: JSON.parse(b.content), isError: b.isError }));
}

// ------------------------------------------------------------------ webhook payloads

let seq = 0;
export function textWebhook(from: string, body: string, opts: { id?: string; name?: string; phoneNumberId?: string; replyTo?: string } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "972000000000", phone_number_id: opts.phoneNumberId ?? "PNID" },
              contacts: [{ wa_id: from, profile: { name: opts.name ?? "Dana" } }],
              messages: [{ from, id: opts.id ?? `wamid.in.${++seq}.${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body }, ...(opts.replyTo ? { context: { id: opts.replyTo } } : {}) }],
            },
          },
        ],
      },
    ],
  };
}

export function mediaWebhook(from: string, type: "audio" | "image") {
  const p = textWebhook(from, "x") as any;
  const m = p.entry[0].changes[0].value.messages[0];
  delete m.text;
  m.type = type;
  m[type] = { id: "MEDIA1", mime_type: type === "audio" ? "audio/ogg" : "image/jpeg" };
  return p;
}

export function statusWebhook(waMessageId: string, status: string) {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PNID" }, statuses: [{ id: waMessageId, status, recipient_id: CUSTOMER_PHONE }] } }] }],
  };
}

export function sign(body: string, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// ------------------------------------------------------------------ Social (Messenger/Instagram)

/** A Page (Messenger) or Instagram DM webhook payload, same `entry[].messaging[]` shape as Meta sends. */
export function socialWebhook(
  platform: "page" | "instagram",
  senderId: string,
  opts: { text?: string; id?: string; recipientId?: string; ageMs?: number; isEcho?: boolean; attachment?: { type: string; url: string }; isDeleted?: boolean } = {},
) {
  const timestamp = Date.now() - (opts.ageMs ?? 0);
  const message: Record<string, unknown> = { mid: opts.id ?? `mid.${++seq}.${Date.now()}` };
  if (opts.text !== undefined) message.text = opts.text;
  if (opts.attachment) message.attachments = [{ type: opts.attachment.type, payload: { url: opts.attachment.url } }];
  if (opts.isEcho) message.is_echo = true;
  if (opts.isDeleted) message.is_deleted = true;
  return {
    object: platform,
    entry: [
      {
        id: opts.recipientId ?? (platform === "instagram" ? "IG_ID" : "PAGE_ID"),
        messaging: [
          {
            sender: { id: opts.isEcho ? (opts.recipientId ?? (platform === "instagram" ? "IG_ID" : "PAGE_ID")) : senderId },
            recipient: { id: opts.isEcho ? senderId : (opts.recipientId ?? (platform === "instagram" ? "IG_ID" : "PAGE_ID")) },
            timestamp,
            message,
          },
        ],
      },
    ],
  };
}

// ------------------------------------------------------------------ Email (Microsoft Graph)

export class FakeMail implements MailApi {
  inbox: InboxMessage[] = [];
  sent: SentMessage[] = [];
  replies: { messageId: string; text: string; id: string }[] = [];
  mails: { to: string[]; subject: string; text: string }[] = [];
  flags: { messageId: string; category: string }[] = [];
  private n = 0;
  async listInbox(since: Date) {
    return this.inbox.filter((m) => new Date(m.receivedAt) >= since);
  }
  async listSent(since: Date) {
    return this.sent.filter((m) => new Date(m.sentAt) >= since);
  }
  async reply(messageId: string, text: string) {
    const id = `sent-${++this.n}`;
    this.replies.push({ messageId, text, id });
    const to = this.inbox.find((m) => m.id === messageId)?.fromAddress ?? "unknown@example.com";
    this.sent.push({ id, toAddresses: [to], text, sentAt: new Date().toISOString() });
    return id;
  }
  async sendMail(to: string[], subject: string, text: string) {
    this.mails.push({ to, subject, text });
  }
  async flagForStaff(messageId: string, category: string) {
    this.flags.push({ messageId, category });
  }
  /** A customer email arriving now. */
  receive(from: string, text: string, opts: Partial<InboxMessage> = {}) {
    const m: InboxMessage = {
      id: `in-${++this.n}`,
      conversationId: "conv-1",
      subject: "שאלה",
      fromAddress: from,
      fromName: "Dana Levi",
      receivedAt: new Date(Date.now() + 1000).toISOString(),
      text,
      hasAttachments: false,
      headers: {},
      ...opts,
    };
    this.inbox.push(m);
    return m;
  }
}
