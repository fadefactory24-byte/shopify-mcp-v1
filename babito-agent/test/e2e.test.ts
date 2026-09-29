import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repo } from "../src/db/repo.js";
import { WhatsAppApiError } from "../src/whatsapp/client.js";
import { callTool, CHOKING_ID, CUSTOMER_PHONE, lastToolResults, mediaWebhook, refuse, say, statusWebhook, textWebhook } from "./helpers/fakes.js";
import { createHarness, type Harness } from "./helpers/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  h.processor.stopTimers();
  await h.db.close();
});

const lastSent = () => h.whatsapp.sent[h.whatsapp.sent.length - 1];

describe("webhook security & robustness", () => {
  it("answers Meta's verification handshake", async () => {
    const ok = await h.app.request("/webhook?hub.mode=subscribe&hub.verify_token=verify-token-123&hub.challenge=42");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("42");
    const bad = await h.app.request("/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42");
    expect(bad.status).toBe(403);
  });

  it("rejects unsigned or badly signed webhooks without storing anything", async () => {
    expect((await h.post(textWebhook(CUSTOMER_PHONE, "hi"), { signature: null })).status).toBe(401);
    expect((await h.post(textWebhook(CUSTOMER_PHONE, "hi"), { signature: "sha256=deadbeef" })).status).toBe(401);
    expect(await h.q("select * from messages")).toHaveLength(0);
  });

  it("rejects oversized webhook bodies with 413 without reading them whole", async () => {
    expect((await h.post(JSON.stringify({ pad: "x".repeat(1_000_001) }))).status).toBe(413);
    // No Content-Length: a 10 MB stream is cut off shortly after the 1 MB limit.
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(120);
    const stream = new ReadableStream({
      pull(ctl) {
        if (pulled >= 10_000_000) return ctl.close();
        pulled += chunk.length;
        ctl.enqueue(chunk);
      },
    });
    const res = await h.app.request("/webhook", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(2_000_000);
    expect(await h.q("select * from messages")).toHaveLength(0);
  });

  it("handles malformed payloads without crashing", async () => {
    expect((await h.post("{not json")).status).toBe(400);
    expect((await h.post({ object: "whatsapp_business_account", entry: "nope" })).status).toBe(200);
    expect((await h.post({ random: true })).status).toBe(200);
    expect(await h.q("select * from messages")).toHaveLength(0);
  });

  it("processes a duplicated webhook delivery exactly once", async () => {
    h.llm.push(say("أهلا! كيف بقدر أساعدك؟"));
    const payload = textWebhook(CUSTOMER_PHONE, "مرحبا", { id: "wamid.DUP" });
    await h.post(payload);
    await h.post(payload); // Meta retry
    await h.processor.drain();
    await h.customerSays(payload); // and once more after processing
    expect(await h.q("select * from messages where direction = 'inbound'")).toHaveLength(1);
    expect(h.whatsapp.sent).toHaveLength(1);
    expect(h.llm.requests).toHaveLength(1);
  });

  it("batches a burst of short messages into one AI run", async () => {
    h.llm.push(say("أكيد، عنا جهاز 👍"));
    await h.post(textWebhook(CUSTOMER_PHONE, "مرحبا"));
    await h.post(textWebhook(CUSTOMER_PHONE, "عندكم"));
    await h.post(textWebhook(CUSTOMER_PHONE, "جهاز منع الاختناق؟"));
    await h.processor.drain();
    expect(h.llm.requests).toHaveLength(1);
    const userText = (h.llm.requests[0]!.messages.at(-1)!.content[0] as any).text as string;
    expect(userText).toBe("مرحبا\nعندكم\nجهاز منع الاختناق؟");
    expect(h.whatsapp.sent).toHaveLength(1);
  });

  it("applies delivery statuses forward-only", async () => {
    h.llm.push(say("שלום!"));
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "היי"));
    const id = lastSent()!.id;
    await h.post(statusWebhook(id, "read"));
    await h.post(statusWebhook(id, "delivered")); // late, out of order
    const [row] = await h.q("select status from messages where wa_message_id = $1", [id]);
    expect(row.status).toBe("read");
  });
});

