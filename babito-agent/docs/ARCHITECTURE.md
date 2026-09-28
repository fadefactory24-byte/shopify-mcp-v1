# Architecture

## Overview

```
 WhatsApp user
      │  (message)
      ▼
 Meta WhatsApp Cloud API ──webhook POST──► /webhook  (Hono, Node 22)
                                             │ 1. verify X-Hub-Signature-256
                                             │ 2. parse (lenient zod), ignore other numbers
                                             │ 3. INSERT message  ── unique(wa_message_id) = idempotency
                                             │ 4. 200 OK  (durable before ack)
                                             ▼
                                   MessageProcessor
                                             │ debounce 2.5s per conversation (bursts → 1 run)
                                             │ DB lease on the conversation (one worker at a time)
                                             │ guards: human mode · bot switch · blocked · rate limit
                                             │ fast paths: "I want a human" · voice/image → no LLM
                                             ▼
                                        Agent loop  ──► Claude (tools + cached prompt)
                                             │  tools: search_products · get_product · get_my_orders
                                             │         get_order_status · request_order_change
                                             │         get_knowledge · handoff_to_human · remember_customer_fact
                                             │  ──► Shopify Admin GraphQL (source of truth)
                                             │  ──► Supabase (KB, memory, handoffs)
                                             │ guardrail: every ₪ amount must come from a tool result
                                             ▼
                                  send via Cloud API (retry 429/5xx) ──► customer
                                             │
                             Sweeper (15s): stuck messages · failed sends · crash recovery
```

Single deployable Node service + Supabase Postgres. No queue broker: the
`messages` table *is* the queue (`received → processing → processed/skipped/failed`),
which keeps the MVP simple and fully recoverable after a crash.

## Decisions (and what I changed from the brief)

| Decision | Why |
|---|---|
| **Core agent in code, not n8n.** n8n is optional, used only as a notification sink (`STAFF_NOTIFY_WEBHOOK_URL`) and later for campaigns. | Idempotency, per-conversation locking, guardrails, and 90+ automated tests are hard to do reliably in n8n. The critical path must be versioned, testable code. |
| **Long-running Node server (Railway/Fly/Render), not Vercel functions.** | Debouncing, the sweeper, and fire-and-forget work need a process that stays alive. Vercel is fine later for a Next.js dashboard. |
| **Direct Postgres (`DATABASE_URL`) instead of supabase-js + service-role key.** | Transactions, leases and atomic claims need real SQL. There is no Supabase key in the app at all; RLS is on with no policies, so browser keys (anon/authenticated) can read nothing. |
| **Merged tools**: `get_product` includes availability (no separate `get_product_inventory`); `get_order_status` includes tracking (no separate `track_order`); `request_order_change` replaces `create_support_ticket` for order issues; shipping info comes from `get_knowledge`. | Fewer tools = fewer wrong tool choices and fewer tokens. Every tool has a clear job. |
| **Local catalog search** over the live product list (cached 60s). | All 42 product titles are Hebrew; Shopify search tokenizes Hebrew/Arabic unreliably. The model translates the customer's words to Hebrew keywords; ranking is deterministic and tested. Switch to Shopify query search if the catalog grows past a few hundred products. |
| **Never expose stock quantities.** | The store's inventory numbers are not meaningful to customers (e.g. 976,662 units, negative values on "continue selling" variants). We use Shopify's `availableForSale` per variant. |
| **Order changes are never executed by the AI.** | `request_order_change` verifies ownership, checks shipping stage, and hands off to staff (high priority if not yet shipped). Safe by construction. |
| **Shopify legal policies read live** (`policy.refund`, `policy.shipping`, `policy.terms`). | The store already maintains them in Shopify; duplicating them in the DB would drift. |

## Data ownership

| Data | Where | Notes |
|---|---|---|
| Products, prices, availability, orders, tracking, policies | **Shopify (live)** | Never stored; catalog index cached ≤60s, policies ≤10min |
| Customers (WhatsApp identity), conversations, messages | Supabase | `wa_id` unique; one open conversation per customer |
| Agent runs, tool calls | Supabase | For debugging/analytics; purged after 60 days |
| Handoffs | Supabase | One active per conversation (partial unique index) |
| Customer memory | Supabase `customer_memories` | Whitelisted keys only, 300 chars, deletable, optional expiry |
| Knowledge base | Supabase `kb_articles` | Edit in Supabase Table Editor; live within 60s |
| Runtime settings | Supabase `settings` | Bot on/off, hours, tone, fallback texts |

