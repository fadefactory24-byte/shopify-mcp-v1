import { normalizePhone, phonesMatch } from "../util/phone.js";
import type { ShopifyGraphQLClient } from "./client.js";
import { CATALOG_QUERY, CUSTOMER_BY_EMAIL_QUERY, CUSTOMER_BY_PHONE_QUERY, ORDER_BY_NAME_QUERY, POLICIES_QUERY, PRODUCT_QUERY } from "./queries.js";

// ----------------------------------------------------------------------------- types

export interface CatalogItem {
  id: string;
  title: string;
  handle: string;
  productType: string;
  vendor: string;
  tags: string[];
  /** Plain-text start of the description; used for search ranking only (29 of 42 products have no tags). */
  description?: string;
  url: string;
  priceMin: number;
  priceMax: number;
  compareAtMax: number | null;
  currency: string;
  /** Any variant sellable; null when unknown (only the first variants are checked). */
  available?: boolean | null;
}

export interface ProductDetail {
  id: string;
  title: string;
  description: string;
  productType: string;
  url: string;
  active: boolean;
  options: { name: string; values: string[] }[];
  variants: {
    id: string;
    title: string;
    price: number;
    compareAtPrice: number | null;
    /** Shopify's own sellability flag (respects "continue selling when out of stock"). */
    available: boolean;
  }[];
}

export type OrderStage = "cancelled" | "awaiting_payment" | "refunded" | "processing" | "partially_shipped" | "shipped" | "delivered";

export interface OrderDetail {
  id: string;
  name: string;
  createdAt: string;
  stage: OrderStage;
  financialStatus: string;
  fulfillmentStatus: string;
  items: { name: string; quantity: number }[];
  tracking: { company: string | null; number: string | null; url: string | null }[];
  estimatedDeliveryAt: string | null;
  deliveredAt: string | null;
  shippingCity: string | null;
  /** Contact data used ONLY for ownership verification; never sent to the model. */
  contact: { phones: string[]; emails: string[] };
}

export interface ShopifyService {
  listCatalog(): Promise<CatalogItem[]>;
  getProduct(id: string): Promise<ProductDetail | null>;
  findOrderByName(orderNumber: string): Promise<OrderDetail | null>;
  findOrdersByPhone(phoneDigits: string): Promise<{ customerId: string; firstName: string | null; orders: OrderDetail[] } | null>;
  findOrdersByEmail(email: string): Promise<{ customerId: string; firstName: string | null; orders: OrderDetail[] } | null>;
  getPolicies(): Promise<{ type: string; title: string; body: string; url: string }[]>;
}

// ------------------------------------------------------------------ pure helpers

export function orderStage(o: {
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  fulfillments: { displayStatus: string | null; deliveredAt: string | null }[];
}): OrderStage {
  if (o.cancelledAt) return "cancelled";
  const fin = o.displayFinancialStatus ?? "";
  if (fin === "REFUNDED") return "refunded";
  if (["PENDING", "AUTHORIZED", "EXPIRED"].includes(fin) && (o.displayFulfillmentStatus ?? "UNFULFILLED") === "UNFULFILLED") return "awaiting_payment";
  if (o.fulfillments.length > 0 && o.fulfillments.every((f) => f.displayStatus === "DELIVERED" || f.deliveredAt)) return "delivered";
  switch (o.displayFulfillmentStatus) {
    case "FULFILLED":
      return "shipped";
    case "PARTIALLY_FULFILLED":
      return "partially_shipped";
    default:
      return "processing";
  }
}

/**
 * Product-level availability from the first variants' availableForSale flags. If none of those is
 * sellable but the product has more variants than were fetched, we don't know: null.
 */
export function catalogAvailability(flags: boolean[], variantCount: number): boolean | null {
  if (flags.some(Boolean)) return true;
  return variantCount > flags.length ? null : false;
}

/** "#1001", "1001", "הזמנה 1001" -> Shopify search query for the order name (default "#1001" format). */
export function orderNameQuery(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 12) return null;
  return `name:#${digits} OR name:${digits}`;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/**
 * Local relevance scoring over the (small) live catalog. Shopify's own search
 * tokenizes Hebrew/Arabic inconsistently, and the catalog is < 100 products,
 * so we fetch it (cached ~60s) and rank locally. The model is instructed to
 * send Hebrew keywords (product titles are Hebrew) plus English synonyms.
 */
