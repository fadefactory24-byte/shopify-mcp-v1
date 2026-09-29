import { z } from "zod";
import type { Db } from "../db/client.js";
import { emailOf } from "../email/channel.js";
import { repo, type Conversation, type ConversationContext, type Customer, type HandoffReason } from "../db/repo.js";
import type { Logger } from "../logger.js";
import { performHandoff, type HandoffNotifier } from "../pipeline/handoff.js";
import {
  orderBelongsToEmail,
  orderBelongsToPhone,
  searchCatalog,
  type OrderDetail,
  type ShopifyService,
} from "../shopify/service.js";
import { carrierFromTrackingUrl, type TrackingService } from "../tracking/tracking.js";
import type { KnowledgeService } from "./knowledge.js";
import type { ToolSpec } from "./llm.js";

export interface ToolContext {
  db: Db;
  shopify: ShopifyService;
  knowledge: KnowledgeService;
  notifier: HandoffNotifier;
  /** Live parcel status (optional; without it the bot only knows Shopify's "shipped"). */
  tracking?: TrackingService;
  log: Logger;
  customer: Customer;
  conversation: Conversation;
  /** Mutable short-term context; persisted by the agent at the end of the run. */
  context: ConversationContext;
  state: { handedOff: boolean };
}

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

const def = <S extends z.ZodType>(d: ToolDef<S>) => d;

const MAX_FAILED_VERIFICATIONS_PER_HOUR = 5;

function rememberProduct(ctx: ToolContext, p: { id: string; title: string }) {
  const list = (ctx.context.recent_products ?? []).filter((x) => x.id !== p.id);
  ctx.context.recent_products = [{ id: p.id, title: p.title }, ...list].slice(0, 5);
}

function rememberVerifiedOrder(ctx: ToolContext, name: string) {
  const set = new Set(ctx.context.verified_orders ?? []);
  set.add(name);
  ctx.context.verified_orders = [...set].slice(-10);
}

function recentFailedVerifications(ctx: ToolContext): number {
  const hourAgo = Date.now() - 3600_000;
  ctx.context.failed_verifications = (ctx.context.failed_verifications ?? []).filter((f) => new Date(f.at).getTime() > hourAgo);
  return ctx.context.failed_verifications.length;
}

/**
 * What the model may see about an order: status info only, never contact data. Carrier names are
 * left out (customers get the tracking link); live tracking is reduced to a stage and a date.
 */
async function publicOrder(o: OrderDetail, ctx: ToolContext, live: boolean) {
  const tracking = o.tracking.filter((t) => t.number || t.url);
  const shipped = ["shipped", "partially_shipped"].includes(o.stage);
  const first = tracking.find((t) => t.number);
  const liveStatus = live && shipped && first?.number && ctx.tracking ? await ctx.tracking.status(first.number, carrierFromTrackingUrl(first.url)) : null;
  return {
    order_number: o.name,
    created_at: o.createdAt.slice(0, 10),
    stage: o.stage,
    payment_status: o.financialStatus,
    fulfillment_status: o.fulfillmentStatus,
    items: o.items,
    tracking: tracking.map((t) => ({ number: t.number, url: t.url })),
    live_tracking: liveStatus ? { stage: liveStatus.stage, last_update: liveStatus.lastUpdate } : undefined,
    estimated_delivery_at: o.estimatedDeliveryAt,
    delivered_at: o.deliveredAt,
    shipping_city: o.shippingCity,
  };
}

// ---------------------------------------------------------------------------- tools

