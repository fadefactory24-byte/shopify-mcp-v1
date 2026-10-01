import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { StaffNotifier } from "../src/pipeline/handoff.js";
import { GraphMailClient } from "../src/email/graph.js";
import { skipReason } from "../src/email/channel.js";
import { extractPrices, isExplicitHumanRequest, ungroundedPrices } from "../src/agent/guardrails.js";
import { businessClock } from "../src/agent/knowledge.js";
import { buildHistory } from "../src/agent/agent.js";
import { catalogAvailability, orderNameQuery, orderStage, searchCatalog, stripHtml } from "../src/shopify/service.js";
import { normalizePhone, phonesMatch } from "../src/util/phone.js";
import { carrierFromTrackingUrl, mapTrackingStatus } from "../src/tracking/tracking.js";
import { withRetry } from "../src/util/retry.js";
import { detectLanguage, toWhatsAppText } from "../src/util/text.js";
import { MalformedWebhookError, parseWebhook, verifySignature } from "../src/whatsapp/webhook.js";
import { MalformedSocialWebhookError, parseSocialWebhook, socialHandle } from "../src/social/webhook.js";
import { CATALOG, CHOKING_ID, mediaWebhook, sign, socialWebhook, statusWebhook, textWebhook } from "./helpers/fakes.js";

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

