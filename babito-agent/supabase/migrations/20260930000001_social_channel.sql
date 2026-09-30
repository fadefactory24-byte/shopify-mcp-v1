-- Messenger and Instagram DM channel. Customers are keyed by 'psid:<id>' or 'igsid:<id>'
-- (see email's 'email:<address>' for the same pattern); conversations record the channel.

alter table conversations drop constraint if exists conversations_channel_check;
alter table conversations add constraint conversations_channel_check check (channel in ('whatsapp', 'email', 'messenger', 'instagram'));
