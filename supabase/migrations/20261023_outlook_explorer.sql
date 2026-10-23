-- Applied to the "AIA Canada Data Portal" Supabase project on 2026-10-23.
-- Tables: outlook_access (who may sign in), outlook_figures (the data, readable only by approved users),
-- outlook_ai_log (one row per AI question). See README for how access works.

create table public.outlook_access (
  email text primary key check (email = lower(email) and position('@' in email) > 1),
  full_name text not null default '', organization text not null default '', note text not null default '',
  added_at timestamptz not null default now(), added_by uuid default auth.uid()
);
create table public.outlook_figures (
  id text primary key, edition text not null default '2025', topic text not null, sort integer not null,
  payload jsonb not null, updated_at timestamptz not null default now()
);
create index outlook_figures_sort_idx on public.outlook_figures (edition, sort);
create table public.outlook_ai_log (
  id bigint generated always as identity primary key, user_id uuid not null,
  asked_at timestamptz not null default now(), chars integer not null default 0, ok boolean not null default true
);
create index outlook_ai_log_user_idx on public.outlook_ai_log (user_id, asked_at desc);

create or replace function private.has_outlook_access() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.outlook_access a where a.email = lower(coalesce((select auth.jwt()) ->> 'email', ''))) or private.is_admin();
$$;
revoke all on function private.has_outlook_access() from public, anon;
grant execute on function private.has_outlook_access() to authenticated;
create or replace function public.outlook_has_access() returns boolean language sql stable security invoker set search_path = '' as $$ select private.has_outlook_access(); $$;
create or replace function public.outlook_is_admin() returns boolean language sql stable security invoker set search_path = '' as $$ select private.is_admin(); $$;
revoke all on function public.outlook_has_access(), public.outlook_is_admin() from public, anon;
grant execute on function public.outlook_has_access(), public.outlook_is_admin() to authenticated;

alter table public.outlook_access enable row level security;
alter table public.outlook_figures enable row level security;
alter table public.outlook_ai_log enable row level security;
revoke all on public.outlook_access, public.outlook_figures, public.outlook_ai_log from anon;
grant select on public.outlook_figures to authenticated;
grant select, insert, update, delete on public.outlook_access to authenticated;
grant select on public.outlook_ai_log to authenticated;

create policy "Approved users read figures" on public.outlook_figures for select to authenticated using ((select private.has_outlook_access()));
create policy "Users see own access row; admins see all" on public.outlook_access for select to authenticated
  using (email = lower(coalesce((select auth.jwt()) ->> 'email', '')) or (select private.is_admin()));
create policy "Admins add access" on public.outlook_access for insert to authenticated with check ((select private.is_admin()));
create policy "Admins change access" on public.outlook_access for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "Admins remove access" on public.outlook_access for delete to authenticated using ((select private.is_admin()));
create policy "Admins read AI usage" on public.outlook_ai_log for select to authenticated using ((select private.is_admin()));
