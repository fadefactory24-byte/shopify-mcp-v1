-- Pin search_path on the app's functions (Supabase security advisor:
-- function_search_path_mutable). Runs after any `create or replace` of these
-- functions, which would otherwise reset the setting.
alter function set_updated_at() set search_path = '';
alter function purge_old_data(int, int) set search_path = public;
