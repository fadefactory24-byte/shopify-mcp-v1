-- Staff relay: the owner replies (on WhatsApp) to a handoff alert in plain words, the bot writes a
-- polished customer message from it, shows it back as a draft, and sends it only after approval.

-- Each alert we send to a staff number, so a reply to it can be tied back to its conversation.
-- conversation_id is null for the dashboard's test alert.
create table staff_alerts (
  wa_message_id   text primary key,
  conversation_id uuid references conversations(id) on delete cascade,
  staff_number    text not null,
  created_at      timestamptz not null default now()
);
create index staff_alerts_conversation_idx on staff_alerts(conversation_id);

-- A drafted customer message waiting for the owner's approval.
create table relay_drafts (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references conversations(id) on delete cascade,
  staff_number        text not null,
  instruction         text not null,
  draft               text not null,
  language            text,
  status              text not null default 'pending' check (status in ('pending', 'sent', 'cancelled', 'superseded')),
  draft_wa_message_id text,
  created_at          timestamptz not null default now(),
  decided_at          timestamptz
);
create index relay_drafts_staff_idx on relay_drafts(staff_number, status, created_at desc);
create index relay_drafts_wamid_idx on relay_drafts(draft_wa_message_id);
create index relay_drafts_conversation_idx on relay_drafts(conversation_id);

-- WhatsApp redelivers webhooks: a staff message must trigger the relay at most once.
create table staff_messages_seen (
  wa_message_id text primary key,
  created_at    timestamptz not null default now()
);

alter table staff_alerts        enable row level security;
alter table relay_drafts        enable row level security;
alter table staff_messages_seen enable row level security;