describe("conversations", () => {
  it("Arabic product question: searches Shopify and replies in Arabic with live data", async () => {
    h.llm.push(
      callTool("search_products", { query: "מכשיר חנק anti choking" }),
      (req) => {
        const [res] = lastToolResults(req);
        expect(res!.content.results[0].product_id).toBe(CHOKING_ID);
        return say(`أكيد! عنا جهاز إنقاذ من الاختناق للأطفال والكبار، سعره ${res!.content.results[0].price_from} شيكل 👍\n${res!.content.results[0].url}`)(req);
      },
    );
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "عندكم جهاز منع الاختناق؟"));
    expect(lastSent()!.body).toContain("299.99 شيكل");
    expect(h.llm.requests[0]!.systemDynamic).toContain("REPLY LANGUAGE: Arabic");
    const [conv] = await h.q("select language, context from conversations");
    expect(conv.language).toBe("ar");
    expect(conv.context.recent_products[0].id).toBe(CHOKING_ID);
    const tools = await h.q("select tool_name, success from tool_calls");
    expect(tools).toEqual([{ tool_name: "search_products", success: true }]);
  });

  it("price follow-up ('بكم؟') resolves the product from conversation context", async () => {
    h.llm.push(callTool("search_products", { query: "מכשיר חנק" }), say("عنا جهاز إنقاذ من الاختناق 👍 بدك تفاصيل؟"));
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "عندكم جهاز منع الاختناق؟"));

    h.llm.push(
      (req) => {
        // The model is told which product was discussed, with its id.
        expect(req.systemDynamic).toContain(CHOKING_ID);
        return callTool("get_product", { product_id: CHOKING_ID })(req);
      },
      (req) => {
        const [res] = lastToolResults(req);
        const one = res!.content.variants.find((v: any) => v.title === "יחידה");
        return say(`الجهاز الواحد بـ ${one.price} شيكل، والزوج بـ 499.99 شيكل`)(req);
      },
    );
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "بكم؟"));
    expect(lastSent()!.body).toBe("الجهاز الواحد بـ 299.99 شيكل، والزوج بـ 499.99 شيكل");
    // History carried the earlier turn.
    const msgs = h.llm.requests[2]!.messages.map((m) => m.role);
    expect(msgs.slice(0, 3)).toEqual(["user", "assistant", "user"]);
  });

  it("Hebrew stock question: reports availability without quantities", async () => {
    h.llm.push(callTool("get_product", { product_id: CHOKING_ID }), (req) => {
      const [res] = lastToolResults(req);
      expect(res!.content.variants.every((v: any) => !("quantity" in v))).toBe(true);
      expect(res!.content.variants.find((v: any) => v.title === "3 יחידות").available).toBe(false);
      return say("יחידה אחת וזוג זמינים במלאי, המארז של 3 כרגע לא זמין.")(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "יש במלאי את המכשיר נגד חנק?"));
    expect(h.llm.requests[0]!.systemDynamic).toContain("REPLY LANGUAGE: Hebrew");
    expect(lastSent()!.body).toContain("זמינים");
  });

  it("mixed Arabic/Hebrew message is answered in the dominant language", async () => {
    h.llm.push(callTool("get_my_orders", {}), say("طلبك #1001 انبعت 👍"));
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "وين طلبي אחי"));
    expect(h.llm.requests[0]!.systemDynamic).toContain("REPLY LANGUAGE: Arabic");
  });

  it("order tracking: finds orders by the verified WhatsApp number", async () => {
    h.llm.push(callTool("get_my_orders", {}), (req) => {
      const [res] = lastToolResults(req);
      expect(res!.content.found).toBe(true);
      const o = res!.content.orders[0];
      expect(o.order_number).toBe("#1001");
      expect(o.tracking[0].number).toBe("RR123456789IL");
      // Live tracking reaches the model as a stage + date only; carrier names and contact data never do.
      expect(o.live_tracking).toEqual({ stage: "final_leg", last_update: "2026-09-26" });
      expect(JSON.stringify(res!.content)).not.toContain("Israel Post");
      expect(JSON.stringify(res!.content)).not.toContain("mom@example.com");
      expect(JSON.stringify(res!.content)).not.toContain("123-4567");
      return say(`طلبك ${o.order_number} بالمرحلة الأخيرة من التوصيل، رقم التتبع ${o.tracking[0].number}`)(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "وين طلبي؟"));
    expect(lastSent()!.body).toContain("RR123456789IL");
    const [conv] = await h.q("select context from conversations");
    expect(conv.context.verified_orders).toContain("#1001");
  });

  it("unknown order number: says not found, no data", async () => {
    h.llm.push(callTool("get_order_status", { order_number: "9999" }), (req) => {
      const [res] = lastToolResults(req);
      expect(res!.content.found).toBe(false);
      return say("ما لقيت طلب بهالرقم، ممكن تتأكد من الرقم؟")(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "طلب رقم 9999"));
    expect(lastSent()!.body).toContain("ما لقيت");
  });

  it("someone else's order: requires email, never leaks details, then verifies with correct email", async () => {
    h.llm.push(callTool("get_order_status", { order_number: "#2002" }), (req) => {
      const [res] = lastToolResults(req);
      expect(res!.content).toMatchObject({ found: true, verified: false });
      expect(res!.content.order).toBeUndefined();
      return say("עשיתי בדיקה — מה המייל שאיתו ביצעת את ההזמנה?")(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "מה הסטטוס של הזמנה 2002?"));

    h.llm.push(callTool("get_order_status", { order_number: "#2002", email: "wrong@example.com" }), (req) => {
      expect(lastToolResults(req)[0]!.content.verified).toBe(false);
      return say("המייל לא תואם להזמנה.")(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "wrong@example.com"));

    h.llm.push(callTool("get_order_status", { order_number: "#2002", email: "Other@Example.com" }), (req) => {
      const r = lastToolResults(req)[0]!.content;
      expect(r.verified).toBe(true);
      expect(r.order.stage).toBe("processing");
      return say("ההזמנה בטיפול ועוד לא נשלחה.")(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "Other@Example.com"));
    expect(lastSent()!.body).toBe("ההזמנה בטיפול ועוד לא נשלחה.");
  });

  it("brute-force protection on order verification", async () => {
    for (let i = 0; i < 5; i++) {
      h.llm.push(callTool("get_order_status", { order_number: `#${3000 + i}` }), say("לא נמצא"));
      await h.customerSays(textWebhook(CUSTOMER_PHONE, `הזמנה ${3000 + i}`));
    }
    h.llm.push(callTool("get_order_status", { order_number: "#2002", email: "other@example.com" }), (req) => {
      expect(lastToolResults(req)[0]!.content).toMatchObject({ verified: false, blocked: true });
      return say("אעביר לנציג")(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "הזמנה 2002 other@example.com"));
  });

  it("address change: forwards to staff (high priority when unshipped) and stops the AI", async () => {
    h.shopify.orders[0] = { ...h.shopify.orders[0]!, stage: "processing", fulfillmentStatus: "UNFULFILLED", tracking: [] };
    h.llm.push(
      callTool("request_order_change", { order_number: "#1001", change_type: "address", details: "بدي أغير العنوان لشارع هرتسل 5 حيفا" }),
      (req) => {
        const r = lastToolResults(req)[0]!.content;
        expect(r).toMatchObject({ submitted: true, already_shipped: false });
        return say("حولت طلبك للفريق وراح يأكدولك هون 🙏")(req);
      },
    );
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "بدي أغير العنوان لطلب 1001"));
    const [handoff] = await h.q("select * from handoffs");
    expect(handoff).toMatchObject({ kind: "order_change", reason: "order_change", priority: "high", order_name: "#1001", change_type: "address" });
    const [conv] = await h.q("select mode from conversations");
    expect(conv.mode).toBe("human");
    expect(h.notifier.notices).toHaveLength(1);

    // AI stays silent while a human owns the chat.
    const before = h.llm.requests.length;
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "وينكم؟"));
    expect(h.llm.requests.length).toBe(before);
    const [last] = await h.q("select status from messages where direction='inbound' order by created_at desc limit 1");
    expect(last.status).toBe("skipped");
  });

  it("customer asks for a human: instant handoff without calling the LLM", async () => {
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "بدي احكي مع موظف"));
    expect(h.llm.requests).toHaveLength(0);
    expect(lastSent()!.body).toContain("الفريق");
    const [conv] = await h.q("select mode from conversations");
    expect(conv.mode).toBe("human");
    expect((await h.q("select reason from handoffs"))[0].reason).toBe("customer_request");
  });

  it("staff reply from the dashboard keeps human mode; release returns the chat to AI", async () => {
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "נציג בבקשה"));
    const [conv] = await h.q("select id from conversations");
    const auth = { Authorization: `Basic ${Buffer.from("admin:admin-password-123").toString("base64")}`, Origin: "http://localhost", Host: "localhost" };
    const reply = await h.app.request(`http://localhost/admin/conversations/${conv.id}/reply`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/x-www-form-urlencoded" },
      body: "body=%D7%94%D7%99%D7%99",
    });
    expect(reply.status).toBe(302);
    expect(lastSent()!.body).toBe("היי");
    const release = await h.app.request(`http://localhost/admin/conversations/${conv.id}/release`, { method: "POST", headers: auth });
    expect(release.status).toBe(302);
    expect((await h.q("select mode from conversations"))[0].mode).toBe("ai");
    expect((await h.q("select status from handoffs"))[0].status).toBe("resolved");

    h.llm.push(say("במה אפשר לעזור?"));
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "תודה"));
    expect(lastSent()!.body).toBe("במה אפשר לעזור?");
  });

  it("admin requires auth and blocks cross-origin POSTs", async () => {
    expect((await h.app.request("/admin")).status).toBe(401);
    const auth = { Authorization: `Basic ${Buffer.from("admin:admin-password-123").toString("base64")}` };
    expect((await h.app.request("http://localhost/admin", { headers: auth })).status).toBe(200);
    const csrf = await h.app.request("http://localhost/admin/kb/reload", { method: "POST", headers: { ...auth, Origin: "https://evil.example", Host: "localhost" } });
    expect(csrf.status).toBe(403);
  });

  it("Shopify unavailable: tool fails, model is told, reply stays honest, failure is logged", async () => {
    h.shopify.down = true;
    h.llm.push(callTool("search_products", { query: "כיסא האכלה" }), (req) => {
      const [res] = lastToolResults(req);
      expect(res!.isError).toBe(true);
      expect(res!.content.error).toBe("store_system_unavailable");
      return say("ما بقدر أفحص هلأ للأسف، بدك أحولك لحدا من الفريق؟")(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "عندكم كرسي أكل للأطفال؟"));
    expect(lastSent()!.body).toContain("ما بقدر أفحص");
    const [tc] = await h.q("select success, error from tool_calls");
    expect(tc.success).toBe(false);
    expect(tc.error).toContain("Shopify");
  });

  it("invalid tool input is rejected by validation, not executed", async () => {
    h.llm.push(callTool("get_product", { product_id: "'; drop table customers; --" }), (req) => {
      expect(lastToolResults(req)[0]!.content.error).toBe("invalid_input");
      return say("ممكن توضحلي أي منتج؟")(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "بدي هاد"));
    expect(h.shopify.calls).not.toContain("getProduct");
  });

  it("hallucinated price: guardrail forces a tool call and the corrected reply is sent", async () => {
    h.llm.push(
      say("الجهاز سعره 150 شيكل بس!"), // invented price, no tool called
      (req) => {
        expect((req.messages.at(-1)!.content[0] as any).text).toContain("automatic check");
        return callTool("get_product", { product_id: CHOKING_ID })(req);
      },
      say("الجهاز سعره 299.99 شيكل"),
    );
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "قديش سعر جهاز الاختناق؟"));
    expect(h.whatsapp.sent.map((s) => s.body)).toEqual(["الجهاز سعره 299.99 شيكل"]);
    const [run] = await h.q("select guardrail_flags, status from agent_runs");
    expect(run.guardrail_flags).toContain("ungrounded_price:150");
    expect(run.status).toBe("succeeded");
  });

  it("repeated hallucination: fails closed with a handoff instead of sending a wrong price", async () => {
    h.llm.push(say("سعره 150 شيكل"), say("سعره 140 شيكل"));
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "قديش سعره؟"));
    expect(h.whatsapp.sent).toHaveLength(1);
    expect(h.whatsapp.sent[0]!.body).not.toMatch(/1[45]0/);
    expect((await h.q("select mode from conversations"))[0].mode).toBe("human");
    expect((await h.q("select reason from handoffs"))[0].reason).toBe("processing_error");
  });

  it("model refusal is handed to a human", async () => {
    h.llm.push(refuse);
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "..."));
    expect((await h.q("select reason from handoffs"))[0].reason).toBe("sensitive");
    expect(h.whatsapp.sent).toHaveLength(1);
  });

  it("LLM outage: customer gets the fallback message and a human is notified", async () => {
    // No scripted steps -> the provider throws.
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "مرحبا"));
    expect(h.whatsapp.sent).toHaveLength(1);
    expect(h.notifier.notices).toHaveLength(1);
    const [run] = await h.q("select status, error from agent_runs");
    expect(run.status).toBe("failed");
    expect(h.notifier.alerts.map((a) => a.kind)).toEqual(["AI could not answer"]);
  });

  it("staff take over while the model is thinking: the AI reply is not sent on top of theirs", async () => {
    h.llm.push(async () => {
      const [conv] = await h.q("select id from conversations");
      await h.q("update conversations set mode = 'human', human_since = now(), human_last_activity_at = now() where id = $1", [conv.id]);
      return { content: [{ type: "text", text: "תשובה מאוחרת של הבוט" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, model: "fake" };
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "יש לכם מוצץ?"));
    expect(h.whatsapp.sent).toHaveLength(0);
    const [inbound] = await h.q("select status, error from messages where direction='inbound'");
    expect(inbound).toMatchObject({ status: "skipped", error: "staff_took_over" });
  });

  it("WhatsApp API failure: reply is stored as failed and the sweeper resends it", async () => {
    h.whatsapp.failNext = 1;
    h.llm.push(say("שלום! איך אפשר לעזור?"));
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "היי"));
    expect(h.whatsapp.sent).toHaveLength(0);
    let [out] = await h.q("select status, attempts from messages where direction='outbound'");
    expect(out).toMatchObject({ status: "failed", attempts: 1 });

    await h.processor.sweep();
    expect(h.whatsapp.sent.map((s) => s.body)).toEqual(["שלום! איך אפשר לעזור?"]);
    [out] = await h.q("select status from messages where direction='outbound'");
    expect(out.status).toBe("sent");
  });

  it("WhatsApp errors a resend cannot fix (131047 outside the 24h window) are not retried by the sweeper", async () => {
    h.whatsapp.failNext = 1;
    h.whatsapp.failWith = () => new WhatsAppApiError("WhatsApp API 400 (code 131047): Re-engagement message", 400, 131047);
    h.llm.push(say("שלום! איך אפשר לעזור?"));
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "היי"));
    await h.processor.sweep();
    expect(h.whatsapp.sent).toHaveLength(0);
    const [out] = await h.q("select status, error from messages where direction='outbound'");
    expect(out.status).toBe("failed");
    expect(out.error).toContain("131047");
  });

  it("typing indicator only when the AI is going to answer, not in human mode", async () => {
    h.llm.push(say("שלום!"));
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "היי", { id: "wamid.ai" }));
    expect(h.whatsapp.typing).toEqual(["wamid.ai"]);

    const [conv] = await h.q("select id from conversations");
    await h.q("update conversations set mode = 'human', human_since = now(), human_last_activity_at = now() where id = $1", [conv.id]);
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "יש מישהו?", { id: "wamid.human" }));
    expect(h.whatsapp.reads).toContain("wamid.human"); // plain read receipt
    expect(h.whatsapp.typing).toEqual(["wamid.ai"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.notifier.waiting).toEqual([{ conversationId: conv.id, customerWaId: CUSTOMER_PHONE, customerName: expect.anything(), text: "יש מישהו?" }]);
  });

  it("voice note: polite text-only reply, no LLM cost", async () => {
    await h.customerSays(mediaWebhook(CUSTOMER_PHONE, "audio"));
    expect(h.llm.requests).toHaveLength(0);
    expect(h.whatsapp.sent).toHaveLength(1);
  });

  it("photo without text: asks what it's about (staff can open it in the dashboard), no LLM cost", async () => {
    await h.customerSays(mediaWebhook(CUSTOMER_PHONE, "image"));
    expect(h.llm.requests).toHaveLength(0);
    expect(lastSent()!.body).toContain("מספר ההזמנה");
  });

  it("dashboard shows customer photos safely, fetched from WhatsApp on demand", async () => {
    await h.customerSays(mediaWebhook(CUSTOMER_PHONE, "image"));
    const [msg] = await h.q("select id from messages where direction='inbound'");
    const auth = { Authorization: `Basic ${Buffer.from("admin:admin-password-123").toString("base64")}` };
    expect((await h.app.request(`http://localhost/admin/media/${msg.id}`)).status).toBe(401);
    const res = await h.app.request(`http://localhost/admin/media/${msg.id}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(h.whatsapp.downloaded).toEqual(["MEDIA1"]);
    // A file type that could run script in the browser is only offered as a download.
    h.whatsapp.media = { contentType: "text/html", data: new TextEncoder().encode("<script>alert(1)</script>").buffer as ArrayBuffer };
    const risky = await h.app.request(`http://localhost/admin/media/${msg.id}`, { headers: auth });
    expect(risky.headers.get("content-type")).toBe("application/octet-stream");
    expect(risky.headers.get("content-disposition")).toBe("attachment");
    const [conv] = await h.q("select id from conversations");
    expect(await (await h.app.request(`http://localhost/admin/conversations/${conv.id}`, { headers: auth })).text()).toContain(`/admin/media/${msg.id}`);
  });

  it("knowledge questions use get_knowledge (live Shopify policy)", async () => {
    h.llm.push(callTool("get_knowledge", { keys: ["policy.shipping"] }), (req) => {
      const r = lastToolResults(req)[0]!.content;
      expect(r.items[0].content).toContain("7-14");
      return say("המשלוח לוקח בדרך כלל 7-14 ימי עסקים.")(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "תוך כמה זמן מגיע?"));
    expect(h.llm.requests[0]!.systemStatic).toContain("policy.shipping");
    expect(h.llm.requests[0]!.systemStatic).not.toContain("7-14"); // facts are fetched, not baked into the prompt
  });

  it("customer memory: safe facts saved, sensitive ones refused", async () => {
    h.llm.push(
      callTool("remember_customer_fact", { key: "child_age", value: "8 months" }),
      callTool("remember_customer_fact", { key: "notes", value: "card 4580123412341234" }),
      say("מעולה!"),
    );
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "הבן שלי בן 8 חודשים"));
    const mem = await h.q("select key, value from customer_memories");
    expect(mem).toEqual([{ key: "child_age", value: "8 months" }]);

    h.llm.push((req) => {
      expect(req.systemDynamic).toContain("child_age=8 months");
      return say("היי שוב!")(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "היי"));
  });

  it("rate limiting stops the bot from being abused", async () => {
    const hh = await createHarness({ RATE_LIMIT_PER_10_MIN: "3" });
    try {
      for (let i = 0; i < 3; i++) hh.llm.push(say(`ok ${i}`));
      for (let i = 0; i < 5; i++) await hh.customerSays(textWebhook(CUSTOMER_PHONE, `msg ${i}`));
      expect(hh.llm.requests.length).toBe(3);
      expect((await hh.q("select count(*)::int as n from messages where status = 'skipped'"))[0].n).toBeGreaterThan(0);
    } finally {
      hh.processor.stopTimers();
      await hh.db.close();
    }
  });

  it("bot master switch off: messages are stored but not answered", async () => {
    await h.db.query(`update settings set value = 'false' where key = 'bot_enabled'`);
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "היי"));
    expect(h.whatsapp.sent).toHaveLength(0);
    expect((await h.q("select status from messages"))[0].status).toBe("skipped");
  });

  it("crash recovery: stuck messages are picked up by the sweeper", async () => {
    await h.processor.ingest([{ waMessageId: "wamid.stuck", from: CUSTOMER_PHONE, profileName: null, timestamp: null, type: "text", text: "היי", media: null, phoneNumberId: "PNID" }]);
    h.processor.stopTimers(); // simulate the process dying before the debounce fired
    await h.db.query(`update messages set created_at = now() - interval '1 minute'`);
    h.llm.push(say("שלום!"));
    await h.processor.sweep();
    await h.processor.drain();
    expect(lastSent()!.body).toBe("שלום!");
  });
});

