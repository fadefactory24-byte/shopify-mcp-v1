import { describe, expect, it } from "vitest";
import { extractPrices, isExplicitHumanRequest, ungroundedPrices } from "../src/agent/guardrails.js";
import { businessClock } from "../src/agent/knowledge.js";
import { buildHistory } from "../src/agent/agent.js";
import { orderNameQuery, orderStage, searchCatalog, stripHtml } from "../src/shopify/service.js";
import { normalizePhone, phonesMatch } from "../src/util/phone.js";
import { withRetry } from "../src/util/retry.js";
import { detectLanguage, toWhatsAppText } from "../src/util/text.js";
import { MalformedWebhookError, parseWebhook, verifySignature } from "../src/whatsapp/webhook.js";
import { CATALOG, CHOKING_ID, mediaWebhook, sign, statusWebhook, textWebhook } from "./helpers/fakes.js";

describe("language detection", () => {
  it("detects Arabic", () => expect(detectLanguage("عندكم جهاز منع الاختناق؟")).toBe("ar"));
  it("detects Hebrew", () => expect(detectLanguage("יש משלוח חינם?")).toBe("he"));
  it("mixed Arabic/Hebrew resolves to the dominant script", () => expect(detectLanguage("وين طلبي אחי")).toBe("ar"));
  it("mixed Hebrew-dominant", () => expect(detectLanguage("אחי איפה ההזמנה שלי يا")).toBe("he"));
  it("returns null without signal", () => expect(detectLanguage("#1001 👍")).toBeNull());
  it("English", () => expect(detectLanguage("where is my order")).toBe("en"));
  it("Arabic with Latin product names stays Arabic", () => expect(detectLanguage("شو الفرق بين SkyLift Pro و SkyLift Lite؟")).toBe("ar"));
  it("Hebrew with a Latin brand stays Hebrew", () => expect(detectLanguage("כמה עולה ה-VELORA?")).toBe("he"));
  it("Arabizi with digit letters is Arabic", () => expect(detectLanguage("3andkom 3arabaye 5afife lal baby?")).toBe("ar"));
  it("Arabizi with common words is Arabic", () => expect(detectLanguage("shu fi 3arabiyat? baddi wa7de")).toBe("ar"));
  it("English with a model number stays English", () => expect(detectLanguage("Do you have the SkyLift Pro in grey? order #1001")).toBe("en"));
  it("English asking about a product with specs stays English", () => expect(detectLanguage("Is the camera 32GB or 64GB?")).toBe("en"));
});

describe("phone normalization", () => {
  it.each([
    ["972501234567", "972501234567"],
    ["+972 50-123-4567", "972501234567"],
    ["050-1234567", "972501234567"],
    ["00972501234567", "972501234567"],
    ["+972-0-50-123-4567", "972501234567"],
  ])("%s -> %s", (a, b) => expect(normalizePhone(a)).toBe(b));
  it("rejects garbage", () => expect(normalizePhone("12")).toBeNull());
  it("matches across formats", () => expect(phonesMatch("050-123-4567", "972501234567")).toBe(true));
  it("does not match different numbers", () => expect(phonesMatch("0529999999", "972501234567")).toBe(false));
});

describe("webhook signature", () => {
  const body = JSON.stringify({ a: 1 });
  it("accepts a valid signature", () => expect(verifySignature(body, sign(body, "s3cret"), "s3cret")).toBe(true));
  it("rejects a wrong secret", () => expect(verifySignature(body, sign(body, "other"), "s3cret")).toBe(false));
  it("rejects a missing header", () => expect(verifySignature(body, undefined, "s3cret")).toBe(false));
  it("rejects a tampered body", () => expect(verifySignature(body + " ", sign(body, "s3cret"), "s3cret")).toBe(false));
  it("rejects a non-hex signature of the right length instead of throwing", () =>
    expect(verifySignature(body, `sha256=${"z".repeat(64)}`, "s3cret")).toBe(false));
});

