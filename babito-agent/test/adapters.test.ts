import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/agent/anthropic.js";
import { ShopifyError, ShopifyGraphQLClient } from "../src/shopify/client.js";
import { LiveShopifyService } from "../src/shopify/service.js";
import { SeventeenTrack } from "../src/tracking/tracking.js";
import { SocialApiError, SocialSender } from "../src/social/client.js";
import { isPermanentSendError, WhatsAppApiError, WhatsAppCloudClient } from "../src/whatsapp/client.js";

type Call = { url: string; init: RequestInit };
function mockFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("no more mock responses");
    return next();
  }) as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("AnthropicProvider request contract", () => {
  it("caches the static prompt, enables adaptive thinking + effort + refusal fallback, maps tool calls", async () => {
    const { f, calls } = mockFetch([
      json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "tool_use", id: "tu_1", name: "search_products", input: { query: "מכשיר חנק" } },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 40 },
      }),
    ]);
    const p = new AnthropicProvider({ apiKey: "k", refusalFallback: true, fetchImpl: f, maxRetries: 0 });
    const res = await p.complete({
      model: "claude-opus-5",
      systemStatic: "STATIC",
      systemDynamic: "DYNAMIC",
      tools: [{ name: "search_products", description: "d", inputSchema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxTokens: 1000,
      effort: "low",
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.system[0]).toMatchObject({ text: "STATIC", cache_control: { type: "ephemeral" } });
    expect(body.system[1]).toEqual({ type: "text", text: "DYNAMIC" });
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.fallbacks).toBe("default");
    expect(body.tools[0].input_schema).toEqual({ type: "object", properties: {} });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(res.stopReason).toBe("tool_use");
    expect(res.content).toEqual([{ type: "tool_use", id: "tu_1", name: "search_products", input: { query: "מכשיר חנק" } }]);
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 0 });
    // Thinking blocks are kept in raw so they can be echoed back inside the tool loop.
    expect((res.raw as any[])[0].type).toBe("thinking");
  });

  it("lightweight calls skip thinking and fallbacks", async () => {
    const { f, calls } = mockFetch([
      json({ id: "m", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "sum" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
    ]);
    const p = new AnthropicProvider({ apiKey: "k", refusalFallback: true, fetchImpl: f, maxRetries: 0 });
    await p.complete({ model: "claude-haiku-4-5", systemStatic: "S", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }], maxTokens: 100, lightweight: true });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.thinking).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
    expect(body.cache_control).toBeUndefined();
  });
});

describe("Shopify client", () => {
  it("retries throttling, then returns data", async () => {
    const { f, calls } = mockFetch([json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }), json({ data: { shop: { shopPolicies: [] } } })]);
    const c = new ShopifyGraphQLClient({ storeDomain: "s.myshopify.com", apiVersion: "2026-07", staticToken: "shpat", fetchImpl: f });
    await expect(c.query("{ shop { name } }")).resolves.toEqual({ shop: { shopPolicies: [] } });
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init.headers as HeadersInit).get("x-shopify-access-token")).toBe("shpat");
  });

  it("reports unavailability after repeated 5xx", async () => {
    const { f } = mockFetch([json({}, 503), json({}, 503), json({}, 503)]);
    const c = new ShopifyGraphQLClient({ storeDomain: "s.myshopify.com", apiVersion: "2026-07", staticToken: "t", fetchImpl: f });
    await expect(c.query("{x}")).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("does not retry GraphQL query errors", async () => {
    const { f, calls } = mockFetch([json({ errors: [{ message: "Field 'x' doesn't exist" }] })]);
    const c = new ShopifyGraphQLClient({ storeDomain: "s.myshopify.com", apiVersion: "2026-07", staticToken: "t", fetchImpl: f });
    await expect(c.query("{x}")).rejects.toBeInstanceOf(ShopifyError);
    expect(calls).toHaveLength(1);
  });

  it("client-credentials mode fetches a token first", async () => {
    const { f, calls } = mockFetch([json({ access_token: "fresh", expires_in: 86399 }), json({ data: { ok: true } })]);
    const c = new ShopifyGraphQLClient({ storeDomain: "s.myshopify.com", apiVersion: "2026-07", clientId: "id", clientSecret: "sec", fetchImpl: f });
    await c.query("{ok}");
    expect(calls[0]!.url).toBe("https://s.myshopify.com/admin/oauth/access_token");
    expect(new Headers(calls[1]!.init.headers as HeadersInit).get("x-shopify-access-token")).toBe("fresh");
  });

  it("service verifies phone matches itself (Shopify phone search is fuzzy)", async () => {
    const { f } = mockFetch([
      json({ data: { customers: { nodes: [{ id: "gid://shopify/Customer/9", firstName: "X", defaultPhoneNumber: { phoneNumber: "+972529999999" }, orders: { nodes: [] } }] } } }),
    ]);
    const svc = new LiveShopifyService(new ShopifyGraphQLClient({ storeDomain: "s", apiVersion: "v", staticToken: "t", fetchImpl: f }), { storePublicUrl: "https://mybabito.com" });
    expect(await svc.findOrdersByPhone("972501234567")).toBeNull();
  });
});

