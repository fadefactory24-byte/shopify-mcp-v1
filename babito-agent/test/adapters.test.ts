import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/agent/anthropic.js";
import { ShopifyError, ShopifyGraphQLClient } from "../src/shopify/client.js";
import { LiveShopifyService } from "../src/shopify/service.js";
import { WhatsAppApiError, WhatsAppCloudClient } from "../src/whatsapp/client.js";

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

  it("does not retry business errors like the 24h window (131047)", async () => {
    const { f, calls } = mockFetch([json({ error: { message: "Re-engagement message", code: 131047 } }, 400)]);
    const c = new WhatsAppCloudClient({ accessToken: "tok", phoneNumberId: "PNID", graphVersion: "v23.0", fetchImpl: f });
    await expect(c.sendText("972501234567", "hi")).rejects.toBeInstanceOf(WhatsAppApiError);
    expect(calls).toHaveLength(1);
  });
});
