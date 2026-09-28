# Setup & production deployment

## 1. What you need to provide

| Item | Where to get it |
|---|---|
| **Supabase project** (dedicated to this bot) | supabase.com → New project. Then Project Settings → Database → *Connection string* (Session pooler URI) → `DATABASE_URL`. |
| **Meta app + WhatsApp Business Account** | developers.facebook.com → Create app (Business) → add *WhatsApp*. From *API Setup*: `WHATSAPP_PHONE_NUMBER_ID`. From *App settings → Basic*: `WHATSAPP_APP_SECRET`. |
| **Permanent WhatsApp token** | business.facebook.com → Business settings → System users → add admin system user → assign the app and the WhatsApp account → Generate token with `whatsapp_business_messaging` + `whatsapp_business_management` → `WHATSAPP_ACCESS_TOKEN`. (The temporary token in API Setup expires in 24h.) |
| **A phone number for the bot** | Either a new number, or your current business number. If the number is in use in the WhatsApp Business app, check Meta's *coexistence* onboarding so staff can keep using the app (staff messages then arrive as echoes and put the chat into human mode). |
| **Shopify Admin API access** | Shopify no longer allows *new* admin-created custom apps (`shpat_…` tokens), so create an app in the **Dev Dashboard** (dev.shopify.com), install it on the BABITO store, and use its client ID + secret (`SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`; the token refreshes automatically). An existing `shpat_` token still works if you already have one. Scopes: `read_products, read_orders, read_customers, read_fulfillments, read_legal_policies` (+ `read_all_orders` for orders older than 60 days). **Read-only is enough.** |
| **Anthropic API key** | console.anthropic.com → API keys → `ANTHROPIC_API_KEY`. |
| Optional: staff notification webhook | An n8n/Make/Slack incoming webhook URL → `STAFF_NOTIFY_WEBHOOK_URL`. |

## 2. Local development

```bash
cd babito-agent
npm install
cp .env.example .env          # fill in values
npm test                      # 92 tests, no network or credentials needed
npm run chat                  # talk to the real agent (real Claude + Shopify) in the terminal, no WhatsApp needed
npm run eval -- --dry-run     # list the scripted quality scenarios + cost estimate; drop --dry-run to run them (costs API credit)
```

`npm run chat` only needs `ANTHROPIC_API_KEY`, `SHOPIFY_STORE_DOMAIN` and a Shopify token. It uses an in-memory database. Set `CHAT_PHONE=<your number>` to test order lookups for your own orders.

## 3. Database

```bash
DATABASE_URL=postgresql://... npm run db:migrate
```

Applies `supabase/migrations/*.sql` once each (tracked in `app_migrations`). Alternatively use the Supabase CLI (`supabase db push`) — pick one method per database.

After migrating, in the Supabase Table Editor:
1. `kb_articles`: store facts the bot may quote (shipping, delivery times, contact, promotions, payment methods, FAQ) and product-specific notes (`product_ids = {gid://shopify/Product/…}`). Only `is_active = true` rows are used.
2. `settings`: `business_hours`, `persona_notes` (tone), `store_rules` (the owner's business rules, injected into the prompt), fallback texts (`handoff_expectation`, `unsupported_media_reply`, `media_received_reply`). Set `bot_enabled = false` to pause the AI instantly.

**This repository is public.** Business-sensitive rules and store content belong in the database (`settings.store_rules`, `kb_articles`), never in code or committed files. Keep local copies in `babito-agent/private/` (git-ignored); `EVAL_KB_FILE=private/owner-content.json npm run eval` tests them.

## 4. Deploy (Railway example; Fly.io / Render are equivalent)

1. New project → Deploy from GitHub repo → set **root directory** to `babito-agent`. `babito-agent/railway.json` sets the Dockerfile build, `/health` check, restart policy, one replica and a 100s draining time (if Railway doesn't pick it up, set the service's config file path to `/babito-agent/railway.json`).
2. Variables → Raw Editor: paste all variables (template with generated secrets: `private/railway.env`; reference: `.env.example`). Production refuses to start without `WHATSAPP_APP_SECRET`, `ADMIN_PASSWORD` (≥12 chars) and `ANTHROPIC_API_KEY`.
3. Generate a public domain, e.g. `https://babito-agent.up.railway.app`. Check `GET /health` → `{"ok":true}`.
4. Run migrations once **from your machine** with the production `DATABASE_URL` (`DATABASE_URL=... npm run db:migrate`), or apply the files in `supabase/migrations/` through Supabase. The production image doesn't include `tsx` or `scripts/`, so `npm run db:migrate` can't run inside it.
5. Run **one instance** to start. Multiple instances are safe (DB lease + idempotency), but one is enough for this volume.
6. Give the service a **stop timeout of at least 90s** (Railway: `drainingSeconds` in `railway.json`; Fly: `kill_timeout`; Docker: `stop_grace_period`). On SIGTERM the server waits up to 90s for in-flight replies before exiting.

## 5. Connect WhatsApp

Meta app → WhatsApp → Configuration → Webhook:
- Callback URL: `https://<your-domain>/webhook`
- Verify token: your `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **messages** field (and `smb_message_echoes` if you use coexistence).

Send a message to the business number. You should see `message_received` → `agent_run` → `message_sent` in the logs, and the chat at `https://<your-domain>/admin`.

## 6. Scheduled jobs

None to set up. The server runs the sweeper every 15s and the retention purge every `MAINTENANCE_INTERVAL_HOURS` (default 24). If you prefer an external scheduler, set it to `0` and call:

```bash
curl -X POST https://<your-domain>/cron/maintenance -H "Authorization: Bearer $CRON_SECRET"
```

## 7. Monitoring

- **Logs** (JSON): filter by `event` — `message_received`, `agent_run` (status, tools, tokens, latency, flags), `tool_call`, `handoff`, `message_sent`, `send_failed`, `delivery_failed`, `guardrail`, `webhook_bad_signature`, `rate_limited`, `batch_failed`, `lease_lost`.
- **Dashboard** `/admin`: 24h counters (runs, failures, tool failures, send failures, open handoffs, tokens, latency), conversations, per-run tool calls and errors. Customer photos, videos and documents open from the conversation view (fetched from WhatsApp on demand; WhatsApp keeps media for 30 days).
- **Alert on**: `agent_runs.status = 'failed'` spikes, `send_failed`, `delivery_failed` with code 131047 (outside 24h window), `/health` non-200.
- **Cost**: tokens per run are stored in `agent_runs` (`input_tokens`, `cache_read_tokens`, `output_tokens`). A healthy cache ratio means `cache_read_tokens` ≈ most of the input.

## 8. Go-live checklist

- [ ] Fill and activate KB articles and `settings.store_rules` (especially payment methods)
- [ ] Run `EVAL_KB_FILE=private/owner-content.json npm run eval` (≈ $1.50 on Opus 5 at low effort) and read the report; add real questions from your inbox to `scripts/eval-scenarios.ts` (or `private/eval-scenarios.json` for sensitive ones)
- [ ] Test with `npm run chat` on 20–30 real customer questions (Arabic + Hebrew)
- [ ] Test order lookup with a real order placed with your own phone
- [ ] Set `STAFF_NOTIFY_WEBHOOK_URL` and confirm a handoff notification arrives
- [ ] Staff know how to reply from `/admin` (or the WhatsApp Business app with coexistence) and how to *Release to AI*
- [ ] Daily `/cron/maintenance` scheduled
- [ ] Rotate any token that was ever pasted into chat/email