describe("social webhook parsing (Messenger/Instagram)", () => {
  it("parses a Messenger text message into the shared InboundMessage shape", () => {
    const p = parseSocialWebhook(socialWebhook("page", "PSID1", { text: "שלום", id: "mid.1" }));
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({ waMessageId: "mid.1", from: "psid:PSID1", text: "שלום", type: "text", profileName: null });
  });
  it("parses an Instagram image attachment, mapping type and carrying the direct url", () => {
    const p = parseSocialWebhook(socialWebhook("instagram", "IGSID1", { attachment: { type: "image", url: "https://x/img.jpg" } }));
    expect(p.messages[0]).toMatchObject({ from: "igsid:IGSID1", type: "image", media: { kind: "image", url: "https://x/img.jpg" } });
  });
  it("treats an echo as a staff reply, not an inbound customer message", () => {
    const p = parseSocialWebhook(socialWebhook("page", "PSID1", { text: "handled", isEcho: true, id: "mid.echo" }));
    expect(p.messages).toHaveLength(0);
    expect(p.echoes).toEqual([{ waMessageId: "mid.echo", to: "psid:PSID1", text: "handled" }]);
  });
  it("never surfaces a message older than maxAgeMs, and counts it as skipped", () => {
    const p = parseSocialWebhook(socialWebhook("page", "PSID1", { text: "old", ageMs: 8 * 24 * 3600_000 }));
    expect(p.messages).toHaveLength(0);
    expect(p.skipped).toBe(1);
  });
  it("skips a deleted message", () => {
    const p = parseSocialWebhook(socialWebhook("page", "PSID1", { text: "oops", isDeleted: true }));
    expect(p.messages).toHaveLength(0);
    expect(p.skipped).toBe(1);
  });
  it("skips entries for a different page/IG account when expectedPageId/expectedIgId is set", () => {
    const p = parseSocialWebhook(socialWebhook("page", "PSID1", { text: "hi", recipientId: "OTHER_PAGE" }), { expectedPageId: "PAGE_ID" });
    expect(p.messages).toHaveLength(0);
    expect(p.skipped).toBe(1);
  });
  it("throws MalformedSocialWebhookError on a payload that isn't a page/instagram messaging shape", () => {
    expect(() => parseSocialWebhook({ hello: "world" })).toThrow(MalformedSocialWebhookError);
    expect(() => parseSocialWebhook({ object: "whatsapp_business_account", entry: [] })).toThrow(MalformedSocialWebhookError);
  });
  it("socialHandle round-trips the platform prefix", () => {
    expect(socialHandle("messenger", "1")).toBe("psid:1");
    expect(socialHandle("instagram", "1")).toBe("igsid:1");
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

describe("live tracking stages", () => {
  it.each([
    ["NotFound", "NotFound_Other", "no_update_yet"],
    ["InfoReceived", "InfoReceived", "label_created"],
    ["InTransit", "InTransit_Departure", "in_transit"],
    ["InTransit", "InTransit_Arrival", "final_leg"],
    ["InTransit", "InTransit_CustomsProcessing", "final_leg"],
    ["InTransit", "InTransit_CustomsRequiringInformation", "needs_attention"],
    ["OutForDelivery", "OutForDelivery_Other", "out_for_delivery"],
    ["AvailableForPickup", "AvailableForPickup_Other", "available_for_pickup"],
    ["Delivered", "Delivered_Other", "delivered"],
    ["DeliveryFailure", "DeliveryFailure_InvalidAddress", "delivery_failed"],
    ["Exception", "Exception_Delayed", "delayed"],
    ["Exception", "Exception_Returned", "returning"],
    ["Exception", "Exception_Lost", "needs_attention"],
    ["Expired", "Expired_Other", "no_recent_updates"],
  ])("%s / %s -> %s", (status, sub, stage) => expect(mapTrackingStatus(status, sub)).toBe(stage));
  it("reads the carrier code from a 17track link only", () => {
    expect(carrierFromTrackingUrl("https://www.17track.net/en/track?nums=UL547537780YP&fc=190012")).toBe(190012);
    expect(carrierFromTrackingUrl("https://www.purolator.com/track?pin=X&fc=5")).toBeUndefined();
    expect(carrierFromTrackingUrl(null)).toBeUndefined();
  });
});

describe("catalog availability", () => {
  it("available if any fetched variant is sellable", () => expect(catalogAvailability([false, true], 2)).toBe(true));
  it("sold out when every variant was checked", () => expect(catalogAvailability([false, false], 2)).toBe(false));
  it("unknown when unchecked variants remain", () => expect(catalogAvailability(Array(15).fill(false), 90)).toBeNull());
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
  it("never sends the long dash: ranges get a hyphen, clauses a comma, list dashes become bullets", () => {
    expect(toWhatsAppText("משלוח 4–10 ימי עסקים — חינם לנקודת איסוף")).toBe("משלוח 4-10 ימי עסקים, חינם לנקודת איסוף");
    expect(toWhatsAppText("— מחמם בקבוקים\n– כרית")).toBe("• מחמם בקבוקים\n• כרית");
    expect(toWhatsAppText("המחיר 299.99 ₪ — .")).toBe("המחיר 299.99 ₪.");
    expect(toWhatsAppText("https://mybabito.com/products/עגלת-תינוק-3-ב-1")).toBe("https://mybabito.com/products/עגלת-תינוק-3-ב-1");
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

describe("staff email alerts", () => {
  const log = { warn: () => {}, info: () => {}, error: () => {} } as any;
  const whatsapp = { sendText: async () => ({ waMessageId: "x" }) } as any;
  function setup() {
    const sent: { subject: string; text: string; key?: string }[] = [];
    const email = { send: async (subject: string, text: string, key?: string) => void sent.push({ subject, text, key }) } as any;
    let now = 1_000_000;
    const n = new StaffNotifier({ webhookUrl: "", staffNumbers: [], whatsapp, adminBaseUrl: "https://bot.example", email, log, now: () => now });
    return { n, sent, tick: (ms: number) => (now += ms) };
  }

  it("handoff sends no email (WhatsApp-only channel), even with email configured", async () => {
    const { n, sent } = setup();
    await n.notify({ handoffId: "h1", conversationId: "c1", customerWaId: "972501234567", customerName: "Dana", reason: "complaint", priority: "high", summary: "arrived broken", orderName: "#1374" });
    expect(sent).toHaveLength(0);
  });

  it("customer-waiting and system alerts are throttled", async () => {
    const { n, sent, tick } = setup();
    const w = { conversationId: "c1", customerWaId: "972501234567", customerName: null, text: "hello?" };
    await n.customerWaiting(w);
    await n.customerWaiting(w);
    await n.customerWaiting({ ...w, conversationId: "c2" });
    expect(sent.map((s) => s.subject)).toEqual(["[BABITO] Customer waiting for staff: +972501234567", "[BABITO] Customer waiting for staff: +972501234567"]);
    tick(31 * 60_000);
    await n.customerWaiting(w);
    expect(sent).toHaveLength(3);
    await n.systemAlert("WhatsApp send failed", "boom");
    await n.systemAlert("WhatsApp send failed", "boom again");
    expect(sent.filter((s) => s.subject.includes("System alert"))).toHaveLength(1);
  });

  it("handoff with a configured template sends via sendTemplate instead of plain text, sanitizing params", async () => {
    const templateSends: { to: string; template: string; language: string; bodyParams: string[] }[] = [];
    const wa = {
      sendText: async () => ({ waMessageId: "should-not-be-called" }),
      sendTemplate: async (to: string, template: string, language: string, bodyParams: string[]) => {
        templateSends.push({ to, template, language, bodyParams });
        return { waMessageId: "wamid.tpl" };
      },
    } as any;
    const n = new StaffNotifier({
      webhookUrl: "",
      staffNumbers: ["972507406322"],
      whatsapp: wa,
      email: null,
      handoffTemplate: { name: "babito_staff_handoff", language: "en" },
      log,
    });
    await n.notify({
      handoffId: "h2",
      conversationId: "c2",
      customerWaId: "972501234567",
      customerName: "Dana",
      reason: "complaint",
      priority: "high",
      summary: "The\nstroller wheel\n\nis broken",
      orderName: "#1042",
    });
    expect(templateSends).toEqual([
      { to: "972507406322", template: "babito_staff_handoff", language: "en", bodyParams: ["Dana +972501234567 (عبر واتساب البوت: الرد من داشبورد البوت (admin))", "complaint | Order #1042", "The stroller wheel is broken"] },
    ]);
  });

  it("handoff falls back to plain sendText when no template is configured, or the sender lacks sendTemplate", async () => {
    const sent: { to: string; body: string }[] = [];
    const wa = { sendText: async (to: string, body: string) => (sent.push({ to, body }), { waMessageId: "x" }) } as any;
    const n = new StaffNotifier({ webhookUrl: "", staffNumbers: ["972507406322"], whatsapp: wa, email: null, log });
    await n.notify({ handoffId: "h3", conversationId: "c3", customerWaId: "972501234567", customerName: "Dana", reason: "complaint", priority: "normal", summary: "x" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("972507406322");
  });
});

describe("email channel units", () => {
  it("handoff on an email conversation flags the customer's email in Outlook", async () => {
    const flagged: string[] = [];
    const n = new StaffNotifier({ webhookUrl: "", staffNumbers: [], whatsapp: { sendText: async () => ({ waMessageId: "x" }) } as any, email: null, flagEmail: async (h) => void flagged.push(h), log: { warn() {}, info() {}, error() {} } as any });
    await n.notify({ handoffId: "h", conversationId: "c", customerWaId: "email:dana@example.com", customerName: "Dana", reason: "complaint", priority: "normal", summary: "x" });
    expect(flagged).toEqual(["email:dana@example.com"]);
  });

  it("skipReason: customers pass, automated mail is skipped", () => {
    const base = { id: "1", conversationId: null, subject: "שאלה", fromAddress: "dana@example.com", fromName: null, receivedAt: "", text: "hi", hasAttachments: false, headers: {} };
    expect(skipReason(base, "support@mybabito.com")).toBeNull();
    expect(skipReason({ ...base, fromAddress: "support@mybabito.com" }, "support@mybabito.com")).toBe("own_mailbox");
    expect(skipReason({ ...base, fromAddress: "mailer-daemon@x.com" }, "s@x")).toBe("automated_sender");
    expect(skipReason({ ...base, fromAddress: "a@mail.facebookmail.com" }, "s@x")).toBe("platform_sender");
    expect(skipReason({ ...base, headers: { precedence: "bulk" } }, "s@x")).toBe("bulk");
    expect(skipReason({ ...base, subject: "Out of Office: hi" }, "s@x")).toBe("auto_reply_subject");
  });

  it("GraphMailClient: refreshes once, persists the rotated token, replies via createReply + send with immutable ids", async () => {
    const saved: string[] = [];
    const calls: { url: string; method: string; prefer: string | null; body?: string }[] = [];
    const client = new GraphMailClient({
      clientId: "cid",
      tenant: "organizations",
      seedRefreshToken: "seed-rt",
      store: { load: async () => saved.at(-1) ?? null, save: async (t) => void saved.push(t) },
      fetchImpl: (async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        calls.push({ url, method: init.method ?? "GET", prefer: headers.get("prefer"), body: typeof init.body === "string" ? init.body : String(init.body ?? "") });
        if (url.includes("/oauth2/v2.0/token")) return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt-2", expires_in: 3600 }), { status: 200 });
        if (url.endsWith("/createReply")) return new Response(JSON.stringify({ id: "draft-1" }), { status: 201 });
        return new Response(null, { status: 202 });
      }) as any,
    });
    expect(await client.reply("msg-1", "hello")).toBe("draft-1");
    await client.sendMail(["support@mybabito.com"], "S", "T");
    expect(calls.filter((c) => c.url.includes("/token"))).toHaveLength(1);
    expect(calls[0]!.body).toContain("refresh_token=seed-rt");
    expect(saved).toEqual(["rt-2"]);
    expect(calls[1]!.url).toBe("https://graph.microsoft.com/v1.0/me/messages/msg-1/createReply");
    expect(calls[1]!.prefer).toContain('IdType="ImmutableId"');
    expect(JSON.parse(calls[1]!.body!)).toEqual({ message: { body: { contentType: "Text", content: "hello" } } });
    expect(calls[2]!.url).toBe("https://graph.microsoft.com/v1.0/me/messages/draft-1/send");
    expect(JSON.parse(calls[3]!.body!).saveToSentItems).toBe(false);
  });
});

describe("migration runner (scripts/migrate.ts, POST /cron/migrate)", () => {
  async function blankDb(): Promise<Db & { close(): Promise<void> }> {
    const pg = new PGlite();
    return {
      query: async <T>(text: string, params?: unknown[]) => ({ rows: (await pg.query<T>(text, params as any[])).rows }),
      tx<T>(fn: (d: Db) => Promise<T>) {
        return pg.transaction(async (t) => {
          const inner: Db = { query: async <R>(text: string, params?: unknown[]) => ({ rows: (await t.query<R>(text, params as any[])).rows }), tx: (f) => f(inner), close: async () => {} };
          return fn(inner);
        }) as Promise<T>;
      },
      close: () => pg.close(),
    };
  }

  it("applies pending files in filename order, tracks them, and skips them on the next run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babito-migrate-"));
    const db = await blankDb();
    try {
      await writeFile(join(dir, "0001_a.sql"), `create table widgets (id int primary key);`);
      await writeFile(join(dir, "0002_b.sql"), `insert into widgets (id) values (1);`);
      const first = await runMigrations(db, dir);
      expect(first.applied).toEqual(["0001_a.sql", "0002_b.sql"]);
      expect((await db.query<{ id: number }>(`select id from widgets`)).rows).toEqual([{ id: 1 }]);

      const second = await runMigrations(db, dir);
      expect(second.applied).toEqual([]); // already tracked in app_migrations

      // A new file added later is picked up; the earlier ones are not re-run.
      await writeFile(join(dir, "0003_c.sql"), `insert into widgets (id) values (2);`);
      const third = await runMigrations(db, dir);
      expect(third.applied).toEqual(["0003_c.sql"]);
      expect((await db.query<{ n: number }>(`select count(*)::int n from widgets`)).rows).toEqual([{ n: 2 }]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rolls back a failing migration and leaves it untracked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babito-migrate-"));
    const db = await blankDb();
    try {
      await writeFile(join(dir, "0001_bad.sql"), `create table this is not valid sql;`);
      await expect(runMigrations(db, dir)).rejects.toThrow();
      expect((await db.query(`select 1 from information_schema.tables where table_name = 'app_migrations'`)).rows).toHaveLength(1);
      expect((await db.query(`select name from app_migrations`)).rows).toEqual([]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("POST /cron/migrate requires the cron secret and reports what it applied", async () => {
    const { createHarness } = await import("./helpers/harness.js");
    const h = await createHarness();
    try {
      const unauthed = await h.app.request("/cron/migrate", { method: "POST" });
      expect(unauthed.status).toBe(401);
      // The harness DB already has every real migration tracked (see helpers/pglite.ts), so
      // there's nothing pending: this proves the route runs cleanly against a real schema.
      const res = await h.app.request("/cron/migrate", { method: "POST", headers: { Authorization: "Bearer cron-secret" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ applied: [] });
    } finally {
      h.processor.stopTimers();
      await h.db.close();
    }
  });
});

describe("staff alert test button", () => {
  const log = { warn: () => {}, info: () => {}, error: () => {} } as any;
  it("reports per number whether the template was accepted, including the API's error", async () => {
    const wa = {
      sendText: async () => ({ waMessageId: "x" }),
      sendTemplate: async (to: string) => {
        if (to === "972500000000") throw new Error("WhatsApp API 400 (code 132001): Template name does not exist in the translation");
        return { waMessageId: "w" };
      },
    } as any;
    const n = new StaffNotifier({ webhookUrl: "", staffNumbers: ["972507406322", "972500000000"], whatsapp: wa, email: null, handoffTemplate: { name: "babito_staff_handoff", language: "en" }, log });
    const r = await n.sendTest();
    expect(r.map((x) => [x.to, x.ok])).toEqual([["972507406322", true], ["972500000000", false]]);
    expect(r[1]!.detail).toContain("132001");
    expect(await new StaffNotifier({ webhookUrl: "", staffNumbers: [], whatsapp: wa, email: null, log }).sendTest()).toEqual([{ to: "-", ok: false, detail: "STAFF_WHATSAPP_NUMBERS is empty" }]);
  });
});

describe("handoff alert says where to reply", () => {
  it("names the channel and where staff answers", async () => {
    const { replyWhere } = await import("../src/pipeline/handoff.js");
    expect(replyWhere("email:a@b.com")).toContain("Outlook");
    expect(replyWhere("psid:1")).toContain("Business Suite");
    expect(replyWhere("igsid:1")).toContain("إنستغرام");
    expect(replyWhere("972501234567")).toContain("admin");
  });
});
