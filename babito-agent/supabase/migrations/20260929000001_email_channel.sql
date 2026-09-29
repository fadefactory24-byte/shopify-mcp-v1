-- Email channel (support@ mailbox via Microsoft Graph).
--
-- Customers stay keyed by customers.wa_id, now read as "channel handle": the WhatsApp id (digits) for
-- WhatsApp customers, or 'email:<lowercase address>' for email customers. Conversations record their
-- channel. Integration state (the rotating Microsoft refresh token, mailbox watermarks) lives in
-- integration_state, never in logs.

comment on column customers.wa_id is 'Channel handle: WhatsApp id (digits) or ''email:<address>'' for email customers';

create table if not exists integration_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table integration_state enable row level security;

alter table conversations drop constraint if exists conversations_channel_check;
alter table conversations add constraint conversations_channel_check check (channel in ('whatsapp', 'email'));