describe("retry", () => {
  const timeout = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });
  it("retries timeouts by default", async () => {
    let n = 0;
    await expect(withRetry(async () => (++n < 2 ? Promise.reject(timeout()) : "ok"), { baseDelayMs: 1 })).resolves.toBe("ok");
    expect(n).toBe(2);
  });
  it("does not retry timeouts when retryNetworkErrors is false (a send may already have been delivered)", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw timeout(); }, { baseDelayMs: 1, retryNetworkErrors: false })).rejects.toThrow("timed out");
    expect(n).toBe(1);
  });
});

describe("webhook parsing", () => {
  it("parses a text message with profile name", () => {
    const p = parseWebhook(textWebhook("972501234567", "שלום", { id: "wamid.X", name: "Dana" }), "PNID");
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({ waMessageId: "wamid.X", from: "972501234567", text: "שלום", profileName: "Dana", type: "text" });
  });
  it("parses media without text", () => {
    const p = parseWebhook(mediaWebhook("972501234567", "audio"), "PNID");
    expect(p.messages[0]).toMatchObject({ type: "audio", text: null, media: { kind: "audio" } });
  });
  it("parses statuses", () => {
    const p = parseWebhook(statusWebhook("wamid.out.1", "delivered"), "PNID");
    expect(p.statuses[0]).toMatchObject({ waMessageId: "wamid.out.1", status: "delivered" });
  });
  it("ignores other phone numbers of the same app", () => {
    const p = parseWebhook(textWebhook("972501234567", "hi", { phoneNumberId: "OTHER" }), "PNID");
    expect(p.messages).toHaveLength(0);
    expect(p.skipped).toBe(1);
  });
  it("throws on malformed payloads", () => {
    expect(() => parseWebhook({ hello: "world" })).toThrow(MalformedWebhookError);
    expect(() => parseWebhook({ object: "page", entry: [] })).toThrow(MalformedWebhookError);
  });
  it("skips malformed items but keeps good ones", () => {
    const p = textWebhook("972501234567", "hi") as any;
    p.entry[0].changes[0].value.messages.push({ nonsense: true });
    const parsed = parseWebhook(p, "PNID");
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.skipped).toBe(1);
  });
});

describe("price guardrail", () => {
  it("extracts shekel amounts in several notations", () => {
    expect(extractPrices('המחיר 299.99 ש"ח')).toEqual([299.99]);
    expect(extractPrices("السعر ₪299.99")).toEqual([299.99]);
    expect(extractPrices("بـ 1,099 شيكل")).toEqual([1099]);
    expect(extractPrices("299.99₪ ו-499.99 ₪")).toEqual([299.99, 499.99]);
    expect(extractPrices("המשלוח 7-14 ימים")).toEqual([]);
  });
  it("flags prices no tool returned", () => {
    expect(ungroundedPrices("السعر 199 شيكل", [{ price: 299.99 }])).toEqual([199]);
  });
  it("accepts grounded prices", () => {
    expect(ungroundedPrices("السعر 299.99 شيكل", [{ variants: [{ price: 299.99 }] }])).toEqual([]);
  });
  it("flags any price when no tool ran", () => {
    expect(ungroundedPrices("₪100", [])).toEqual([100]);
  });
});

describe("human request fast path", () => {
  it.each(["بدي احكي مع موظف", "נציג בבקשה", "human please", "ممكن حدا من الفريق؟"])("detects %s", (t) => expect(isExplicitHumanRequest(t)).toBe(true));
  it.each(["عندكم جهاز منع الاختناق؟", "כמה עולה משלוח?"])("ignores %s", (t) => expect(isExplicitHumanRequest(t)).toBe(false));
  it("leaves long messages to the model", () =>
    expect(isExplicitHumanRequest("شو ساعات عمل خدمة الزبائن تبعتكم لأنه بدي أسأل عن موضوع مهم كثير بخصوص طلب قديم")).toBe(false));
});

