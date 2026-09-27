-- BABITO WhatsApp agent — initial schema.
--
-- Principles:
--  * Shopify is the source of truth for products/prices/stock/orders. Nothing
--    here caches commercial data except a link (shopify_customer_id).
--  * The backend connects with a server-side Postgres role (DATABASE_URL).
--    RLS is enabled on every table with NO policies, so the anon/authenticated
--    Supabase roles (browser keys) can read/write nothing.
--  * Conversation data is purgeable (see purge_old_data()).

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- customers: one row per WhatsApp user
-- ---------------------------------------------------------------------------
create table customers (
  id                  uuid primary key default gen_random_uuid(),
  wa_id               text not null unique,               -- WhatsApp id, international digits
  display_name        text,                               -- WhatsApp profile name (unverified)
  preferred_language  text check (preferred_language in ('ar','he','en')),
  shopify_customer_id text,                               -- cached link only, re-verified on use
  is_blocked          boolean not null default false,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz                          -- soft delete (GDPR-style erase keeps row for FK integrity)
);
create trigger customers_updated_at before update on customers for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- conversations: one OPEN conversation per customer at a time
-- ---------------------------------------------------------------------------
create table conversations (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references customers(id) on delete cascade,
  channel           text not null default 'whatsapp',
  status            text not null default 'open' check (status in ('open','closed')),
  mode              text not null default 'ai' check (mode in ('ai','human','paused')),
  language          text check (language in ('ar','he','en')),
  summary           text,                                  -- rolling summary of older turns
  context           jsonb not null default '{}'::jsonb,    -- short-term structured state (recent products, verification)
  processing_until  timestamptz,                           -- processing lease (per-conversation mutual exclusion)
  human_since       timestamptz,
  human_last_activity_at timestamptz,
  last_inbound_at   timestamptz,
  last_outbound_at  timestamptz,
  last_message_at   timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  closed_at         timestamptz
);
create unique index conversations_one_open_per_customer on conversations(customer_id) where status = 'open';
create index conversations_last_message_idx on conversations(last_message_at desc);
create index conversations_mode_idx on conversations(mode) where status = 'open';
create trigger conversations_updated_at before update on conversations for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- agent_runs: one AI invocation (may batch several inbound messages)
-- ---------------------------------------------------------------------------
create table agent_runs (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references conversations(id) on delete cascade,
  model              text,
  status             text not null default 'running' check (status in ('running','succeeded','failed','handoff','skipped')),
  iterations         int not null default 0,
  input_tokens       int not null default 0,
  output_tokens      int not null default 0,
  cache_read_tokens  int not null default 0,
  latency_ms         int,
  reply_text         text,
  guardrail_flags    text[] not null default '{}',
  error              text,
  created_at         timestamptz not null default now(),
  finished_at        timestamptz
);
create index agent_runs_conversation_idx on agent_runs(conversation_id, created_at desc);
create index agent_runs_failed_idx on agent_runs(created_at desc) where status = 'failed';

-- ---------------------------------------------------------------------------
-- messages: inbound + outbound. wa_message_id is the idempotency key.
-- ---------------------------------------------------------------------------
create table messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  customer_id      uuid not null references customers(id) on delete cascade,
  direction        text not null check (direction in ('inbound','outbound')),
  author           text not null check (author in ('customer','ai','human_agent','system')),
  wa_message_id    text,
  type             text not null default 'text',
  body             text,
  media            jsonb,                                  -- ids/mime only, never the binary
  status           text not null,
  attempts         int not null default 0,
  error            text,
  agent_run_id     uuid references agent_runs(id) on delete set null,
  wa_timestamp     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint messages_status_valid check (
    (direction = 'inbound'  and status in ('received','processing','processed','skipped','failed')) or
    (direction = 'outbound' and status in ('pending','sent','delivered','read','failed'))
  )
);
create unique index messages_wa_message_id_key on messages(wa_message_id) where wa_message_id is not null;
create index messages_conversation_idx on messages(conversation_id, created_at);
create index messages_customer_recent_idx on messages(customer_id, created_at desc);
create index messages_pending_inbound_idx on messages(created_at) where direction = 'inbound' and status in ('received','processing');
create index messages_failed_outbound_idx on messages(created_at) where direction = 'outbound' and status = 'failed';
create trigger messages_updated_at before update on messages for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- tool_calls: every tool the agent invoked, for debugging & analytics
-- ---------------------------------------------------------------------------
create table tool_calls (
  id               uuid primary key default gen_random_uuid(),
  agent_run_id     uuid not null references agent_runs(id) on delete cascade,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  tool_name        text not null,
  input            jsonb,
  output           jsonb,                                  -- truncated/sanitized result
  success          boolean not null,
  error            text,
  latency_ms       int,
  created_at       timestamptz not null default now()
);
create index tool_calls_run_idx on tool_calls(agent_run_id);
create index tool_calls_created_idx on tool_calls(created_at desc);

