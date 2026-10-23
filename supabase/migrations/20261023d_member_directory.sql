-- Member directory snapshot for admin troubleshooting (filled by outlook-member-sync each run).
create table public.outlook_member_orgs (
  org_id bigint primary key,
  name text not null default '',
  last_membership_year integer not null default 0,
  status text not null check (status in ('current','lapsed')),
  contacts integer not null default 0,
  contacts_with_email integer not null default 0,
  synced_at timestamptz not null default now()
);
comment on table public.outlook_member_orgs is 'Snapshot from Insightly (nightly): current member organisations plus those lapsed within the last year, for admin troubleshooting of Outlook Data Explorer access.';
create table public.outlook_member_contacts (
  id bigint generated always as identity primary key,
  org_id bigint not null,
  email text not null default '',
  full_name text not null default '',
  synced_at timestamptz not null default now()
);
comment on table public.outlook_member_contacts is 'Snapshot from Insightly (nightly): contacts linked to organisations in outlook_member_orgs. Empty email = contact cannot register.';
create index outlook_member_contacts_org_idx on public.outlook_member_contacts (org_id);
create index outlook_member_contacts_email_idx on public.outlook_member_contacts (email);
alter table public.outlook_member_orgs enable row level security;
alter table public.outlook_member_contacts enable row level security;
revoke all on public.outlook_member_orgs, public.outlook_member_contacts from anon;
grant select on public.outlook_member_orgs, public.outlook_member_contacts to authenticated;
create policy "Admins read member orgs" on public.outlook_member_orgs for select to authenticated using ((select private.is_admin()));
create policy "Admins read member contacts" on public.outlook_member_contacts for select to authenticated using ((select private.is_admin()));