describe("privacy & retention", () => {
  const auth = { Authorization: `Basic ${Buffer.from("admin:admin-password-123").toString("base64")}`, Origin: "http://localhost", Host: "localhost" };

  it("forget customer scrubs the order email and customer texts from tool calls, AI runs and handoffs", async () => {
    h.llm.push(callTool("get_order_status", { order_number: "#2002", email: "other@example.com" }), say("ההזמנה בטיפול ועוד לא נשלחה."));
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "הזמנה 2002 other@example.com"));
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "נציג בבקשה")); // handoff summary quotes the customer
    expect(JSON.stringify(await h.q("select input from tool_calls"))).toContain("other@example.com");

    const [customer] = await h.q("select id from customers");
    const res = await h.app.request(`http://localhost/admin/customers/${customer.id}/forget`, { method: "POST", headers: auth });
    expect(res.status).toBe(302);
    expect(await h.q("select input, output from tool_calls")).toEqual([{ input: null, output: null }]);
    expect(await h.q("select reply_text from agent_runs")).toEqual([{ reply_text: null }]);
    expect(await h.q("select summary from handoffs")).toEqual([{ summary: null }]);
    for (const table of ["messages", "tool_calls", "agent_runs", "handoffs", "conversations", "customers"]) {
      const dump = JSON.stringify(await h.q(`select * from ${table}`));
      expect(dump, table).not.toContain("other@example.com");
      expect(dump, table).not.toContain("נציג בבקשה");
    }
  });

  it("retention purge resolves the open handoffs of the stale conversations it closes", async () => {
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "بدي احكي مع موظف"));
    await h.q("update conversations set last_message_at = now() - interval '31 days'");
    await h.customerSays(textWebhook("972529999999", "بدي احكي مع موظف")); // recent: must stay open

    const res = await h.app.request("/cron/maintenance", { method: "POST", headers: { Authorization: "Bearer cron-secret" } });
    expect(res.status).toBe(200);
    const rows = await h.q(
      `select c.status as conv, h.status as handoff, h.claimed_by from handoffs h join conversations c on c.id = h.conversation_id join customers cu on cu.id = c.customer_id order by cu.wa_id`,
    );
    expect(rows).toEqual([
      { conv: "closed", handoff: "resolved", claimed_by: "system:retention" }, // CUSTOMER_PHONE, stale
      { conv: "open", handoff: "open", claimed_by: null },
    ]);
  });
});