-- ---------------------------------------------------------------------------
-- handoffs: live transfer to a human, and order-change requests for staff
-- ---------------------------------------------------------------------------
create table handoffs (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  customer_id      uuid not null references customers(id) on delete cascade,
  kind             text not null default 'live' check (kind in ('live','order_change')),
  reason           text not null check (reason in (
                     'customer_request','complaint','refund','payment_issue','shipping_issue',
                     'order_change','uncertain','tool_failure','sensitive','processing_error','other')),
  priority         text not null default 'normal' check (priority in ('normal','high')),
  summary          text,
  order_name       text,
  change_type      text,
  details          jsonb not null default '{}'::jsonb,
  status           text not null default 'open' check (status in ('open','claimed','resolved','cancelled')),
  created_by       text not null default 'ai' check (created_by in ('ai','system','staff')),
  claimed_by       text,
  notified_at      timestamptz,
  created_at       timestamptz not null default now(),
  claimed_at       timestamptz,
  resolved_at      timestamptz
);
create unique index handoffs_one_active_per_conversation on handoffs(conversation_id) where status in ('open','claimed');
create index handoffs_status_idx on handoffs(status, created_at desc);

-- ---------------------------------------------------------------------------
-- customer_memories: small, curated, deletable facts (NOT chat logs)
-- ---------------------------------------------------------------------------
create table customer_memories (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  key          text not null check (key in ('name','preferred_language','child_age','interests','notes')),
  value        text not null check (char_length(value) <= 300),
  source       text not null default 'ai' check (source in ('ai','staff','system')),
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (customer_id, key)
);
create trigger customer_memories_updated_at before update on customer_memories for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- kb_articles: business knowledge editable without redeploy
-- (Supabase Table Editor or the admin API). Loaded via a short cache.
-- ---------------------------------------------------------------------------
create table kb_articles (
  id           uuid primary key default gen_random_uuid(),
  key          text not null unique check (key ~ '^[a-z0-9_.-]{2,64}$'),
  category     text not null check (category in ('shipping','returns','payment','faq','store_rules','product_info','promotions','contact','other')),
  title        text not null,
  content      text not null check (char_length(content) <= 4000),
  language     text not null default 'he' check (language in ('ar','he','en')),
  product_ids  text[] not null default '{}',               -- Shopify product GIDs for product-specific notes
  is_active    boolean not null default true,
  priority     int not null default 0,
  updated_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index kb_articles_active_idx on kb_articles(category) where is_active and deleted_at is null;
create index kb_articles_products_idx on kb_articles using gin(product_ids);
create trigger kb_articles_updated_at before update on kb_articles for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- settings: runtime switches (bot on/off, business hours, persona notes…)
-- ---------------------------------------------------------------------------
create table settings (
  key          text primary key,
  value        jsonb not null,
  description  text,
  updated_at   timestamptz not null default now()
);
create trigger settings_updated_at before update on settings for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- audit_log: staff/admin actions and security-relevant events
-- ---------------------------------------------------------------------------
create table audit_log (
  id          bigint generated always as identity primary key,
  actor       text not null,
  action      text not null,
  entity      text,
  entity_id   text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_created_idx on audit_log(created_at desc);

-- ---------------------------------------------------------------------------
-- retention: keep the DB small. Called by POST /cron/maintenance.
-- ---------------------------------------------------------------------------
create or replace function purge_old_data(message_days int default 180, run_days int default 60)
returns jsonb language plpgsql as $$
declare
  n_tool int; n_runs int; n_msgs int; n_mem int;
begin
  delete from tool_calls where created_at < now() - make_interval(days => run_days);
  get diagnostics n_tool = row_count;
  delete from agent_runs where created_at < now() - make_interval(days => run_days);
  get diagnostics n_runs = row_count;
  delete from messages where created_at < now() - make_interval(days => message_days);
  get diagnostics n_msgs = row_count;
  delete from customer_memories where expires_at is not null and expires_at < now();
  get diagnostics n_mem = row_count;
  update conversations set status = 'closed', closed_at = now()
   where status = 'open' and last_message_at < now() - interval '30 days';
  return jsonb_build_object('tool_calls', n_tool, 'agent_runs', n_runs, 'messages', n_msgs, 'memories', n_mem);
end $$;

-- ---------------------------------------------------------------------------
-- security: RLS on, no policies => browser keys see nothing.
-- ---------------------------------------------------------------------------
alter table customers          enable row level security;
alter table conversations      enable row level security;
alter table agent_runs         enable row level security;
alter table messages           enable row level security;
alter table tool_calls         enable row level security;
alter table handoffs           enable row level security;
alter table customer_memories  enable row level security;
alter table kb_articles        enable row level security;
alter table settings           enable row level security;
alter table audit_log          enable row level security;

revoke execute on function purge_old_data(int,int) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke execute on function purge_old_data(int,int) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';
    execute 'revoke execute on function purge_old_data(int,int) from authenticated';
  end if;
end $$;