describe("catalog search", () => {
  it("finds the anti-choking device from Hebrew keywords", () => {
    expect(searchCatalog(CATALOG, "מכשיר חנק")[0]?.id).toBe(CHOKING_ID);
  });
  it("finds it from English tag synonyms", () => {
    expect(searchCatalog(CATALOG, "anti choking")[0]?.id).toBe(CHOKING_ID);
  });
  it("returns nothing for unrelated queries", () => expect(searchCatalog(CATALOG, "טלוויזיה")).toEqual([]));
  it("finds an untagged product through its description, ranked below title matches", () => {
    const mat = { ...CATALOG[1]!, id: "gid://shopify/Product/1", title: "משטח פעילות לילדים", productType: "", tags: [], handle: "x", description: "רצפה עשויה קצף EVA רך לפינת משחק" };
    expect(searchCatalog([...CATALOG, mat], "רצפה משחק")[0]?.id).toBe(mat.id);
    expect(searchCatalog([...CATALOG, mat], "משטח פעילות")[0]?.id).toBe(mat.id);
  });
});

describe("order helpers", () => {
  const base = { cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", fulfillments: [] };
  it("processing", () => expect(orderStage(base)).toBe("processing"));
  it("cancelled", () => expect(orderStage({ ...base, cancelledAt: "2026-01-01" })).toBe("cancelled"));
  it("awaiting payment", () => expect(orderStage({ ...base, displayFinancialStatus: "PENDING" })).toBe("awaiting_payment"));
  it("shipped", () => expect(orderStage({ ...base, displayFulfillmentStatus: "FULFILLED", fulfillments: [{ displayStatus: "IN_TRANSIT", deliveredAt: null }] })).toBe("shipped"));
  it("delivered", () => expect(orderStage({ ...base, displayFulfillmentStatus: "FULFILLED", fulfillments: [{ displayStatus: "DELIVERED", deliveredAt: "x" }] })).toBe("delivered"));
  it("order name query", () => {
    expect(orderNameQuery("#1001")).toBe("name:#1001 OR name:1001");
    expect(orderNameQuery("طلب رقم 1001")).toBe("name:#1001 OR name:1001");
    expect(orderNameQuery("12")).toBeNull();
    expect(orderNameQuery('1001" OR name:*')).toBe("name:#1001 OR name:1001"); // no query injection
  });
  it("strips policy html", () => expect(stripHtml("<p>א&nbsp;ב</p><br>ג")).toBe("א ב\nג"));
});

describe("formatting & history", () => {
  it("converts markdown to WhatsApp style", () => {
    expect(toWhatsAppText("## כותרת\n**חשוב** [לינק](https://x.com)\n- פריט")).toBe("כותרת\n*חשוב* לינק: https://x.com\n• פריט");
  });
  it("builds alternating history starting with the user and labels staff", () => {
    const row = (direction: "inbound" | "outbound", author: any, body: string) => ({ id: body, conversation_id: "c", customer_id: "u", direction, author, wa_message_id: null, type: "text", body, status: "processed", attempts: 0, error: null, created_at: "" });
    const h = buildHistory([row("outbound", "ai", "hello"), row("inbound", "customer", "a"), row("inbound", "customer", "b"), row("outbound", "human_agent", "hi from staff")]);
    expect(h.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect((h[0]!.content[0] as any).text).toBe("a\nb");
    expect((h[1]!.content[0] as any).text).toContain("[team member wrote]");
  });
  it("business clock respects Israel time", () => {
    const hours = { timezone: "Asia/Jerusalem", days: { sun: ["09:00", "18:00"] as [string, string], sat: null } } as any;
    // 2026-09-27 is a Sunday; 07:00Z = 10:00 Israel (IDT)
    expect(businessClock(hours, new Date("2026-09-27T07:00:00Z")).staffAvailableNow).toBe(true);
    expect(businessClock(hours, new Date("2026-09-26T07:00:00Z")).staffAvailableNow).toBe(false);
  });
});