describe("pipeline reliability", () => {
  /** Let the sweeper see the queued messages (it skips ones younger than 10s), then run it. */
  async function sweepNow() {
    await h.db.query(`update messages set created_at = now() - interval '1 minute' where direction = 'inbound'`);
    await h.processor.sweep();
    await h.processor.drain();
  }

  it("leases are owner-aware: a worker cannot extend or clear another worker's lease", async () => {
    await h.processor.ingest([{ waMessageId: "wamid.lease", from: CUSTOMER_PHONE, profileName: null, timestamp: null, type: "text", text: "היי", media: null, phoneNumberId: "PNID" }]);
    h.processor.stopTimers();
    const [conv] = await h.q("select id from conversations");
    const [a, b] = [randomUUID(), randomUUID()];
    expect(await repo.claimConversation(h.db, conv.id, a, 300)).toBe(true);
    expect(await repo.claimConversation(h.db, conv.id, b, 300)).toBe(false);
    expect(await repo.extendLease(h.db, conv.id, b, 300)).toBe(false);
    await repo.releaseConversation(h.db, conv.id, b);
    expect((await h.q("select processing_owner from conversations"))[0].processing_owner).toBe(a);
    await repo.releaseConversation(h.db, conv.id, a);
    expect(await repo.claimConversation(h.db, conv.id, b, 300)).toBe(true);
  });

  it("a run longer than the lease renews it, so a second worker cannot take the conversation", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    h.llm.push(async (req) => {
      const [conv] = await h.q("select id, processing_owner from conversations");
      // Simulate a long run: the lease is about to lapse when the renewal timer fires.
      await h.q("update conversations set processing_until = now() - interval '1 second' where id = $1", [conv.id]);
      vi.advanceTimersByTime(60_000);
      for (let i = 0; i < 50 && !(await h.q("select processing_until > now() as held from conversations"))[0].held; i++) await new Promise((r) => setTimeout(r, 10));
      await h.processor.processConversation(conv.id); // another worker
      expect((await h.q("select processing_owner from conversations"))[0].processing_owner).toBe(conv.processing_owner);
      return say("שלום!")(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "היי"));
    expect(h.llm.requests).toHaveLength(1);
    expect(h.whatsapp.sent.map((s) => s.body)).toEqual(["שלום!"]); // in-step expectations held (a failure there means the fallback)
    expect((await h.q("select processing_until, processing_owner from conversations"))[0]).toEqual({ processing_until: null, processing_owner: null });
  });

  it("a batch that throws goes straight back to the queue and the sweeper retries it", async () => {
    vi.spyOn(repo, "finishRun").mockRejectedValueOnce(new Error("db blip"));
    h.llm.push(say("ניסיון ראשון"), say("שלום!"));
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "היי"));
    expect(h.whatsapp.sent).toHaveLength(0);
    expect((await h.q("select status, attempts from messages where direction='inbound'"))[0]).toEqual({ status: "received", attempts: 1 });
    expect((await h.q("select status from agent_runs"))[0].status).toBe("failed"); // not left 'running'
    expect((await h.q("select processing_until from conversations"))[0].processing_until).toBeNull();

    await sweepNow();
    expect(h.whatsapp.sent.map((s) => s.body)).toEqual(["שלום!"]);
    expect((await h.q("select status, attempts from messages where direction='inbound'"))[0]).toEqual({ status: "processed", attempts: 2 });
  });

  it("after MAX_PROCESS_ATTEMPTS failures the customer gets the handoff text and staff get the chat", async () => {
    vi.spyOn(repo, "finishRun").mockRejectedValue(new Error("db blip"));
    h.llm.push(say("a"), say("b"), say("c"));
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "مرحبا"));
    await sweepNow();
    await sweepNow();
    expect((await h.q("select status, attempts, error from messages where direction='inbound'"))[0]).toEqual({ status: "failed", attempts: 3, error: "max attempts exceeded" });
    expect(h.whatsapp.sent).toHaveLength(1);
    expect(h.whatsapp.sent[0]!.body).toContain("الفريق"); // Arabic handoff text
    expect(await h.q("select status from agent_runs")).toEqual([{ status: "failed" }, { status: "failed" }, { status: "failed" }]);
    expect((await h.q("select reason from handoffs"))[0].reason).toBe("processing_error");
    expect((await h.q("select mode from conversations"))[0].mode).toBe("human");
    expect(h.notifier.notices).toHaveLength(1);

    await sweepNow(); // nothing left to retry or announce
    expect(h.whatsapp.sent).toHaveLength(1);
  });

  it("messages whose worker died on every attempt are handed off by the sweeper, not dropped", async () => {
    await h.processor.ingest([{ waMessageId: "wamid.dead", from: CUSTOMER_PHONE, profileName: null, timestamp: null, type: "text", text: "היי", media: null, phoneNumberId: "PNID" }]);
    h.processor.stopTimers();
    await h.db.query(`update messages set attempts = 3`); // three claims, each worker crashed
    await sweepNow();
    expect((await h.q("select status from messages where direction='inbound'"))[0].status).toBe("failed");
    expect(h.whatsapp.sent).toHaveLength(1);
    expect((await h.q("select reason from handoffs"))[0].reason).toBe("processing_error");
    expect(h.llm.requests).toHaveLength(0);
  });

  it("shutdown re-queues runs that outlive the drain and releases their leases", async () => {
    h.llm.push(async (req) => {
      await h.processor.releaseLeases(); // shutdown gave up waiting for this run
      expect((await h.q("select status from messages where direction='inbound'"))[0].status).toBe("received");
      expect((await h.q("select processing_until, processing_owner from conversations"))[0]).toEqual({ processing_until: null, processing_owner: null });
      return say("שלום!")(req);
    });
    await h.customerSays(textWebhook(CUSTOMER_PHONE, "היי"));
    expect(lastSent()!.body).toBe("שלום!"); // in-step expectations held
  });
});

