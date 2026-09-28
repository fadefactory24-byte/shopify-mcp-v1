-- Pre-beta hardening.
--
--  * processing_owner: which worker holds the conversation lease. Workers renew
--    and release only their own lease, so a slow worker can never clear or
--    extend a lease another worker has taken over.

alter table conversations add column processing_owner uuid;

-- purge_old_data(): unchanged, except that closing a stale conversation now
-- also resolves its active handoff (it used to stay open forever).
-- CREATE OR REPLACE keeps the function's owner and the revokes from init.
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
  with closed as (
    update conversations set status = 'closed', closed_at = now()
     where status = 'open' and last_message_at < now() - interval '30 days'
    returning id
  )
  update handoffs set status = 'resolved', resolved_at = now(), claimed_by = coalesce(claimed_by, 'system:retention')
   where conversation_id in (select id from closed) and status in ('open','claimed');
  return jsonb_build_object('tool_calls', n_tool, 'agent_runs', n_runs, 'messages', n_msgs, 'memories', n_mem);
end $$;