describe("WhatsApp client", () => {
  it("sends text and retries a 500", async () => {
    const { f, calls } = mockFetch([json({ error: { message: "oops" } }, 500), json({ messages: [{ id: "wamid.1" }] })]);
    const c = new WhatsAppCloudClient({ accessToken: "tok", phoneNumberId: "PNID", graphVersion: "v23.0", fetchImpl: f });
    await expect(c.sendText("972501234567", "hi")).resolves.toEqual({ waMessageId: "wamid.1" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://graph.facebook.com/v23.0/PNID/messages");
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ messaging_product: "whatsapp", to: "972501234567", type: "text", text: { body: "hi" } });
  });

  it("sends a template with body params, for staff alerts outside the 24h window", async () => {
    const { f, calls } = mockFetch([json({ messages: [{ id: "wamid.tpl.1" }] })]);
    const c = new WhatsAppCloudClient({ accessToken: "tok", phoneNumberId: "PNID", graphVersion: "v23.0", fetchImpl: f });
    await expect(c.sendTemplate("972507406322", "babito_staff_handoff", "en", ["Dana Levi", "product_problem", "strap broke"])).resolves.toEqual({
      waMessageId: "wamid.tpl.1",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      messaging_product: "whatsapp",
      to: "972507406322",
      type: "template",
      template: {
        name: "babito_staff_handoff",
        language: { code: "en" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Dana Levi" }, { type: "text", text: "product_problem" }, { type: "text", text: "strap broke" }] }],
      },
    });
  });

  it("downloads media in two authenticated steps and refuses oversized files", async () => {
    const { f, calls } = mockFetch([
      json({ url: "https://lookaside.fbsbx.com/media/abc", mime_type: "image/jpeg", file_size: 3 }),
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }),
      json({ url: "https://lookaside.fbsbx.com/media/big", mime_type: "video/mp4", file_size: 90_000_000 }),
    ]);
    const c = new WhatsAppCloudClient({ accessToken: "tok", phoneNumberId: "PNID", graphVersion: "v23.0", fetchImpl: f });
    const media = await c.downloadMedia("MEDIA1");
    expect(media.contentType).toBe("image/jpeg");
    expect(media.data.byteLength).toBe(3);
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/MEDIA1");
    expect(calls.map((x) => new Headers(x.init.headers as HeadersInit).get("authorization"))).toEqual(["Bearer tok", "Bearer tok"]);
    await expect(c.downloadMedia("BIG")).rejects.toThrow("too large");
  });

  it("does not retry business errors like the 24h window (131047)", async () => {
    const { f, calls } = mockFetch([json({ error: { message: "Re-engagement message", code: 131047 } }, 400)]);
    const c = new WhatsAppCloudClient({ accessToken: "tok", phoneNumberId: "PNID", graphVersion: "v23.0", fetchImpl: f });
    const err = await c.sendText("972501234567", "hi").catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppApiError);
    expect(isPermanentSendError(err)).toBe(true); // the sweeper won't resend it either
    expect(calls).toHaveLength(1);
    expect(isPermanentSendError(new WhatsAppApiError("WhatsApp API 500: boom", 500))).toBe(false);
  });
});

