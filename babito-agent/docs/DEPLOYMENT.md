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
npm run eval -- --dry-run     # list the scripted quality scenarios + cost estimate; drop --dry-run to run them
```

`npm run chat` only needs `ANTHROPIC_API_KEY`, `SHOPIFY_STORE_DOMAIN` and a Shopify token. It uses an in-memory database. Set `CHAT_PHONE=<your number>` to test order lookups for your own orders.

## 3. Database

```bash
DATABASE_URL=postgresql://... npm run db:migrate
```

Applies `supabase/migrations/*.sql` once each (tracked in `app_migrations`). Alternatively use the Supabase CLI (`supabase db push`) — pick one method per database.

After migrating, in the Supabase Table Editor:
1. `kb_articles`: fill the 4 template rows (payment methods, shipping cost, contact hours, promotions) and set `is_active = true`. Add more rows any time (FAQ, product-specific notes with `product_ids = {gid://shopify/Product/…}`).
2. `settings`: adjust `business_hours`, `persona_notes`, fallback texts. Set `bot_enabled = false` to pause the AI instantly.

## 4. Deploy (Railway example; Fly.io / Render are equivalent)

1. New project → Deploy from GitHub repo → set **root directory** to `babito-agent` (it has its own `Dockerfile`).
2. Add all variables from `.env.example` with `NODE_ENV=production`. Production refuses to start without `WHATSAPP_APP_SECRET`, `ADMIN_PASSWORD` (≥12 chars) and `ANTHROPIC_API_KEY`.
3. Generate a public domain, e.g. `https://babito-agent.up.railway.app`. Check `GET /health` → `{"ok":true}`.
4. Run migrations once **from your machine** with the production `DATABASE_URL` (`DATABASE_URL=... npm run db:migrate`), or apply the files in `supabase/migrations/` through Supabase. The production image doesn't include `tsx` or `scripts/`, so `npm run db:migrate` can't run inside it.
5. Run **one instance** to start. Multiple instances are safe (DB lease + idempotency), but one is enough for this volume.
6. Give the service a **stop timeout of at least 90s** (Railway: `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=100`; Fly: `kill_timeout`; Docker: `stop_grace_period`). On SIGTERM the server waits up to 90s for in-flight replies before exiting.

## 5. Connect WhatsApp

Meta app → WhatsApp → Configuration → Webhook:
- Callback URL: `https://<your-domain>/webhook`
- Verify token: your `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **messages** field (and `smb_message_echoes` if you use coexistence).

Send a message to the business number. You should see `message_received` → `agent_run` → `message_sent` in the logs, and the chat at `https://<your-domain>/admin`.

## 6. Scheduled jobs

The server runs the sweeper itself every 15s. Add a daily retention job (Railway cron, GitHub Actions, or n8n):

```bash
curl -X POST https://<your-domain>/cron/maintenance -H "Authorization: Bearer $CRON_SECRET"
```

## 7. Monitoring

- **Logs** (JSON): filter by `event` — `message_received`, `agent_run` (status, tools, tokens, latency, flags), `tool_call`, `handoff`, `message_sent`, `send_failed`, `delivery_failed`, `guardrail`, `webhook_bad_signature`, `rate_limited`, `batch_failed`, `lease_lost`.
- **Dashboard** `/admin`: 24h counters (runs, failures, tool failures, send failures, open handoffs, tokens, latency), conversations, per-run tool calls and errors.
- **Alert on**: `agent_runs.status = 'failed'` spikes, `send_failed`, `delivery_failed` with code 131047 (outside 24h window), `/health` non-200.
- **Cost**: tokens per run are stored in `agent_runs` (`input_tokens`, `cache_read_tokens`, `output_tokens`). A healthy cache ratio means `cache_read_tokens` ≈ most of the input.

## 8. Go-live checklist

- [ ] Fill and activate KB templates (especially shipping cost & payment methods)
- [ ] Run `npm run eval` (41 scripted scenarios, ≈ $4 on Opus 5) and read the report; add real questions from your inbox to `scripts/eval-scenarios.ts`
- [ ] Test with `npm run chat` on 20–30 real customer questions (Arabic + Hebrew)
- [ ] Test order lookup with a real order placed with your own phone
- [ ] Set `STAFF_NOTIFY_WEBHOOK_URL` and confirm a handoff notification arrives
- [ ] Staff know how to reply from `/admin` (or the WhatsApp Business app with coexistence) and how to *Release to AI*
- [ ] Daily `/cron/maintenance` scheduled
- [ ] Rotate any token that was ever pasted into chat/email
