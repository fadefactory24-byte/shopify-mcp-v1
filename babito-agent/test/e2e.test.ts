import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool, CHOKING_ID, CUSTOMER_PHONE, lastToolResults, mediaWebhook, refuse, say, statusWebhook, textWebhook } from "./helpers/fakes.js";
import { createHarness, type Harness } from "./helpers/harness.js";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
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
      // Contact data never reaches the model.
      expect(JSON.stringify(res!.content)).not.toContain("mom@example.com");
      expect(JSON.stringify(res!.content)).not.toContain("123-4567");
      return say(`طلبك ${o.order_number} انبعت مع ${o.tracking[0].company}، رقم التتبع ${o.tracking[0].number}`)(req);
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

  it("voice note: polite text-only reply, no LLM cost", async () => {
    await h.customerSays(mediaWebhook(CUSTOMER_PHONE, "audio"));
    expect(h.llm.requests).toHaveLength(0);
    expect(h.whatsapp.sent).toHaveLength(1);
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