export function searchCatalog(items: CatalogItem[], query: string, limit = 5): CatalogItem[] {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[֑-ׇ]/g, "") // Hebrew niqqud
      .replace(/[׳'"״]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ");
  const terms = norm(query)
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return [];
  const scored = items.map((item) => {
    const title = norm(item.title);
    const meta = norm([item.productType, item.tags.join(" "), item.handle.replace(/-/g, " "), item.vendor].join(" "));
    const desc = norm(item.description ?? "");
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 3;
      else if (meta.includes(t)) score += 2;
      else if (t.length >= 4 && (title.includes(t.slice(0, -1)) || meta.includes(t.slice(0, -1)))) score += 1; // crude plural/suffix tolerance
      else if (t.length >= 3 && desc.includes(t)) score += 1; // untagged products are often only findable by their description
    }
    return { item, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}

// -------------------------------------------------------------- implementation

interface RawOrder {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  phone: string | null;
  email: string | null;
  customer: { id: string; defaultPhoneNumber: { phoneNumber: string } | null; defaultEmailAddress: { emailAddress: string } | null } | null;
  shippingAddress: { city: string | null; phone: string | null } | null;
  billingAddress: { phone: string | null } | null;
  lineItems: { nodes: { name: string; quantity: number }[] };
  fulfillments: {
    status: string;
    displayStatus: string | null;
    deliveredAt: string | null;
    estimatedDeliveryAt: string | null;
    trackingInfo: { company: string | null; number: string | null; url: string | null }[];
  }[];
}

function mapOrder(o: RawOrder): OrderDetail {
  const phones = [o.phone, o.customer?.defaultPhoneNumber?.phoneNumber, o.shippingAddress?.phone, o.billingAddress?.phone].filter(
    (p): p is string => Boolean(p),
  );
  const emails = [o.email, o.customer?.defaultEmailAddress?.emailAddress].filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase());
  const eta = o.fulfillments.map((f) => f.estimatedDeliveryAt).filter(Boolean).sort().pop() ?? null;
  const delivered = o.fulfillments.map((f) => f.deliveredAt).filter(Boolean).sort().pop() ?? null;
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    stage: orderStage(o),
    financialStatus: o.displayFinancialStatus ?? "",
    fulfillmentStatus: o.displayFulfillmentStatus ?? "",
    items: o.lineItems.nodes.map((l) => ({ name: l.name, quantity: l.quantity })),
    tracking: o.fulfillments.flatMap((f) => f.trackingInfo),
    estimatedDeliveryAt: eta,
    deliveredAt: delivered,
    shippingCity: o.shippingAddress?.city ?? null,
    contact: { phones, emails },
  };
}

export function orderBelongsToPhone(order: OrderDetail, phoneDigits: string): boolean {
  return order.contact.phones.some((p) => phonesMatch(p, phoneDigits));
}

export function orderBelongsToEmail(order: OrderDetail, email: string): boolean {
  const e = email.trim().toLowerCase();
  return e.length > 3 && order.contact.emails.includes(e);
}

export class LiveShopifyService implements ShopifyService {
  private catalogCache: { at: number; items: CatalogItem[] } | null = null;
  private policyCache: { at: number; items: { type: string; title: string; body: string; url: string }[] } | null = null;

  constructor(
    private readonly client: ShopifyGraphQLClient,
    private readonly opts: { storePublicUrl: string; catalogTtlMs?: number; policyTtlMs?: number },
  ) {}

  async listCatalog(): Promise<CatalogItem[]> {
    const ttl = this.opts.catalogTtlMs ?? 60_000;
    if (this.catalogCache && Date.now() - this.catalogCache.at < ttl) return this.catalogCache.items;
    const items: CatalogItem[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const data: any = await this.client.query(CATALOG_QUERY, { after });
      for (const p of data.products.nodes) {
        items.push({
          id: p.id,
          title: p.title,
          handle: p.handle,
          productType: p.productType ?? "",
          vendor: p.vendor ?? "",
          tags: p.tags ?? [],
          description: p.description ?? "",
          url: p.onlineStoreUrl ?? `${this.opts.storePublicUrl}/products/${p.handle}`,
          priceMin: Number(p.priceRangeV2.minVariantPrice.amount),
          priceMax: Number(p.priceRangeV2.maxVariantPrice.amount),
          compareAtMax: p.compareAtPriceRange?.maxVariantCompareAtPrice ? Number(p.compareAtPriceRange.maxVariantCompareAtPrice.amount) : null,
          currency: p.priceRangeV2.minVariantPrice.currencyCode,
          available: catalogAvailability(
            (p.variants?.nodes ?? []).map((v: any) => Boolean(v.availableForSale)),
            p.variantsCount?.count ?? p.variants?.nodes?.length ?? 0,
          ),
        });
      }
      if (!data.products.pageInfo.hasNextPage) break;
      after = data.products.pageInfo.endCursor;
    }
    this.catalogCache = { at: Date.now(), items };
    return items;
  }

  async getProduct(id: string): Promise<ProductDetail | null> {
    const data: any = await this.client.query(PRODUCT_QUERY, { id });
    const p = data.product;
    if (!p) return null;
    return {
      id: p.id,
      title: p.title,
      description: (p.description ?? "").slice(0, 700),
      productType: p.productType ?? "",
      url: p.onlineStoreUrl ?? `${this.opts.storePublicUrl}/products/${p.handle}`,
      active: p.status === "ACTIVE",
      options: (p.options ?? []).filter((o: any) => o.name !== "Title"),
      variants: p.variants.nodes.map((v: any) => ({
        id: v.id,
        title: v.title,
        price: Number(v.price),
        compareAtPrice: v.compareAtPrice ? Number(v.compareAtPrice) : null,
        available: Boolean(v.availableForSale),
      })),
    };
  }

  async findOrderByName(orderNumber: string): Promise<OrderDetail | null> {
    const q = orderNameQuery(orderNumber);
    if (!q) return null;
    const data: any = await this.client.query(ORDER_BY_NAME_QUERY, { q });
    const wanted = orderNumber.replace(/\D/g, "");
    const match = (data.orders.nodes as RawOrder[]).find((o) => o.name.replace(/\D/g, "") === wanted);
    return match ? mapOrder(match) : null;
  }

  async findOrdersByPhone(phoneDigits: string) {
    const digits = normalizePhone(phoneDigits);
    if (!digits) return null;
    const data: any = await this.client.query(CUSTOMER_BY_PHONE_QUERY, { q: `phone:+${digits}` });
    // Shopify phone search is fuzzy; confirm the match ourselves.
    const customer = (data.customers.nodes as any[]).find((c) => phonesMatch(c.defaultPhoneNumber?.phoneNumber, digits));
    if (!customer) return null;
    return {
      customerId: customer.id as string,
      firstName: (customer.firstName as string | null) ?? null,
      orders: (customer.orders.nodes as RawOrder[]).map(mapOrder),
    };
  }

  async findOrdersByEmail(email: string) {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@"]+@[^\s@"]+\.[^\s@"]+$/.test(e)) return null;
    const data: any = await this.client.query(CUSTOMER_BY_EMAIL_QUERY, { q: `email:"${e}"` });
    // Shopify search is fuzzy; require the exact address.
    const customer = (data.customers.nodes as any[]).find((c) => String(c.defaultEmailAddress?.emailAddress ?? "").toLowerCase() === e);
    if (!customer) return null;
    return {
      customerId: customer.id as string,
      firstName: (customer.firstName as string | null) ?? null,
      orders: (customer.orders.nodes as RawOrder[]).map(mapOrder),
    };
  }

  async getPolicies() {
    const ttl = this.opts.policyTtlMs ?? 10 * 60_000;
    if (this.policyCache && Date.now() - this.policyCache.at < ttl) return this.policyCache.items;
    const data: any = await this.client.query(POLICIES_QUERY);
    const items = (data.shop.shopPolicies as any[]).map((p) => ({
      type: String(p.type).toLowerCase(),
      title: p.title as string,
      body: stripHtml(p.body ?? ""),
      url: p.url as string,
    }));
    this.policyCache = { at: Date.now(), items };
    return items;
  }
}
