-- Identifies the current server-side reading job, so a restarted job stops any older one.
alter table public.hub_reports add column run_token text not null default '';
