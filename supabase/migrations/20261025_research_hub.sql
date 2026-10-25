-- AIA Canada Research Hub: research reports uploaded by admins and the figures read from them.
create table public.hub_reports (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null default '',
  series text not null default '',
  published_on date,
  summary text not null default '',
  key_findings jsonb not null default '[]'::jsonb,
  source_url text not null default '',
  status text not null default 'draft' check (status in ('draft','processing','review','published','archived')),
  file_path text not null default '',
  file_name text not null default '',
  pages integer not null default 0,
  chunks_total integer not null default 0,
  chunks_done integer not null default 0,
  error text not null default '',
  sort integer not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.hub_figures (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.hub_reports(id) on delete cascade,
  sort integer not null default 0,
  page integer,
  payload jsonb not null,
  hidden boolean not null default false,
  confidence text not null default 'high' check (confidence in ('high','medium','low')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index hub_figures_report_idx on public.hub_figures (report_id, sort);
alter table public.hub_reports enable row level security;
alter table public.hub_figures enable row level security;
revoke all on public.hub_reports, public.hub_figures from anon;
grant select, insert, update, delete on public.hub_reports, public.hub_figures to authenticated;
create policy "Members read published reports" on public.hub_reports for select to authenticated
  using ((status = 'published' and (select private.has_outlook_access())) or (select private.is_admin()));
create policy "Admins add reports" on public.hub_reports for insert to authenticated with check ((select private.is_admin()));
create policy "Admins change reports" on public.hub_reports for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "Admins delete reports" on public.hub_reports for delete to authenticated using ((select private.is_admin()));
create policy "Members read figures of published reports" on public.hub_figures for select to authenticated
  using ((select private.is_admin()) or (not hidden and (select private.has_outlook_access())
    and exists (select 1 from public.hub_reports r where r.id = report_id and r.status = 'published')));
create policy "Admins add figures" on public.hub_figures for insert to authenticated with check ((select private.is_admin()));
create policy "Admins change figures" on public.hub_figures for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "Admins delete figures" on public.hub_figures for delete to authenticated using ((select private.is_admin()));
create or replace function private.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;
create trigger hub_reports_touch before update on public.hub_reports for each row execute function private.touch_updated_at();
create trigger hub_figures_touch before update on public.hub_figures for each row execute function private.touch_updated_at();
-- Private bucket for the uploaded PDFs: admins only. Members never get the file (full reports are sold).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hub-reports', 'hub-reports', false, 52428800, array['application/pdf']);
create policy "Admins upload hub reports" on storage.objects for insert to authenticated with check (bucket_id = 'hub-reports' and (select private.is_admin()));
create policy "Admins read hub reports" on storage.objects for select to authenticated using (bucket_id = 'hub-reports' and (select private.is_admin()));
create policy "Admins replace hub reports" on storage.objects for update to authenticated using (bucket_id = 'hub-reports' and (select private.is_admin()));
create policy "Admins delete hub reports" on storage.objects for delete to authenticated using (bucket_id = 'hub-reports' and (select private.is_admin()));
-- Short-lived tokens that let hub-extract be tested without an admin sign-in. No policies: only the service role can read it.
create table public.hub_test_tokens (token text primary key check (length(token) >= 32), expires_at timestamptz not null);
alter table public.hub_test_tokens enable row level security;
revoke all on public.hub_test_tokens from anon, authenticated;