## Memory model

1. **Conversation history** — `messages`; the model sees the last 16 text messages (tool traffic of past turns is not replayed).
2. **Short-term context** — `conversations.context` (JSON): recently discussed products (id+title), orders the customer proved ownership of, verification throttling. Written deterministically by tools, not by the model. This is what makes "بكم؟" work.
3. **Rolling summary** — `conversations.summary`, produced by the cheap model once a chat exceeds the window. Never contains prices or contact data.
4. **Customer memory** — `customer_memories`: name, child's age (expires after 1 year), interests, notes. The tool refuses anything that looks sensitive.
5. **Business knowledge** — `kb_articles` + live Shopify policies, fetched on demand via `get_knowledge`; only a key/title index sits in the prompt.
6. **System settings** — `settings`.

Retention: `purge_old_data()` (called by `POST /cron/maintenance`) deletes tool calls/runs > 60 days, messages > 180 days, expired memories, and closes stale conversations. "Forget customer" in the dashboard wipes memories and message texts.

## Prompt architecture (token-efficient, cache-friendly)

```
tools (8 definitions)                      ┐ cached
system[0] CORE_RULES (code, versioned)     │ (prompt caching breakpoint)
          + business layer (tone notes,    │
            knowledge index, staff hours)  ┘
system[1] dynamic: time, staff available?, customer name & memories,
          reply language, summary, recent products, verified orders   (not cached)
messages: last 16 text messages + this turn's tool calls
```

No store facts live in the prompt — prices, policies and shipping times are always tool results, which is also what the price guardrail checks against.

## Security

- Webhook: HMAC-SHA256 signature verified with the app secret (required in production); constant-time comparison.
- Ownership for order data: WhatsApp number (verified by WhatsApp) must match a phone on the Shopify order/customer, **or** the customer provides the order email. Contact data is used for matching in code and is never shown to the model. 5 failed attempts/hour → blocked.
- All tool inputs are validated with zod before execution (product IDs must be Shopify GIDs, order numbers are reduced to digits — no search-query injection).
- The model cannot mutate anything in Shopify: the app only needs read scopes.
- Prompt-injection posture: customer text is untrusted; rules live in the system prompt; dangerous actions don't exist as tools.
- Admin dashboard: HTTP Basic auth + same-origin check on every POST (CSRF). All admin actions go to `audit_log`.
- Logs: structured JSON, phone numbers masked, secret-like fields redacted, message bodies off by default.

## Reliability

| Failure | Behaviour |
|---|---|
| Duplicate webhook | Unique `wa_message_id` → second insert is a no-op |
| Webhook burst | Debounced into one agent run |
| Two instances / concurrent webhooks | Conversation lease (`processing_until`, `processing_owner`) — only one processor at a time; renewed every 60s during a run, extended/released only by its owner |
| Error while processing a batch | Messages go straight back to `received`; the sweeper retries them (max 3 attempts), then the customer gets the handoff text and staff get the chat |
| Crash mid-processing | Lease expires → sweeper resets messages to `received` → reprocessed (max 3 attempts, then handoff as above). On SIGTERM, runs still going after 90s are re-queued and their leases released |
| Shopify down / throttled | 2 retries with backoff; then the tool returns `store_system_unavailable` and the model says it can't check now |
| Claude down / refusal / guardrail fails twice | Fail closed: fallback text + human handoff; nothing invented |
| WhatsApp send fails | Stored as `failed`; sweeper retries within 3 minutes (stale replies are not resent). Errors a resend can't fix (131047 outside the 24h window, 131026 undeliverable…) are not retried |
| Human took over | AI silent until staff release the chat or 24h of staff inactivity |

## Extension points

- **Voice notes**: download media by id → transcribe → feed text into the same pipeline (`handleBatch` already separates media).
- **Images**: pass image blocks to Claude (vision) for "is this the product?" / damaged-item photos.
- **Order actions**: add a tool that creates a *draft* action requiring customer confirmation + staff approval.
- **Campaigns / abandoned carts / proactive messages**: require approved WhatsApp templates; add a `campaigns` table and a template sender. Can be orchestrated from n8n.
- **Another LLM provider**: implement `LLMProvider` (`src/agent/llm.ts`) — one adapter file.
- **Semantic KB search**: add `pgvector` embeddings to `kb_articles` when the KB outgrows the index-in-prompt approach.
