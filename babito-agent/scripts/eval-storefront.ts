/**
 * Eval-only ShopifyService backed by the store's PUBLIC storefront JSON
 * (/products.json and /policies/*.json), so `npm run eval` can run on live
 * catalog data before Admin API credentials exist.
 *
 * Same data the bot uses in production: prices, compare-at prices, per-variant
 * availability (= availableForSale), descriptions and legal policies.
 * Orders are not public, so order lookups use two fictional orders that belong
 * to someone else — exactly what the privacy scenarios need.
 */
import { stripHtml, type CatalogItem, type OrderDetail, type ProductDetail, type ShopifyService } from "../src/shopify/service.js";

interface PublicProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  vendor: string;
  product_type: string;
  tags: string[] | string;
  options: { name: string; values: string[] }[];
  variants: { id: number; title: string; price: string; compare_at_price: string | null; available: boolean }[];
}

const FIXTURE_ORDERS: OrderDetail[] = ["#1001", "#1050"].map((name, i) => ({
  id: `gid://shopify/Order/eval${i}`,
  name,
  createdAt: new Date(Date.now() - 5 * 86400_000).toISOString(),
  stage: "processing",
  financialStatus: "PAID",
  fulfillmentStatus: "UNFULFILLED",
  items: [{ name: "מכשיר הצלה למקרי חנק לילדים ולמבוגרים - יחידה", quantity: 1 }],
  tracking: [],
  estimatedDeliveryAt: null,
  deliveredAt: null,
  shippingCity: "חיפה",
  contact: { phones: ["+972501112233"], emails: ["someone.else@example.com"] },
}));

export class PublicStorefrontShopify implements ShopifyService {
  private cache: { at: number; products: PublicProduct[] } | null = null;
  private policies: { type: string; title: string; body: string; url: string }[] | null = null;

  constructor(private readonly baseUrl: string) {}

  private async products(): Promise<PublicProduct[]> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.products;
    const all: PublicProduct[] = [];
    for (let page = 1; page <= 5; page++) {
      const res = await fetch(`${this.baseUrl}/products.json?limit=250&page=${page}`, { headers: { "user-agent": "babito-agent-eval" } });
      if (!res.ok) throw new Error(`Shopify storefront ${res.status}`);
      const batch = ((await res.json()) as { products: PublicProduct[] }).products;
      all.push(...batch);
      if (batch.length < 250) break;
    }
    this.cache = { at: Date.now(), products: all };
    return all;
  }

  async listCatalog(): Promise<CatalogItem[]> {
    return (await this.products()).map((p) => {
      const prices = p.variants.map((v) => Number(v.price));
      const compare = p.variants.map((v) => Number(v.compare_at_price ?? 0)).filter((n) => n > 0);
      return {
        id: `gid://shopify/Product/${p.id}`,
        title: p.title,
        handle: p.handle,
        productType: p.product_type ?? "",
        vendor: p.vendor ?? "",
        tags: Array.isArray(p.tags) ? p.tags : String(p.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
        url: `${this.baseUrl}/products/${p.handle}`,
        priceMin: Math.min(...prices),
        priceMax: Math.max(...prices),
        compareAtMax: compare.length ? Math.max(...compare) : null,
        currency: "ILS",
      };
    });
  }

  async getProduct(id: string): Promise<ProductDetail | null> {
    const numeric = Number(id.split("/").pop());
    const p = (await this.products()).find((x) => x.id === numeric);
    if (!p) return null;
    return {
      id,
      title: p.title,
      description: stripHtml(p.body_html ?? "").slice(0, 700),
      productType: p.product_type ?? "",
      url: `${this.baseUrl}/products/${p.handle}`,
      active: true, // /products.json only lists published products
      options: (p.options ?? []).filter((o) => o.name !== "Title").map((o) => ({ name: o.name, values: o.values })),
      variants: p.variants.map((v) => ({
        id: `gid://shopify/ProductVariant/${v.id}`,
        title: v.title,
        price: Number(v.price),
        compareAtPrice: v.compare_at_price ? Number(v.compare_at_price) : null,
        available: Boolean(v.available),
      })),
    };
  }

  async findOrderByName(orderNumber: string): Promise<OrderDetail | null> {
    const digits = orderNumber.replace(/\D/g, "");
    return FIXTURE_ORDERS.find((o) => o.name.replace(/\D/g, "") === digits) ?? null;
  }

  async findOrdersByPhone(): Promise<null> {
    return null; // eval customers use fictional numbers
  }

  async getPolicies() {
    if (this.policies) return this.policies;
    const out: { type: string; title: string; body: string; url: string }[] = [];
    for (const handle of ["refund-policy", "shipping-policy", "terms-of-service"]) {
      const res = await fetch(`${this.baseUrl}/policies/${handle}.json`, { headers: { "user-agent": "babito-agent-eval" } });
      if (!res.ok) continue;
      const { policy } = (await res.json()) as { policy: { title: string; body: string } };
      out.push({ type: handle === "terms-of-service" ? "terms_of_service" : handle.replace("-", "_"), title: policy.title, body: stripHtml(policy.body), url: `${this.baseUrl}/policies/${handle}` });
    }
    this.policies = out;
    return out;
  }
}
