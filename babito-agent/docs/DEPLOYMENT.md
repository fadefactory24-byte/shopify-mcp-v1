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
| Recommended: **17TRACK API key** | api.17track.net → register → API key → `SEVENTEENTRACK_API_KEY`. Shopify fulfillments have tracking numbers but no carrier updates; with this key order answers use the live stage (in transit, final leg, out for delivery, delivered...). Only parcels customers ask about are registered, one quota unit each. Accounts created since 7 Jan 2026 get 200 free tracking numbers once (no monthly allowance); after that a paid plan. No webhook is needed (the bot asks on demand) and leave the IP whitelist empty (Railway's outgoing IPs change). When the quota runs out, answers fall back to the Shopify stage. |
| Recommended: support mailbox (Microsoft 365) | Email channel + staff alert emails through Microsoft Graph; see *Email channel* below. |
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

1. New project → Deploy from GitHub repo → set **root directory** to `/babito-agent` (it has its own `Dockerfile`) and the **branch** you deploy from, in the service's Source settings for the environment (if the environment has no branch, Railway builds the repo's default branch on every deploy and ignores pushes to yours). Service settings: health check `/health` (60s), restart on failure (10 retries), 1 replica in **EU West**, variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=100`.
2. Variables → Raw Editor: add the variables (reference: `.env.example`). Tip: set `DATABASE_URL=postgresql://postgres.<ref>:${{DB_PASSWORD}}@<pooler-host>:5432/postgres` and paste only the password into `DB_PASSWORD`. Production refuses to start without `WHATSAPP_APP_SECRET`, `ADMIN_PASSWORD` (≥12 chars) and `ANTHROPIC_API_KEY`.
3. Generate a public domain, e.g. `https://babito-agent.up.railway.app`. Check `GET /health` → `{"ok":true}`.
4. Run migrations once **from your machine** with the production `DATABASE_URL` (`DATABASE_URL=... npm run db:migrate`), or apply the files in `supabase/migrations/` through Supabase. The production image doesn't include `tsx` or `scripts/`, so `npm run db:migrate` can't run inside it. After that first time, the deployed server can apply its own new migrations after every future deploy — see `/cron/migrate` below.
5. Run **one instance** to start. Multiple instances are safe (DB lease + idempotency), but one is enough for this volume.
6. Give the service a **stop timeout of at least 90s** (Railway: `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=100`; Fly: `kill_timeout`; Docker: `stop_grace_period`). On SIGTERM the server waits up to 90s for in-flight replies before exiting.

## 5. Connect WhatsApp

Meta app → WhatsApp → Configuration → Webhook:
- Callback URL: `https://<your-domain>/webhook`
- Verify token: your `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **messages** field (and `smb_message_echoes` if you use coexistence).

Three more switches, or messages never arrive (no error anywhere, the webhook just stays silent):
- **Publish the app** (App settings → Basic: privacy policy, terms and data-deletion URLs + category; then Publish). An unpublished app only receives the dashboard's test webhooks.
- **Register the number** with the Cloud API: `POST /<PHONE_NUMBER_ID>/register` with `{"messaging_product":"whatsapp","pin":"<6 digits>"}`. Until then the number's `status` is `PENDING`, sends fail with `133010 Account not registered`, and WhatsApp users see "not on WhatsApp". Keep the PIN; it's the number's two-step PIN.
- **Subscribe the WABA to the app**: `POST /<WABA_ID>/subscribed_apps`. Needs a token with `whatsapp_business_management` and full control of the WABA; the bot's messaging-only system-user token can't do it (a temporary token from the dashboard's "Generate token" can). Check with `GET` on the same path: your app must be listed.

### Keeping the WhatsApp Business app on the same number (coexistence)

Staff keep answering from the phone app; the bot answers too and goes quiet in any chat where staff reply from the app (their messages arrive as `smb_message_echoes` and switch the chat to human mode).

If the number also carries non-customer chats (suppliers, personal contacts), add those numbers at `/admin/blocked` **before** connecting — the AI never replies to a number on that list (their messages still arrive and show up in `/admin` for staff to answer normally). A number can also be added from its conversation page after the fact ("Ignore this contact").

1. Meta app → Facebook Login for Business → Configurations → **Create from template** → "WhatsApp Embedded Signup configuration with 60-day token". Copy its configuration id.
2. Facebook Login for Business → Settings: *Login with the JavaScript SDK* = Yes, *Allowed domains for the JavaScript SDK* = `https://<your-domain>/`. App settings → Basic → *App domains* = `<your-domain>`.
3. Webhooks (Whatsapp Business Account): also subscribe `smb_message_echoes` and `account_update`.
4. Set `META_APP_ID` and `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`, deploy, open `https://<your-domain>/admin/whatsapp-connect` on a computer, and follow the page (Facebook sign-in → business portfolio → *connect existing WhatsApp Business app* → scan the QR code with the app, version 2.24.17+). The page subscribes the app to the new WhatsApp account and shows its phone number id.
5. Business settings → System users → the bot's user → **Assign assets** → the new WhatsApp account (messages). Then set `WHATSAPP_PHONE_NUMBER_ID` to the new id and deploy.
6. In the WhatsApp Business app, turn off the greeting and away messages (otherwise customers get two answers).

