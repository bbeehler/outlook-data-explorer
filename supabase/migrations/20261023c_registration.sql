-- Registration flow (applied 2026-10-23): every "Get access" request is logged here by the outlook-register function.
create table public.outlook_registrations (
  id bigint generated always as identity primary key,
  requested_at timestamptz not null default now(),
  email text not null,
  ip text not null default '',
  result text not null check (result in ('approved_list','approved_admin','approved_member','denied_not_found','denied_no_org','denied_lapsed','rate_limited','error')),
  organization text not null default '',
  note text not null default ''
);
create index outlook_registrations_time_idx on public.outlook_registrations (requested_at desc);
create index outlook_registrations_email_idx on public.outlook_registrations (email, requested_at desc);
create index outlook_registrations_ip_idx on public.outlook_registrations (ip, requested_at desc);
alter table public.outlook_registrations enable row level security;
revoke all on public.outlook_registrations from anon;
grant select on public.outlook_registrations to authenticated;
create policy "Admins read access requests" on public.outlook_registrations for select to authenticated using ((select private.is_admin()));