describe("Social (Messenger/Instagram) client", () => {
  const opts = { pageAccessToken: "page-tok", pageId: "PAGE_ID", instagramId: "IG_ID", graphVersion: "v23.0" };

  it("sends a Messenger reply to the page's own /me/messages endpoint", async () => {
    const { f, calls } = mockFetch([json({ recipient_id: "PSID1", message_id: "m.1" })]);
    const c = new SocialSender({ ...opts, fetchImpl: f });
    await expect(c.sendText("psid:PSID1", "hi")).resolves.toEqual({ waMessageId: "m.1" });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/me/messages");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ recipient: { id: "PSID1" }, message: { text: "hi" } });
    expect(new Headers(calls[0]!.init.headers as HeadersInit).get("authorization")).toBe("Bearer page-tok");
  });

  it("sends an Instagram reply to the IG account's own /messages endpoint", async () => {
    const { f, calls } = mockFetch([json({ recipient_id: "IGSID1", message_id: "m.2" })]);
    const c = new SocialSender({ ...opts, fetchImpl: f });
    await expect(c.sendText("igsid:IGSID1", "hi")).resolves.toEqual({ waMessageId: "m.2" });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/IG_ID/messages");
  });

  it("throws SocialApiError on a Graph API error, and rejects a non-social handle", async () => {
    const { f } = mockFetch([json({ error: { message: "invalid token" } }, 401)]);
    const c = new SocialSender({ ...opts, fetchImpl: f });
    const err = await c.sendText("psid:PSID1", "hi").catch((e) => e);
    expect(err).toBeInstanceOf(SocialApiError);
    expect((err as SocialApiError).status).toBe(401);
    await expect(c.sendText("972501234567", "hi")).rejects.toBeInstanceOf(SocialApiError);
  });
});

describe("17TRACK client", () => {
  const info = (status: string, sub: string) => ({ code: 0, data: { accepted: [{ number: "UL1YP", track_info: { latest_status: { status, sub_status: sub }, latest_event: { time_iso: "2026-09-26T10:00:00+08:00", location: "SOMEWHERE", description: "event" } } }], rejected: [] } });
  it("registers an unknown parcel once, then reads its stage; caches the answer", async () => {
    const { f, calls } = mockFetch([
      json({ code: 0, data: { accepted: [], rejected: [{ number: "UL1YP", error: { code: -18019902, message: "not registered" } }] } }),
      json({ code: 0, data: { accepted: [{ number: "UL1YP", carrier: 190012 }], rejected: [] } }),
      json(info("InTransit", "InTransit_Arrival")),
    ]);
    const t = new SeventeenTrack({ apiKey: "k", fetchImpl: f });
    expect(await t.status("UL1YP", 190012)).toEqual({ stage: "final_leg", lastUpdate: "2026-09-26" });
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["gettrackinfo", "register", "gettrackinfo"]);
    expect(new Headers(calls[0]!.init.headers as HeadersInit).get("17token")).toBe("k");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual([{ number: "UL1YP", carrier: 190012 }]);
    await t.status("UL1YP", 190012);
    expect(calls).toHaveLength(3); // served from cache
  });
  it("returns null (fallback to Shopify) on API errors instead of throwing", async () => {
    const { f } = mockFetch([json({ code: -1, data: null }), json({}, 500)]);
    const t = new SeventeenTrack({ apiKey: "k", fetchImpl: f });
    expect(await t.status("A1")).toBeNull();
    expect(await t.status("A2")).toBeNull();
  });
});

describe("GroqTranscriber", () => {
  it("posts the voice note as multipart to Groq's transcription endpoint and returns the text", async () => {
    const { GroqTranscriber } = await import("../src/util/transcribe.js");
    let seen: { url: string; auth: string | null; model: unknown; file: unknown } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      seen = { url, auth: new Headers(init.headers).get("authorization"), model: form.get("model"), file: form.get("file") };
      return new Response(JSON.stringify({ text: " قلها رح نبعتلها بديل " }), { status: 200 });
    }) as unknown as typeof fetch;
    const t = new GroqTranscriber({ apiKey: "gsk_test", model: "whisper-large-v3", fetchImpl });
    const text = await t.transcribe(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer, "audio/ogg; codecs=opus");
    expect(text).toBe("قلها رح نبعتلها بديل");
    expect(seen!.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(seen!.auth).toBe("Bearer gsk_test");
    expect(seen!.model).toBe("whisper-large-v3");
    expect((seen!.file as File).name).toBe("voice.ogg");
  });

  it("throws on an API error (the relay then asks staff to retry or write)", async () => {
    const { GroqTranscriber } = await import("../src/util/transcribe.js");
    const fetchImpl = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const t = new GroqTranscriber({ apiKey: "k", model: "whisper-large-v3", fetchImpl });
    await expect(t.transcribe(new ArrayBuffer(1), "audio/ogg")).rejects.toThrow("429");
  });
});
