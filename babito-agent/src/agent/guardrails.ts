/**
 * Deterministic guardrails that run in code, not in the prompt.
 */

const CURRENCY = String.raw`(?:₪|ש"ח|ש״ח|שח|שקל(?:ים)?|شيكل|شيقل|شواقل|شاقل|nis|ils)`;
const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const PRICE_RE = new RegExp(`(?:${CURRENCY}\\s*${NUM})|(?:${NUM}\\s*${CURRENCY})`, "giu");

/** Extract money amounts written next to a shekel marker. */
export function extractPrices(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const raw = m[1] ?? m[2];
    if (raw) out.push(Number(raw.replace(/,/g, "")));
  }
  return out;
}

/** Every number that appears anywhere in tool outputs of this run. */
export function numbersIn(values: unknown[]): Set<number> {
  const set = new Set<number>();
  const text = values.map((v) => JSON.stringify(v ?? "")).join(" ");
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) set.add(Number(m[0]));
  return set;
}

/**
 * Hallucination check for prices: every shekel amount in the reply must equal
 * (to the agora) a number returned by a tool in this run. Computed totals are
 * rejected on purpose — bundle prices must come from Shopify variants.
 * Limitation: bare numbers without a currency marker are not checked.
 */
export function ungroundedPrices(reply: string, toolOutputs: unknown[]): number[] {
  const prices = extractPrices(reply);
  if (prices.length === 0) return [];
  const grounded = [...numbersIn(toolOutputs)];
  return prices.filter((p) => !grounded.some((g) => Math.abs(g - p) < 0.005));
}

const HUMAN_REQUEST = [
  // Arabic
  /(موظف|موظفة|انسان|إنسان|بني ?ادم|حدا من الفريق|خدمة (ال)?(زبائن|عملاء)|بدي احكي مع|بدي أحكي مع|ممثل|مندوب)/,
  // Hebrew
  /(נציג|נציגה|בן אדם|אדם אמיתי|לדבר עם מישהו|שירות לקוחות|מישהו אמיתי)/,
  // English / Arabizi
  /\b(human|agent|representative|real person|customer service|mwazaf|mowazaf)\b/i,
];

/**
 * Fast path: short explicit requests for a person skip the LLM entirely
 * (cheaper, instant, and can't be talked out of it). Longer messages go to the
 * model, which has the handoff tool and decides with full context.
 */
export function isExplicitHumanRequest(text: string): boolean {
  const t = text.trim();
  if (t.length > 60) return false;
  return HUMAN_REQUEST.some((re) => re.test(t));
}