describe("admin: connect a WhatsApp Business app number (Embedded Signup)", () => {
  const auth = { Authorization: `Basic ${Buffer.from("admin:admin-password-123").toString("base64")}`, Origin: "http://localhost", Host: "localhost" };
  const complete = (body: unknown, headers: Record<string, string> = auth) =>
    h.app.request("http://localhost/admin/whatsapp-connect/complete", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });

  async function configured() {
    await h.db.close();
    h.processor.stopTimers();
    h = await createHarness({ META_APP_ID: "111222333", WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: "987654321", WHATSAPP_GRAPH_VERSION: "v25.0" });
  }

  it("page needs auth, explains when unconfigured, and carries the Embedded Signup settings when configured", async () => {
    expect((await h.app.request("http://localhost/admin/whatsapp-connect")).status).toBe(401);
    expect(await (await h.app.request("http://localhost/admin/whatsapp-connect", { headers: auth })).text()).toContain("Not configured");
    await configured();
    const page = await (await h.app.request("http://localhost/admin/whatsapp-connect", { headers: auth })).text();
    expect(page).toContain('{"appId":"111222333","configId":"987654321","version":"v25.0"}');
    expect(page).toContain("whatsapp_business_app_onboarding");
    expect(page).toContain("https://connect.facebook.net/en_US/sdk.js");
    expect(await (await h.app.request("http://localhost/admin", { headers: auth })).text()).toContain("/admin/whatsapp-connect");
  });

  it("exchanges the code, subscribes the app to the WABA, reports the number, and never returns the token", async () => {
    await configured();
    const calls: { url: string; method: string; auth: string | null }[] = [];
    h.setMetaFetch(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization") });
      const json = url.includes("/oauth/access_token")
        ? { access_token: "BIZ-TOKEN-SECRET", token_type: "bearer" }
        : url.includes("/subscribed_apps")
          ? { success: true }
          : { id: "555000", display_phone_number: "+972 53-536-6356", verified_name: "BABITO", platform_type: "CLOUD_API", is_on_biz_app: true };
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const res = await complete({ code: "one-time-code", waba_id: "444000", phone_number_id: "555000" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("BIZ-TOKEN-SECRET");
    expect(JSON.parse(text)).toEqual({
      wabaId: "444000",
      subscribed: true,
      numbers: [{ id: "555000", display_phone_number: "+972 53-536-6356", verified_name: "BABITO", platform_type: "CLOUD_API", is_on_biz_app: true }],
    });
    expect(calls[0]!.url).toMatch(/^https:\/\/graph\.facebook\.com\/v25\.0\/oauth\/access_token\?client_id=111222333&client_secret=test-app-secret&code=one-time-code$/);
    expect(calls[1]).toEqual({ url: "https://graph.facebook.com/v25.0/444000/subscribed_apps", method: "POST", auth: "Bearer BIZ-TOKEN-SECRET" });
    expect(calls[2]!.url).toContain("/555000?fields=");
    expect((await h.q("select action, entity_id from audit_log where action = 'whatsapp_connect'"))[0]).toEqual({ action: "whatsapp_connect", entity_id: "444000" });
  });

  it("without a phone number id it lists the WABA's numbers", async () => {
    await configured();
    h.setMetaFetch(async (input) => {
      const url = String(input);
      const json = url.includes("/oauth/") ? { access_token: "t" } : url.includes("/subscribed_apps") ? { success: true } : { data: [{ id: "1", is_on_biz_app: true }] };
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const res = await complete({ code: "c", waba_id: "444000" });
    expect((await res.json()).numbers).toEqual([{ id: "1", is_on_biz_app: true }]);
  });

  it("rejects bad input, cross-origin posts and reports Meta errors without leaking the secret", async () => {
    expect((await complete({ code: "c", waba_id: "444000" })).status).toBe(501); // not configured
    await configured();
    expect((await complete({ code: "", waba_id: "444000" })).status).toBe(400);
    expect((await complete({ code: "c", waba_id: "abc" })).status).toBe(400);
    expect((await complete({ code: "c", waba_id: "444000", phone_number_id: "1; drop" })).status).toBe(400);
    expect((await complete({ code: "c", waba_id: "444000" }, { ...auth, Origin: "https://evil.example" })).status).toBe(403);
    h.setMetaFetch(async () => new Response(JSON.stringify({ error: { message: "This authorization code has expired." } }), { status: 400 }));
    const res = await complete({ code: "c", waba_id: "444000" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "This authorization code has expired." });
    expect(text).not.toContain("test-app-secret");
  });
});

describe("admin: Embedded Signup diagnostics", () => {
  const auth = { Authorization: `Basic ${Buffer.from("admin:admin-password-123").toString("base64")}`, Origin: "http://localhost", Host: "localhost" };

  it("reports what a sign-in granted without subscribing anything or returning the token", async () => {
    await h.db.close();
    h.processor.stopTimers();
    h = await createHarness({ META_APP_ID: "111222333", WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: "987654321", WHATSAPP_GRAPH_VERSION: "v25.0" });
    const calls: string[] = [];
    h.setMetaFetch(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
      const json = url.includes("/oauth/access_token")
        ? { access_token: "BIZ-TOKEN-SECRET" }
        : url.includes("/debug_token")
          ? { data: { scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["444000"] }, { scope: "whatsapp_business_messaging", target_ids: ["444000"] }] } }
          : url.includes("/phone_numbers")
            ? { data: [{ id: "555000", display_phone_number: "+1 555-159-3890", platform_type: "CLOUD_API", is_on_biz_app: false }] }
            : { id: "444000", name: "Test WhatsApp Business Account" };
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const res = await h.app.request("http://localhost/admin/whatsapp-connect/inspect", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ code: "one-time-code" }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("BIZ-TOKEN-SECRET");
    expect(JSON.parse(text)).toEqual({
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      wabas: [{ id: "444000", name: "Test WhatsApp Business Account", numbers: [{ id: "555000", display_phone_number: "+1 555-159-3890", platform_type: "CLOUD_API", is_on_biz_app: false }] }],
    });
    expect(calls.some((c) => c.includes("subscribed_apps"))).toBe(false);

    // A plain JS SDK sign-in code only exchanges with an empty redirect_uri: retried once.
    const exchanges: string[] = [];
    h.setMetaFetch(async (input) => {
      const url = String(input);
      if (url.includes("/oauth/access_token")) {
        exchanges.push(url);
        return url.includes("redirect_uri=")
          ? new Response(JSON.stringify({ access_token: "t" }), { status: 200 })
          : new Response(JSON.stringify({ error: { message: "Error validating verification code. Please make sure your redirect_uri is identical" } }), { status: 400 });
      }
      return new Response(JSON.stringify(url.includes("/debug_token") ? { data: { scopes: ["public_profile"] } } : {}), { status: 200 });
    });
    const retried = await h.app.request("http://localhost/admin/whatsapp-connect/inspect", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ code: "js-sdk-code" }) });
    expect(await retried.json()).toEqual({ scopes: ["public_profile"], wabas: [] });
    expect(exchanges).toHaveLength(2);
    expect(exchanges[1]).toMatch(/&redirect_uri=$/);
    expect((await h.app.request("http://localhost/admin/whatsapp-connect/inspect", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" })).status).toBe(400);
  });
});
