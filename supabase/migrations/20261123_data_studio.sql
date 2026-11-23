-- Data Studio: datasets admins upload (CSV, Excel, survey crosstab exports; API sources later) that members, affiliates and
-- report buyers explore and turn into their own charts. Admins can hide a dataset from any of those roles.
-- The parsed data lives as one JSON file per dataset in the private hub-data bucket; this table holds the catalogue.

-- Who someone is in the hub. Affiliates are added by hand on the access list with role 'affiliate'.
alter table public.outlook_access add column if not exists role text not null default 'member';
do $$ begin
  alter table public.outlook_access add constraint outlook_access_role_check check (role in ('member', 'affiliate'));
exception when duplicate_object then null; end $$;

create or replace function private.hub_role() returns text language sql stable security definer set search_path = '' as $$
  select case
    when private.is_admin() then 'admin'
    when exists (select 1 from public.outlook_access a where a.email = private.jwt_email() and a.role = 'member') then 'member'
    when exists (select 1 from public.outlook_access a where a.email = private.jwt_email() and a.role = 'affiliate') then 'affiliate'
    when private.has_any_access() then 'buyer'
    else null end;
$$;

create table if not exists public.hub_datasets (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  title text not null,
  description text not null default '',
  source text not null default '',
  kind text not null check (kind in ('table', 'survey')),
  file_path text not null,                 -- object in the hub-data bucket
  original_name text not null default '',
  meta jsonb not null default '{}'::jsonb, -- small summary for the library: columns, questions, breakdowns, row count
  hidden_from text[] not null default '{}' check (hidden_from <@ array['member', 'affiliate', 'buyer']::text[]),
  status text not null default 'published' check (status in ('draft', 'published')),
  sort integer not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.hub_datasets enable row level security;

create or replace function private.dataset_open(d public.hub_datasets) returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_admin() or (d.status = 'published' and private.has_any_access() and not (coalesce(private.hub_role(), '') = any (d.hidden_from)));
$$;
create or replace function private.dataset_file_open(path text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.hub_datasets d where d.file_path = path and private.dataset_open(d));
$$;

drop policy if exists "Read datasets you can open" on public.hub_datasets;
create policy "Read datasets you can open" on public.hub_datasets for select to authenticated using (private.dataset_open(hub_datasets));
drop policy if exists "Admins add datasets" on public.hub_datasets;
create policy "Admins add datasets" on public.hub_datasets for insert to authenticated with check ((select private.is_admin()));
drop policy if exists "Admins change datasets" on public.hub_datasets;
create policy "Admins change datasets" on public.hub_datasets for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
drop policy if exists "Admins delete datasets" on public.hub_datasets;
create policy "Admins delete datasets" on public.hub_datasets for delete to authenticated using ((select private.is_admin()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hub-data', 'hub-data', false, 52428800, array['application/json'])
on conflict (id) do nothing;
drop policy if exists "Read data files you can open" on storage.objects;
create policy "Read data files you can open" on storage.objects for select to authenticated
  using (bucket_id = 'hub-data' and (select private.dataset_file_open(name)));
drop policy if exists "Admins read all data files" on storage.objects;
create policy "Admins read all data files" on storage.objects for select to authenticated using (bucket_id = 'hub-data' and (select private.is_admin()));
drop policy if exists "Admins upload data files" on storage.objects;
create policy "Admins upload data files" on storage.objects for insert to authenticated with check (bucket_id = 'hub-data' and (select private.is_admin()));
drop policy if exists "Admins replace data files" on storage.objects;
create policy "Admins replace data files" on storage.objects for update to authenticated using (bucket_id = 'hub-data' and (select private.is_admin()));
drop policy if exists "Admins delete data files" on storage.objects;
create policy "Admins delete data files" on storage.objects for delete to authenticated using (bucket_id = 'hub-data' and (select private.is_admin()));

-- Reports people build and save for themselves
create table if not exists public.hub_saved_reports (
  id uuid primary key default gen_random_uuid(),
  email text not null default private.jwt_email(),
  dataset_id uuid not null references public.hub_datasets (id) on delete cascade,
  title text not null,
  config jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists hub_saved_reports_email on public.hub_saved_reports (email);
create index if not exists hub_saved_reports_dataset on public.hub_saved_reports (dataset_id);
alter table public.hub_saved_reports enable row level security;
drop policy if exists "Own saved reports" on public.hub_saved_reports;
create policy "Own saved reports" on public.hub_saved_reports for all to authenticated
  using (email = (select private.jwt_email())) with check (email = (select private.jwt_email()) and (select private.has_any_access()));

-- hub_access() also says which role the person has (otherwise unchanged from the live definition)
create or replace function public.hub_access() returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'member', exists (select 1 from public.outlook_access a where a.email = private.jwt_email()),
    'role', private.hub_role(),
    'admin', private.is_admin(),
    'subscription', (select jsonb_build_object('status', e.status, 'until', e.current_period_end, 'portal', e.stripe_customer is not null)
                     from public.hub_entitlements e where e.email = private.jwt_email() and e.kind = 'subscription'
                     order by (e.status in ('active', 'trialing', 'past_due')) desc, e.created_at desc limit 1),
    'subscribed', private.has_subscription(),
    'reports', coalesce((select jsonb_agg(distinct e.report_key) from public.hub_entitlements e
                         where e.email = private.jwt_email() and e.kind = 'report' and e.status = 'active'
                           and (e.current_period_end is null or e.current_period_end > now())), '[]'::jsonb),
    'until', coalesce((select jsonb_object_agg(k, u) from (select e.report_key k, max(e.current_period_end) u from public.hub_entitlements e
                         where e.email = private.jwt_email() and e.kind = 'report' and e.status = 'active'
                           and e.current_period_end > now() group by e.report_key) x), '{}'::jsonb),
    'receipts', exists (select 1 from public.hub_entitlements e where e.email = private.jwt_email() and e.stripe_customer is not null));
$$;
