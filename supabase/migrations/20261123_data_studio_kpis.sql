-- Data Studio KPIs: measures admins define once as a formula over columns (for example sum([Labour sales]) / count()).
-- People pick them as a block's Value when they build a report. A KPI works on any dataset that has the columns it names,
-- so the same definition can run on uploaded files and, later, on API data from shop platforms.
create table if not exists public.hub_kpis (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  description text not null default '',
  formula text not null check (length(formula) between 1 and 2000),
  format text not null default 'number' check (format in ('number', 'currency', 'percent')),
  hidden_from text[] not null default '{}' check (hidden_from <@ array['member', 'affiliate', 'buyer']::text[]),
  status text not null default 'draft' check (status in ('draft', 'published')),
  sort integer not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.hub_kpis enable row level security;

drop policy if exists "Read KPIs you can use" on public.hub_kpis;
create policy "Read KPIs you can use" on public.hub_kpis for select to authenticated using (
  (select private.is_admin())
  or (status = 'published' and (select private.has_any_access()) and not (coalesce((select private.hub_role()), '') = any (hidden_from))));
drop policy if exists "Admins add KPIs" on public.hub_kpis;
create policy "Admins add KPIs" on public.hub_kpis for insert to authenticated with check ((select private.is_admin()));
drop policy if exists "Admins change KPIs" on public.hub_kpis;
create policy "Admins change KPIs" on public.hub_kpis for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
drop policy if exists "Admins delete KPIs" on public.hub_kpis;
create policy "Admins delete KPIs" on public.hub_kpis for delete to authenticated using ((select private.is_admin()));
