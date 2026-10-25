-- Research Hub: chart problems reported by members' browsers (for troubleshooting). Members can add rows; only admins read.
create table public.hub_client_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid default auth.uid(),
  version text not null default '',
  page text not null default '',
  figure text not null default '',
  event text not null default '',
  details jsonb not null default '{}'::jsonb
);
alter table public.hub_client_log enable row level security;
revoke all on public.hub_client_log from anon;
grant insert, select on public.hub_client_log to authenticated;
create policy "Signed-in users add log rows" on public.hub_client_log for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Admins read log" on public.hub_client_log for select to authenticated using ((select private.is_admin()));
