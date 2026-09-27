import { createHmac } from "node:crypto";
import type { ChatBlock, LLMProvider, LLMRequest, LLMResponse } from "../../src/agent/llm.js";
import type { HandoffNotice, HandoffNotifier } from "../../src/pipeline/handoff.js";
import { ShopifyError } from "../../src/shopify/client.js";
import type { CatalogItem, OrderDetail, ProductDetail, ShopifyService } from "../../src/shopify/service.js";
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
  async getPolicies() {
    this.check("getPolicies");
    return [{ type: "shipping_policy", title: "Shipping", body: "זמני אספקה: 7-14 ימי עסקים", url: "https://mybabito.com/policies/shipping-policy" }];
  }
}

// ------------------------------------------------------------------ WhatsApp

export class FakeWhatsApp implements WhatsAppSender {
  sent: { to: string; body: string; id: string }[] = [];
  reads: string[] = [];
  failNext = 0;
  private n = 0;
  async sendText(to: string, body: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new WhatsAppApiError("WhatsApp API 500: boom", 500);
    }
    const id = `wamid.out.${++this.n}`;
    this.sent.push({ to, body, id });
    return { waMessageId: id };
  }
  async markRead(id: string) {
    this.reads.push(id);
  }
}

export class FakeNotifier implements HandoffNotifier {
  notices: HandoffNotice[] = [];
  async notify(n: HandoffNotice) {
    this.notices.push(n);
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
export function textWebhook(from: string, body: string, opts: { id?: string; name?: string; phoneNumberId?: string } = {}) {
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
              messages: [{ from, id: opts.id ?? `wamid.in.${++seq}.${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
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