export const TOOLS = [
  def({
    name: "search_products",
    description:
      "Search the live BABITO catalog. Product titles are in HEBREW, so always pass Hebrew keywords (translate from Arabic/English), optionally plus English synonyms. Example: customer asks 'جهاز منع الاختناق' -> query 'מכשיר חנק anti choking'. Returns up to 5 matches with current price range, availability and link. available=false means sold out: never recommend it as if it can be bought; say it's out of stock or suggest an available alternative. If none of the results clearly is what the customer asked for, search once more with different Hebrew words (synonyms, singular/plural) before saying the store doesn't have it. Use get_product for variant prices/availability.",
    schema: z.object({
      query: z.string().min(2).max(120).describe("Hebrew keywords (+ optional English synonyms)"),
    }),
    async run(input, ctx) {
      const catalog = await ctx.shopify.listCatalog();
      const hits = searchCatalog(catalog, input.query, 5);
      for (const h of hits.slice(0, 3)) rememberProduct(ctx, h);
      return {
        results: hits.map((h) => ({
          product_id: h.id,
          title: h.title,
          type: h.productType,
          price_from: h.priceMin,
          price_to: h.priceMax,
          compare_at_price: h.compareAtMax && h.compareAtMax > h.priceMax ? h.compareAtMax : null,
          currency: h.currency,
          available: h.available ?? "unknown",
          url: h.url,
        })),
        note: hits.length === 0 ? "No match. Try other Hebrew keywords once, then ask the customer to describe the product or send a link." : undefined,
      };
    },
  }),

  def({
    name: "get_product",
    description:
      "Get live details for one product: description, options, and every variant's current price, compare-at (sale) price and availability. Call this before quoting a price or availability, including follow-ups like 'how much?' about a product discussed earlier (use its product_id from the conversation context).",
    schema: z.object({ product_id: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/, "must be a Shopify product GID") }),
    async run(input, ctx) {
      const p = await ctx.shopify.getProduct(input.product_id);
      if (!p || !p.active) return { found: false };
      rememberProduct(ctx, p);
      const notes = await ctx.knowledge.productNotes(p.id);
      return {
        found: true,
        product_id: p.id,
        title: p.title,
        description: p.description,
        url: p.url,
        options: p.options,
        variants: p.variants.slice(0, 40).map((v) => ({
          title: v.title,
          price: v.price,
          compare_at_price: v.compareAtPrice && v.compareAtPrice > v.price ? v.compareAtPrice : null,
          available: v.available,
        })),
        any_available: p.variants.some((v) => v.available),
        store_notes: notes.length ? notes : undefined,
      };
    },
  }),

  def({
    name: "get_my_orders",
    description:
      "List the customer's recent orders, found by their WhatsApp phone number (already verified by WhatsApp). Use when the customer asks about 'my order' without an order number.",
    schema: z.object({}),
    async run(_input, ctx) {
      const senderEmail = emailOf(ctx.customer.wa_id);
      const found = senderEmail ? await ctx.shopify.findOrdersByEmail(senderEmail) : await ctx.shopify.findOrdersByPhone(ctx.customer.wa_id);
      if (!found || found.orders.length === 0) {
        return {
          found: false,
          hint: senderEmail
            ? "No orders under this email address. Ask for the order number (and the email used on the order, if different)."
            : "No orders linked to this WhatsApp number. Ask for the order number (and later the order email if needed).",
        };
      }
      await repo.setCustomerShopifyId(ctx.db, ctx.customer.id, found.customerId);
      for (const o of found.orders) rememberVerifiedOrder(ctx, o.name);
      // Live tracking only for the two most recent orders (each new parcel uses tracking quota).
      const orders = await Promise.all(found.orders.map((o, i) => publicOrder(o, ctx, i < 2)));
      return { found: true, first_name: found.firstName, orders };
    },
  }),

  def({
    name: "get_order_status",
    description:
      "Get the status & tracking of a specific order by order number. Ownership is verified automatically against the customer's WhatsApp number; if that fails, ask the customer for the email used on the order and call again with `email`. Never reveal anything when verified=false.",
    schema: z.object({
      order_number: z.string().min(3).max(20).describe("e.g. #1234 or 1234"),
      email: z.string().email().max(120).optional().describe("Only if the customer provided it after a verification request"),
    }),
    async run(input, ctx) {
      if (recentFailedVerifications(ctx) >= MAX_FAILED_VERIFICATIONS_PER_HOUR) {
        return { verified: false, blocked: true, hint: "Too many failed attempts. Offer a human agent." };
      }
      const order = await ctx.shopify.findOrderByName(input.order_number);
      const alreadyVerified = order && (ctx.context.verified_orders ?? []).includes(order.name);
      if (!order) {
        ctx.context.failed_verifications!.push({ at: new Date().toISOString() });
        return { found: false, hint: "No order with this number. Ask the customer to double-check it (it appears in the order confirmation email/SMS)." };
      }
      const byPhone = ownsOrder(order, ctx.customer.wa_id);
      const byEmail = input.email ? orderBelongsToEmail(order, input.email) : false;
      if (!alreadyVerified && !byPhone && !byEmail) {
        ctx.context.failed_verifications!.push({ at: new Date().toISOString() });
        // Same response whether the order exists or not beyond this point, to avoid probing.
        return {
          found: true,
          verified: false,
          hint: input.email
            ? "Email does not match this order. Do not share any order details. Suggest checking the number/email or offer a human agent."
            : "This WhatsApp number is not on the order. Ask for the email address used on the order, then call again with it.",
        };
      }
      rememberVerifiedOrder(ctx, order.name);
      return { found: true, verified: true, order: await publicOrder(order, ctx, true) };
    },
  }),

  def({
    name: "request_order_change",
    description:
      "Customer wants to change something about an existing order (address, cancel, items, size/color, delivery). You CANNOT change orders. This tool verifies ownership, checks whether the order has shipped, and forwards the request to the team (conversation goes to a human). Only call after you know the order number and exactly what they want changed.",
    schema: z.object({
      order_number: z.string().min(3).max(20),
      change_type: z.enum(["address", "cancel", "items", "contact_details", "other"]),
      details: z.string().min(3).max(500).describe("What exactly the customer wants, in their words (no card numbers)"),
      email: z.string().email().max(120).optional(),
    }),
    async run(input, ctx) {
      const order = await ctx.shopify.findOrderByName(input.order_number);
      if (!order) return { submitted: false, reason: "order_not_found" };
      const verified =
        (ctx.context.verified_orders ?? []).includes(order.name) ||
        ownsOrder(order, ctx.customer.wa_id) ||
        (input.email ? orderBelongsToEmail(order, input.email) : false);
      if (!verified) return { submitted: false, reason: "not_verified", hint: "Ask for the email used on the order and call again with it." };
      rememberVerifiedOrder(ctx, order.name);

      const shipped = ["shipped", "partially_shipped", "delivered"].includes(order.stage);
      const closed = ["cancelled", "refunded"].includes(order.stage);
      await performHandoff(
        { db: ctx.db, notifier: ctx.notifier, log: ctx.log },
        {
          conversationId: ctx.conversation.id,
          customerId: ctx.customer.id,
          customerWaId: ctx.customer.wa_id,
          customerName: ctx.customer.display_name,
          kind: "order_change",
          reason: "order_change",
          priority: !shipped && !closed ? "high" : "normal", // unshipped changes are time-sensitive
          summary: `${input.change_type}: ${input.details}`,
          orderName: order.name,
          changeType: input.change_type,
          details: { stage: order.stage },
        },
      );
      ctx.state.handedOff = true;
      return {
        submitted: true,
        order_stage: order.stage,
        already_shipped: shipped,
        instruction:
          "Tell the customer the request was forwarded to the team who will confirm here. Do NOT promise the change will happen." +
          (shipped ? " Mention the order already shipped, so changes may not be possible." : ""),
      };
    },
  }),

  def({
    name: "get_knowledge",
    description:
      "Fetch store knowledge by key from the KNOWLEDGE INDEX in your instructions (shipping times/costs, returns, payments, FAQ, promotions). Use before answering any policy/shipping/payment/returns question.",
    schema: z.object({ keys: z.array(z.string().min(2).max(64)).min(1).max(4) }),
    async run(input, ctx) {
      const items = await ctx.knowledge.get(input.keys);
      return items.length ? { items } : { items: [], hint: "Not found. Don't guess; offer to check with the team." };
    },
  }),

  def({
    name: "handoff_to_human",
    description:
      "Transfer the conversation to a human team member. After this the AI stops replying in this chat. Use for: explicit request for a human, complaints, damaged/wrong/missing items, refunds/returns in progress, payment problems, lost/very late shipments, sensitive topics, or when you can't help.",
    schema: z.object({
      reason: z.enum(["customer_request", "complaint", "refund", "payment_issue", "shipping_issue", "uncertain", "tool_failure", "sensitive", "other"]),
      summary: z.string().min(5).max(600).describe("Short summary for staff: what the customer needs, order number if known"),
      priority: z.enum(["normal", "high"]).default("normal"),
    }),
    async run(input, ctx) {
      const res = await performHandoff(
        { db: ctx.db, notifier: ctx.notifier, log: ctx.log },
        {
          conversationId: ctx.conversation.id,
          customerId: ctx.customer.id,
          customerWaId: ctx.customer.wa_id,
          customerName: ctx.customer.display_name,
          reason: input.reason as HandoffReason,
          summary: input.summary,
          priority: input.priority,
        },
      );
      ctx.state.handedOff = true;
      return {
        handed_off: true,
        handoff_id: res.handoffId,
        instruction:
          "In one or two short sentences: include anything you could already answer from tool results, say what the team will check, and that a team member will continue here (during staff hours if they're closed now).",
      };
    },
  }),

  def({
    name: "remember_customer_fact",
    description:
      "Save a durable, useful fact the customer shared, to personalise future chats: their name, child's age, product interests, or a short note (e.g. 'prefers Hebrew'). NEVER store addresses, payment, ID, health or other sensitive data.",
    schema: z.object({
      key: z.enum(["name", "child_age", "interests", "notes"]),
      value: z.string().min(1).max(200),
    }),
    async run(input, ctx) {
      if (/\d{8,}|@|כרטיס|بطاقة|card|ת\.?ז|هوية/i.test(input.value)) return { saved: false, reason: "looks sensitive" };
      // child_age goes stale; expire it after a year.
      await repo.upsertMemory(ctx.db, ctx.customer.id, input.key, input.value, "ai", input.key === "child_age" ? 365 : null);
      return { saved: true };
    },
  }),
];

