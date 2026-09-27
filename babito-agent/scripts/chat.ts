/**
 * Talk to the real agent in your terminal — real Claude + real Shopify, no
 * WhatsApp needed. Uses an in-memory Postgres (PGlite), nothing is persisted,
 * and replies are printed instead of sent.
 *
 *   ANTHROPIC_API_KEY=... SHOPIFY_STORE_DOMAIN=... SHOPIFY_ADMIN_ACCESS_TOKEN=... npm run chat
 *   (optional) CHAT_PHONE=972501234567 to impersonate a customer phone for order lookups — only use your own.
 */
import { createInterface } from "node:readline/promises";
import pino from "pino";
import { loadConfig } from "../src/config.js";
import { buildServices } from "../src/services.js";
import type { WhatsAppSender } from "../src/whatsapp/client.js";
import { createTestDb } from "../test/helpers/pglite.js";

const cfg = loadConfig({
  WHATSAPP_VERIFY_TOKEN: "local-chat-only",
  WHATSAPP_ACCESS_TOKEN: "unused",
  WHATSAPP_PHONE_NUMBER_ID: "local",
  DATABASE_URL: "pglite://memory",
  DEBOUNCE_MS: "0",
  ...process.env,
  NODE_ENV: "development",
});

const console_: WhatsAppSender = {
  async sendText(_to, body) {
    process.stdout.write(`\n\x1b[36mBABITO:\x1b[0m ${body}\n\n`);
    return { waMessageId: `local.${Date.now()}` };
  },
  async markRead() {},
};

const db = await createTestDb();
const log = pino({ level: process.env.LOG_LEVEL ?? "warn" });
const s = buildServices(cfg, db, log, {
  whatsapp: console_,
  notifier: { notify: async (n) => void process.stdout.write(`\x1b[33m[handoff → staff] ${n.reason}: ${n.summary}\x1b[0m\n`) },
});
const phone = process.env.CHAT_PHONE ?? "972500000000";
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log("Local chat with the BABITO agent. Type your message (Arabic/Hebrew). Ctrl+C to exit.\n");
let n = 0;
for (;;) {
  const text = await rl.question("\x1b[32mYou:\x1b[0m ");
  if (!text.trim()) continue;
  await s.processor.ingest([{ waMessageId: `local.in.${++n}`, from: phone, profileName: "Local tester", timestamp: new Date(), type: "text", text, media: null, phoneNumberId: "local" }]);
  const [conv] = (await db.query<{ id: string }>(`select id from conversations where status='open'`)).rows;
  await s.processor.processConversation(conv!.id);
  const [run] = (await db.query<any>(`select status, latency_ms, input_tokens, output_tokens, cache_read_tokens, guardrail_flags from agent_runs order by created_at desc limit 1`)).rows;
  const tools = (await db.query<any>(`select tool_name, success from tool_calls order by created_at desc limit 5`)).rows;
  if (run) console.log(`\x1b[90m[${run.status} · ${run.latency_ms}ms · tokens in ${run.input_tokens} (cached ${run.cache_read_tokens}) out ${run.output_tokens} · tools: ${tools.map((t: any) => t.tool_name + (t.success ? "" : "✗")).join(", ") || "none"}${run.guardrail_flags.length ? " · flags " + run.guardrail_flags : ""}]\x1b[0m`);
}
