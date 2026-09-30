import type { Db } from "../db/client.js";
import { repo, type KbArticle } from "../db/repo.js";
import type { ShopifyService } from "../shopify/service.js";
import { truncate } from "../util/text.js";

/** Shopify legal policies exposed as virtual knowledge keys (read live, cached briefly). */
const POLICY_KEYS: Record<string, { type: string; title: string }> = {
  "policy.refund": { type: "refund_policy", title: "Returns & refunds policy (Shopify, Hebrew)" },
  "policy.shipping": { type: "shipping_policy", title: "Shipping policy: delivery times & methods (Shopify, Hebrew)" },
  "policy.terms": { type: "terms_of_service", title: "Terms of service (Shopify, Hebrew)" },
};

export interface Settings {
  botEnabled: boolean;
  personaNotes: string;
  /** Owner's business rules (settings.store_rules). Kept in the database so they never land in the public repo. */
  storeRules: string;
  /** Active rules added from the dashboard after real mistakes (settings.learned_rules), one per line. */
  learnedRules: string;
  businessHours: { timezone: string; days: Record<string, [string, string] | null> } | null;
  handoffExpectation: Record<string, string>;
  unsupportedMediaReply: Record<string, string>;
  /** Reply to a photo/video/document without text: we can't see it, so ask what it's about. */
  mediaReceivedReply: Record<string, string>;
}

export interface LearnedRule {
  id: string;
  text: string;
  at: string;
  active: boolean;
}

/** settings.learned_rules is a JSON array; tolerate anything malformed by ignoring it. */
export function parseLearnedRules(raw: unknown): LearnedRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is LearnedRule => Boolean(r) && typeof r.id === "string" && typeof r.text === "string" && r.text.trim() !== "" && typeof r.at === "string" && typeof r.active === "boolean",
  );
}

export function activeLearnedRules(raw: unknown): LearnedRule[] {
  return parseLearnedRules(raw).filter((r) => r.active);
}

const DEFAULT_HANDOFF: Record<string, string> = {
  ar: "راح يرد عليك حدا من الفريق بأقرب وقت.",
  he: "נציג מהצוות יחזור אלייך בהקדם.",
  en: "Someone from our team will get back to you shortly.",
};

/**
 * Knowledge base + runtime settings, cached for `ttlMs` so edits in Supabase
 * apply within a minute without redeploying.
 */
export class KnowledgeService {
  private kbCache: { at: number; items: KbArticle[] } | null = null;
  private settingsCache: { at: number; value: Settings } | null = null;

  constructor(
    private readonly db: Db,
    private readonly shopify: ShopifyService,
    private readonly ttlMs = 60_000,
  ) {}

  invalidate() {
    this.kbCache = null;
    this.settingsCache = null;
  }

  async articles(): Promise<KbArticle[]> {
    if (this.kbCache && Date.now() - this.kbCache.at < this.ttlMs) return this.kbCache.items;
    const items = await repo.activeKb(this.db);
    this.kbCache = { at: Date.now(), items };
    return items;
  }

  /** Compact index (key: title) injected into the prompt so the model knows what it can fetch. */
  async index(): Promise<string> {
    const lines = Object.entries(POLICY_KEYS).map(([k, v]) => `- ${k}: ${v.title}`);
    for (const a of await this.articles()) if (a.product_ids.length === 0) lines.push(`- ${a.key}: ${a.title}`);
    return lines.join("\n");
  }

  async get(keys: string[]): Promise<{ key: string; title: string; content: string; source: string }[]> {
    const out: { key: string; title: string; content: string; source: string }[] = [];
    const articles = await this.articles();
    for (const key of keys.slice(0, 4)) {
      const pol = POLICY_KEYS[key];
      if (pol) {
        const policies = await this.shopify.getPolicies();
        const p = policies.find((x) => x.type === pol.type);
        if (p) out.push({ key, title: p.title, content: truncate(p.body, 3000), source: p.url });
        continue;
      }
      const a = articles.find((x) => x.key === key);
      if (a) out.push({ key, title: a.title, content: a.content, source: "kb" });
    }
    return out;
  }

  async productNotes(productId: string): Promise<string[]> {
    return (await this.articles()).filter((a) => a.product_ids.includes(productId)).map((a) => a.content);
  }

  async settings(): Promise<Settings> {
    if (this.settingsCache && Date.now() - this.settingsCache.at < this.ttlMs) return this.settingsCache.value;
    const raw = await repo.allSettings(this.db);
    const value: Settings = {
      botEnabled: raw.bot_enabled !== false,
      personaNotes: typeof raw.persona_notes === "string" ? raw.persona_notes : "",
      storeRules: typeof raw.store_rules === "string" ? raw.store_rules : "",
      learnedRules: activeLearnedRules(raw.learned_rules).map((r) => `- ${r.text}`).join("\n"),
      businessHours: (raw.business_hours as Settings["businessHours"]) ?? null,
      handoffExpectation: { ...DEFAULT_HANDOFF, ...((raw.handoff_expectation as Record<string, string>) ?? {}) },
      unsupportedMediaReply: (raw.unsupported_media_reply as Record<string, string>) ?? {
        ar: "حالياً بقدر أساعدك بالرسائل المكتوبة بس.",
        he: "כרגע אפשר לעזור רק בהודעות כתובות.",
        en: "For now I can only help with text messages.",
      },
      mediaReceivedReply: (raw.media_received_reply as Record<string, string>) ?? {
        ar: "وصلنا الملف. عشان نقدر نساعد، اكتبولنا شو الموضوع، وإذا بخص طلبية ابعتوا كمان رقم الطلبية.",
        he: "קיבלנו את הקובץ. כדי שנוכל לעזור, כתבו במה מדובר, ואם זה קשור להזמנה גם את מספר ההזמנה.",
        en: "Got it. To help, please write what it's about, and the order number if it's about an order.",
      },
    };
    this.settingsCache = { at: Date.now(), value };
    return value;
  }
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Local time + whether staff are available, in the store timezone. */
export function businessClock(hours: Settings["businessHours"], now = new Date()) {
  const tz = hours?.timezone ?? "Asia/Jerusalem";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday").toLowerCase().slice(0, 3);
  const hhmm = `${get("hour")}:${get("minute")}`;
  const today = hours?.days?.[weekday];
  const open = Boolean(today && hhmm >= today[0] && hhmm < today[1]);
  const idx = DAY_KEYS.indexOf(weekday as (typeof DAY_KEYS)[number]);
  return { local: `${get("year")}-${get("month")}-${get("day")} ${hhmm} (${weekday})`, staffAvailableNow: open, dayIndex: idx };
}