Meta documents this flow for Tech Providers; here it is used by the business's own app for its own number, so if Meta refuses it at sign-in, the fallback is Tech Provider enrollment (App dashboard → Become Tech Provider, needs business verification). Coexistence limits: 20 messages/second; some app features stop (disappearing/view-once messages, new broadcast lists, live location). To undo: in the app, Settings → Account → Business Platform → Disconnect.

Send a message to the business number. You should see `message_received` → `agent_run` → `message_sent` in the logs, and the chat at `https://<your-domain>/admin`.

## 5b. Email channel (support mailbox, Microsoft 365)

The agent reads new customer emails in the support mailbox and answers in the same thread, with the same rules as WhatsApp (the sender address is the verified identity for orders; handoffs flag the email for staff with the category "BABITO: needs staff"; a reply staff send themselves from Outlook puts the conversation in human mode). Automated mail (no-reply, platforms, mailing lists, auto-replies) and the mailbox's own messages are never answered, and only mail received after the channel starts is processed. Staff alert emails (customer waiting, system problems) are sent from the same mailbox to `STAFF_NOTIFY_EMAIL`. Handoffs themselves are WhatsApp-only — see "5d. Staff WhatsApp alerts" below.

1. entra.microsoft.com → App registrations → New registration: name "BABITO Agent Mail", single tenant. Authentication → *Allow public client flows* = Yes. API permissions → Microsoft Graph → Delegated: `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access` (no admin-wide application permission: access is limited to the mailbox that signs in).
2. `MS_CLIENT_ID=<Application (client) ID> MS_TENANT_ID=<Directory (tenant) ID> npx tsx scripts/connect-outlook.ts private/secrets.env`, sign in **as the support mailbox** at microsoft.com/devicelogin and accept.
3. Set `MS_CLIENT_ID`, `MS_TENANT_ID`, `MS_REFRESH_TOKEN` (secret), `EMAIL_MAILBOX`, `STAFF_NOTIFY_EMAIL`, `EMAIL_CHANNEL_ENABLED=true`; apply the migrations; deploy. The log shows `emailChannel: true`.

## 5c. Social channel (Facebook Messenger + Instagram DMs)

Same webhook URL and same Meta app as WhatsApp; payloads are told apart by their `object` field (`page` vs `instagram` vs `whatsapp_business_account`), so no new webhook URL is needed in Meta. The agent answers Page Messenger and Instagram DMs with the same rules as WhatsApp, except it has no phone number or email for the customer (only their Messenger/Instagram profile), so order verification asks for the order number/email directly. A staff reply sent directly from the Page/Instagram inbox arrives as an echo and puts the conversation in human mode, same as the WhatsApp Business app. **Messages older than `SOCIAL_MAX_AGE_DAYS` (default 7) are never answered and never even stored** — this is deliberate, so connecting the channel does not suddenly reply to a backlog of old unanswered DMs.

