# BABITO WhatsApp AI Agent

AI customer-service & sales agent for **BABITO (mybabito.com)** on WhatsApp.
Arabic + Hebrew (and mixed), Shopify as the source of truth, human handoff, and
guardrails that stop the model from inventing prices, stock, policies or order data.

**Stack:** Node 22 + TypeScript · Hono · WhatsApp Cloud API · Claude (provider-swappable) · Shopify Admin GraphQL · Supabase Postgres.

## What it does

- Answers product questions with **live** Shopify data (price, sale price, per-variant availability, link). Understands "بكم؟" / "כמה?" about the product just discussed.
- Order status & tracking with **ownership verification** (WhatsApp number must match the order, or the customer proves the order email).
- Order-change requests (address, cancel…) are verified and **forwarded to staff** — the AI never promises or performs them.
- Shipping/returns/payment answers come from the store's live Shopify policies + an editable knowledge base.
- **Human handoff**: on request, complaints, refunds, payment problems, uncertainty or failures. The AI goes silent until staff release the chat.
- Staff dashboard at `/admin`: conversations, AI/human mode, messages, tool calls, errors, 24h stats; reply as staff, take over, release, forget customer.
- Production plumbing: webhook signature check, idempotency, burst debouncing, per-conversation locking, retries, crash recovery, rate limiting, retention.

## Quick start

```bash
cd babito-agent
npm install
npm test            # 117 tests (unit, adapters, end-to-end on real SQL via in-memory Postgres)
cp .env.example .env
npm run chat        # chat with the real agent in your terminal (needs ANTHROPIC_API_KEY + Shopify credentials)
npm run eval        # scripted quality check: 50+ real-world scenarios -> eval-results/<time>/report.md (costs API credit)
npm run dev         # run the webhook server
```

Full setup, required credentials, deployment and monitoring: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.
Design and trade-offs: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.
Example conversations: **[docs/CONVERSATIONS.md](docs/CONVERSATIONS.md)**.

## Layout

```
src/
  index.ts              server bootstrap, sweeper, graceful shutdown
  app.ts                HTTP routes: /webhook, /health, /cron/*, /admin
  config.ts             env validation (zod)
  services.ts           dependency wiring
  whatsapp/             webhook parsing + signature, Cloud API client
  shopify/              GraphQL client (token lifecycle, retries), queries, service + pure helpers
  agent/
    agent.ts            tool loop, guardrail repair, fail-closed
    tools.ts            8 validated tools
    prompt.ts           layered prompt (core rules / business / dynamic)
    guardrails.ts       price grounding, human-request fast path
    knowledge.ts        KB + settings (cached), Shopify policies, business hours
    memory.ts           rolling summary (cheap model)
    llm.ts, anthropic.ts  provider-neutral interface + Claude adapter
  pipeline/
    processor.ts        ingest → debounce → lease → agent → send → sweeper
    handoff.ts          handoff + staff notifications
  admin/routes.ts       staff dashboard
supabase/migrations/    schema, RLS, retention function, seed settings/KB templates
test/                   unit, adapter-contract and end-to-end tests
scripts/                migrate, local chat
```

## Editing the bot's knowledge without redeploying

- **Supabase → Table Editor → `kb_articles`**: add/edit FAQ, shipping cost, payment methods, promotions, product-specific notes (`product_ids`). Active within ~60s.
- **`settings`**: `bot_enabled` (kill switch), `business_hours`, `persona_notes`, fallback texts.
- Refund/shipping/terms policies are read live from Shopify.
