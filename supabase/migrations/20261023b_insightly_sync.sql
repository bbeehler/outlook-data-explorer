-- Insightly membership sync (applied 2026-10-23)
alter table public.outlook_access
  add column source text not null default 'manual' check (source in ('manual','insightly')),
  add column insightly_org_id bigint,
  add column last_synced timestamptz;
create table public.outlook_sync_log (
  id bigint generated always as identity primary key, started_at timestamptz not null default now(), finished_at timestamptz,
  ok boolean not null default false, member_orgs integer, member_emails integer, added integer, updated integer, removed integer,
  note text not null default ''
);
alter table public.outlook_sync_log enable row level security;
revoke all on public.outlook_sync_log from anon;
grant select on public.outlook_sync_log to authenticated;
create policy "Admins read sync log" on public.outlook_sync_log for select to authenticated using ((select private.is_admin()));
create extension if not exists pg_net;
create extension if not exists pg_cron;
-- Nightly at 07:17 UTC (3:17 a.m. Toronto in summer, 2:17 a.m. in winter)
select cron.schedule('outlook-member-sync-nightly', '17 7 * * *', $$select net.http_post(url := 'https://bbrdihxafpgexnfvkshl.supabase.co/functions/v1/outlook-member-sync', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb);$$);