To ignore a supplier/personal contact on Messenger or Instagram, use "Ignore this contact" on their conversation page at `/admin` (the `/admin/blocked` add-by-number/email form is for WhatsApp/email only).

1. Meta app (the same app as WhatsApp) → add the **Messenger** product (and **Instagram** if not already present) → link the Facebook Page and the Instagram professional account that's connected to it.
2. Generate a Page Access Token for that Page with `pages_messaging` (and `instagram_manage_messages`, `instagram_basic` for Instagram) — Graph API Explorer or the Messenger product's own token generator. It does not expire like a user token as long as the app has the permissions approved (App Review, or Standard Access while in development mode with the Page added as a tester).
3. Webhooks product → subscribe the **page** object to fields `messages`, `message_echoes`; subscribe the **instagram** object to field `messages`.
4. Link the Page to the app: `POST https://graph.facebook.com/v23.0/<page-id>/subscribed_apps` with the Page Access Token (or the Messenger product's "connect a Page" button does this for you).
5. Note the Page's id and the Instagram professional account's id (Page → Settings, or `GET /<page-id>?fields=instagram_business_account`).
6. Set `SOCIAL_CHANNEL_ENABLED=true`, `META_PAGE_ID`, `META_INSTAGRAM_ID`, `META_PAGE_ACCESS_TOKEN` (secret); apply the migrations; deploy. The log shows `socialChannel: true`.

Send a DM to the Page or the Instagram account. You should see `message_received` → `agent_run` → `message_sent` in the logs, and the chat at `https://<your-domain>/admin` (labeled "Messenger" or "Instagram").

## 5d. Staff WhatsApp alerts (handoffs) with a message template

Handoffs (customer needs a human, product problem, etc.) alert staff over WhatsApp only — there is no handoff email. (`STAFF_NOTIFY_EMAIL` still covers the separate customer-waiting and system-problem alerts.) To reach a staff member's phone reliably — not just when that number has texted the business number in the last 24h — use an approved WhatsApp message template:

1. Meta Business Suite → WhatsApp Manager → your WhatsApp Business Account → Message templates → Create template.
2. Category **Utility**, type **Standard**. Body (3 variables, in this order — customer, reason, summary), e.g.:
   ```
   New BABITO handoff needed - please take over this conversation.

   Customer: {{1}}
   Reason: {{2}}
   Summary: {{3}}

   Reply when you can.
   ```
   (A variable can't be the very first or very last thing in the body — keep static text before `{{1}}` and after `{{3}}`.) Fill in an example value for each variable, then submit for review (usually approved within minutes to a few hours).
3. Once approved, set `STAFF_HANDOFF_TEMPLATE` to the template's name (e.g. `babito_staff_handoff`) and `STAFF_HANDOFF_TEMPLATE_LANG` to its language code (`en` for plain "English"); add the staff phone number(s) to `STAFF_WHATSAPP_NUMBERS` (comma-separated, international format e.g. `972501234567`, no `+`). Deploy.

While the template is pending approval (or `STAFF_HANDOFF_TEMPLATE`/`STAFF_WHATSAPP_NUMBERS` aren't set), handoffs have no email fallback — they only reach staff via the admin dashboard (and the webhook, if `STAFF_NOTIFY_WEBHOOK_URL` is configured) until the template is live.

## 6. Scheduled jobs

None to set up. The server runs the sweeper every 15s and the retention purge every `MAINTENANCE_INTERVAL_HOURS` (default 24). If you prefer an external scheduler, set it to `0` and call:

```bash
curl -X POST https://<your-domain>/cron/maintenance -H "Authorization: Bearer $CRON_SECRET"
```

After the first migration (step 4 above), a future deploy that adds a new file to `supabase/migrations/` doesn't need anyone to touch `DATABASE_URL` again: call `/cron/migrate` (same `CRON_SECRET` auth) and the server applies whatever it hasn't applied yet, using its own DB connection.

```bash
curl -X POST https://<your-domain>/cron/migrate -H "Authorization: Bearer $CRON_SECRET"   # -> {"applied": ["<file>.sql", ...]}
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