export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
  return { name: t.name, description: t.description, inputSchema: schema };
});

export interface ToolExecution {
  name: string;
  input: unknown;
  output: unknown;
  success: boolean;
  error: string | null;
  latencyMs: number;
}

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolExecution> {
  const started = Date.now();
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { name, input: rawInput, output: { error: "unknown_tool" }, success: false, error: "unknown tool", latencyMs: 0 };
  ctx.context.failed_verifications ??= [];
  const parsed = (tool.schema as z.ZodType).safeParse(rawInput ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { name, input: rawInput, output: { error: "invalid_input", details: msg }, success: false, error: msg, latencyMs: Date.now() - started };
  }
  try {
    const output = await (tool.run as (i: unknown, c: ToolContext) => Promise<unknown>)(parsed.data, ctx);
    return { name, input: parsed.data, output, success: true, error: null, latencyMs: Date.now() - started };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const kind = (err as { kind?: string }).kind === "unavailable" || /Shopify/.test(msg) ? "store_system_unavailable" : "tool_failed";
    return {
      name,
      input: parsed.data,
      output: { error: kind, hint: "Tell the customer you can't check this right now; offer a human agent. Do not guess." },
      success: false,
      error: msg,
      latencyMs: Date.now() - started,
    };
  }
}

/** The customer's own channel identity matches the order: WhatsApp number, or the sender address for email. */
function ownsOrder(order: OrderDetail, handle: string): boolean {
  const email = emailOf(handle);
  return email ? orderBelongsToEmail(order, email) : orderBelongsToPhone(order, handle);
}
