/**
 * Batch quality check: runs the scenarios in scripts/eval-scenarios.ts through
 * the real agent (real Claude + real Shopify, in-memory DB, nothing is sent on
 * WhatsApp) and writes a transcript + scorecard to eval-results/<timestamp>/.
 *
 *   npm run eval -- --dry-run                 # list scenarios + cost estimate, no API calls
 *   npm run eval                              # all scenarios (needs ANTHROPIC_API_KEY + Shopify creds in .env)
 *   npm run eval -- --only ar-strollers,he-hi # selected scenarios
 *   npm run eval -- --category shipping
 *   EVAL_KB_FILE=kb-draft.json npm run eval   # test draft knowledge-base answers before activating them in Supabase
 *   AI_MODEL_MAIN=claude-sonnet-5 npm run eval # compare models
 *
 * Without Shopify Admin credentials the catalog and policies come from the
 * store's public storefront JSON (live data); order lookups then use fixtures.
 *
 * Costs real API money (see --dry-run for an estimate). Re-run after every
 * prompt change and compare reports.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { AnthropicProvider } from "../src/agent/anthropic.js";
import type { LLMProvider } from "../src/agent/llm.js";
import { loadConfig } from "../src/config.js";
import { detectLanguage } from "../src/util/text.js";
import { buildServices } from "../src/services.js";
import type { WhatsAppSender } from "../src/whatsapp/client.js";
import { createTestDb } from "../test/helpers/pglite.js";
import { SCENARIOS, type Scenario } from "./eval-scenarios.js";
import { PublicStorefrontShopify } from "./eval-storefront.js";

// USD per million tokens: [uncached input, cache read, output]. Cache writes (5-minute TTL) cost 1.25x input and are counted separately.
const PRICES: Record<string, [number, number, number]> = {
  "claude-opus-5": [5, 0.5, 25],
  "claude-opus-5-5": [4, 0.4, 20],
  "claude-sonnet-5": [2, 0.2, 10],
  "claude-haiku-4-5": [1, 0.1, 5],
};
const EST_USD_PER_TURN = 0.025; // measured on claude-opus-5 at low effort with prompt caching (2026-09-28)

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const only = flag("only")?.split(",").map((s) => s.trim()).filter(Boolean);
const category = flag("category");
const dryRun = args.includes("--dry-run");

const scenarios = SCENARIOS.filter((s) => (!only || only.includes(s.id)) && (!category || s.category === category));
const totalTurns = scenarios.reduce((n, s) => n + s.turns.length, 0);

if (dryRun) {
  for (const s of scenarios) console.log(`${s.id.padEnd(24)} ${s.category.padEnd(12)} ${s.lang}  ${s.turns.join("  ⏎  ")}`);
  console.log(`\n${scenarios.length} scenarios, ${totalTurns} customer turns. Estimated cost on claude-opus-5: ~$${(totalTurns * EST_USD_PER_TURN).toFixed(2)}`);
  process.exit(0);
}

const hasAdminCreds = Boolean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET));
const cfg = loadConfig({
  WHATSAPP_VERIFY_TOKEN: "local-eval-only",
  WHATSAPP_ACCESS_TOKEN: "unused",
  WHATSAPP_PHONE_NUMBER_ID: "local",
  DATABASE_URL: "pglite://memory",
  ...(hasAdminCreds ? {} : { SHOPIFY_STORE_DOMAIN: "public-storefront", SHOPIFY_ADMIN_ACCESS_TOKEN: "unused" }),
  ...process.env,
  DEBOUNCE_MS: "0",
  NODE_ENV: "development",
});
if (!cfg.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (put it in .env)");
const storefront = hasAdminCreds ? null : new PublicStorefrontShopify(cfg.STORE_PUBLIC_URL);
if (storefront) console.log(`No Shopify Admin credentials: using live public storefront data from ${cfg.STORE_PUBLIC_URL} (orders are fixtures).\n`);

const sent = new Map<string, string[]>();
const capture: WhatsAppSender = {
  async sendText(to, body) {
    sent.set(to, [...(sent.get(to) ?? []), body]);
    return { waMessageId: `eval.${Date.now()}.${Math.random()}` };
  },
  async markRead() {},
};
const handoffs: { phone: string; reason: string; summary: string | null }[] = [];

const db = await createTestDb();
const log = pino({ level: process.env.LOG_LEVEL ?? "silent" });
// Count cache-write tokens per scenario (agent_runs doesn't store them).
let cacheWrites = 0;
const anthropic = new AnthropicProvider({ apiKey: cfg.ANTHROPIC_API_KEY, refusalFallback: cfg.AI_REFUSAL_FALLBACK });
const llm: LLMProvider = {
  async complete(req) {
    const res = await anthropic.complete(req);
    cacheWrites += res.usage.cacheWriteTokens ?? 0;
    return res;
  },
};
const services = buildServices(cfg, db, log, {
  llm,
  ...(storefront ? { shopify: storefront } : {}),
  whatsapp: capture,
  notifier: { notify: async (n) => void handoffs.push({ phone: n.customerWaId, reason: n.reason, summary: n.summary }) },
});

const kbFile = process.env.EVAL_KB_FILE;
if (kbFile) {
  const rows = JSON.parse(readFileSync(kbFile, "utf8")) as { key: string; category: string; title: string; content: string; language?: string }[];
  for (const r of rows) {
    await db.query(
      `insert into kb_articles (key, category, title, content, language, is_active) values ($1,$2,$3,$4,$5,true)
       on conflict (key) do update set category = excluded.category, title = excluded.title, content = excluded.content, language = excluded.language, is_active = true`,
      [r.key, r.category, r.title, r.content, r.language ?? "he"],
    );
  }
  console.log(`Loaded ${rows.length} KB article(s) from ${kbFile}`);
}

interface TurnResult {
  customer: string;
  replies: string[];
  status: string | null;
  tools: string[];
  flags: string[];
  latencyMs: number | null;
  tokens: { input: number; cacheRead: number; output: number };
}
interface ScenarioResult {
  scenario: Scenario;
  turns: TurnResult[];
  finalMode: string;
  checks: { name: string; pass: boolean; detail?: string }[];
  usd: number;
}

const price = PRICES[cfg.AI_MODEL_MAIN];
const results: ScenarioResult[] = [];
let idx = 0;
for (const s of scenarios) {
  idx++;
  const phone = `1555555${String(100 + idx).padStart(4, "0")}`; // fictional numbers; never match a real Shopify customer
  const turns: TurnResult[] = [];
  cacheWrites = 0;
  let convId: string | null = null;
  let lastRunId: string | null = null;
  for (const [t, text] of s.turns.entries()) {
    const before = sent.get(phone)?.length ?? 0;
    const { conversationIds } = await services.processor.ingest([
      { waMessageId: `eval.${s.id}.${t}`, from: phone, profileName: "Eval customer", timestamp: new Date(), type: "text", text, media: null, phoneNumberId: "local" },
    ]);
    convId = conversationIds[0] ?? convId;
    if (convId) await services.processor.processConversation(convId);
    await services.processor.drain(120_000); // in case ingest also scheduled a run
    const [run] = (
      await db.query<any>(
        `select id, status, latency_ms, input_tokens, output_tokens, cache_read_tokens, guardrail_flags from agent_runs where conversation_id = $1 order by created_at desc limit 1`,
        [convId],
      )
    ).rows;
    const fresh: any = run && run.id !== lastRunId ? run : null;
    if (fresh) lastRunId = fresh.id;
    const tools = fresh ? (await db.query<any>(`select tool_name, success from tool_calls where agent_run_id = $1 order by created_at`, [fresh.id])).rows : [];
    turns.push({
      customer: text,
      replies: (sent.get(phone) ?? []).slice(before),
      status: fresh?.status ?? null,
      tools: tools.map((x: any) => x.tool_name + (x.success ? "" : "✗")),
      flags: fresh?.guardrail_flags ?? [],
      latencyMs: fresh?.latency_ms ?? null,
      tokens: { input: fresh?.input_tokens ?? 0, cacheRead: fresh?.cache_read_tokens ?? 0, output: fresh?.output_tokens ?? 0 },
    });
  }
  const [conv] = (await db.query<any>(`select mode from conversations where id = $1`, [convId])).rows;
  const finalMode = conv?.mode ?? "?";
  const allReplies = turns.flatMap((t) => t.replies).join("\n");
  const allTools = new Set(turns.flatMap((t) => t.tools.map((x) => x.replace("✗", ""))));
  const checks: ScenarioResult["checks"] = [];
  const e = s.expect ?? {};
  if (e.tools) checks.push({ name: "tools", pass: e.tools.some((x) => allTools.has(x)), detail: `wanted one of ${e.tools.join("/")}` });
  if (e.handoff !== undefined) checks.push({ name: "handoff", pass: (finalMode === "human") === e.handoff, detail: `mode=${finalMode}` });
  for (const re of e.forbid ?? []) checks.push({ name: "forbid", pass: !re.test(allReplies), detail: String(re) });
  for (const re of e.require ?? []) checks.push({ name: "require", pass: re.test(allReplies), detail: String(re) });
  checks.push({ name: "replied", pass: allReplies.trim().length > 0 });
  // Every reply in the customer's language (URLs carry Hebrew product handles, so strip them first).
  const langs = turns.flatMap((t) => t.replies).map((r) => detectLanguage(r.replace(/https?:\/\/\S+/g, "")));
  checks.push({ name: "language", pass: langs.every((l) => l === null || l === s.lang), detail: `wanted ${s.lang}, got ${langs.join(",")}` });
  checks.push({ name: "no_failed_run", pass: !turns.some((t) => t.status === "failed"), detail: turns.map((t) => t.status ?? "-").join(",") });
  const tok = turns.reduce((a, t) => ({ input: a.input + t.tokens.input, cacheRead: a.cacheRead + t.tokens.cacheRead, output: a.output + t.tokens.output }), { input: 0, cacheRead: 0, output: 0 });
  const usd = price ? (tok.input * price[0] + cacheWrites * price[0] * 1.25 + tok.cacheRead * price[1] + tok.output * price[2]) / 1e6 : 0;
  results.push({ scenario: s, turns, finalMode, checks, usd });
  const ok = checks.every((c) => c.pass);
  console.log(`${ok ? "PASS" : "FAIL"}  ${s.id.padEnd(24)} $${usd.toFixed(3)}  ${turns.map((t) => t.tools.join("+") || "-").join(" | ")}`);
}

// ---------------------------------------------------------------- report
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(import.meta.dirname, "..", "eval-results", stamp);
mkdirSync(outDir, { recursive: true });
const passed = results.filter((r) => r.checks.every((c) => c.pass)).length;
const totalUsd = results.reduce((a, r) => a + r.usd, 0);
const lat = results.flatMap((r) => r.turns.map((t) => t.latencyMs)).filter((x): x is number => x != null).sort((a, b) => a - b);
const p = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : 0);
const md: string[] = [
  `# BABITO agent eval — ${stamp}`,
  ``,
  `Model: \`${cfg.AI_MODEL_MAIN}\` (effort ${cfg.AI_MODEL_MAIN_EFFORT}) · store: ${storefront ? `${cfg.STORE_PUBLIC_URL} (public storefront data, fixture orders)` : cfg.SHOPIFY_STORE_DOMAIN}${kbFile ? ` · KB draft: ${kbFile}` : " · KB: seeded templates (inactive)"}`,
  ``,
  `**Automatic checks passed: ${passed}/${results.length}** · cost ≈ $${totalUsd.toFixed(2)} ($${(totalUsd / Math.max(1, totalTurns)).toFixed(3)}/turn) · latency p50 ${p(0.5)} ms, p90 ${p(0.9)} ms`,
  ``,
  `Automatic checks only catch the obvious. Read every transcript against its "good" line.`,
  ``,
];
for (const r of results) {
  const ok = r.checks.every((c) => c.pass);
  md.push(`## ${ok ? "✅" : "❌"} ${r.scenario.id} (${r.scenario.category}, ${r.scenario.lang})`, ``);
  md.push(`*Good looks like:* ${r.scenario.good}`, ``);
  for (const t of r.turns) {
    md.push(`> **Customer:** ${t.customer}`);
    md.push(`> *(${t.status ?? "no agent run"}${t.tools.length ? ` · tools: ${t.tools.join(", ")}` : ""}${t.flags.length ? ` · flags: ${t.flags.join(",")}` : ""}${t.latencyMs != null ? ` · ${t.latencyMs} ms` : ""})*`);
    for (const reply of t.replies.length ? t.replies : ["*(no reply sent)*"]) md.push(`> **BABITO:** ${reply.replace(/\n/g, "\n> ")}`);
    md.push(`>`);
  }
  const failed = r.checks.filter((c) => !c.pass);
  md.push(``, failed.length ? `Failed checks: ${failed.map((c) => `${c.name} (${c.detail ?? ""})`).join("; ")}` : `All checks passed.`, `Final mode: ${r.finalMode} · cost $${r.usd.toFixed(3)}`, ``);
}
if (handoffs.length) {
  md.push(`## Staff notifications (handoffs)`, ``);
  for (const h of handoffs) md.push(`- ${h.reason}: ${h.summary}`);
}
writeFileSync(join(outDir, "report.md"), md.join("\n"));
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, (_k, v) => (v instanceof RegExp ? String(v) : v), 2));
console.log(`\n${passed}/${results.length} scenarios passed automatic checks · ≈ $${totalUsd.toFixed(2)} · report: ${join(outDir, "report.md")}`);
await db.close();
process.exit(0);
