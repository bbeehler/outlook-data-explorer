-- Research Hub store: non-members can buy a single report ($199) or subscribe to all reports ($49/month) through Stripe.
-- Purchases are recorded by the hub-stripe-webhook function (service role) in hub_entitlements, keyed by email.
-- Members (outlook_access) and admins keep full access; buyers see only what they bought; subscribers see everything.

create table if not exists public.hub_entitlements (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email)),
  kind text not null check (kind in ('report', 'subscription')),
  report_key text,                       -- 'r:<slug>' or 'outlook' for a single report; null for a subscription
  status text not null default 'active', -- active, trialing, past_due, canceled, unpaid, refunded ...
  current_period_end timestamptz,        -- subscriptions: paid up to
  stripe_customer text,
  stripe_subscription text,
  stripe_session text unique,
  stripe_payment_intent text,
  amount_cents integer,
  currency text,
  note text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'subscription' or report_key is not null)
);
create index if not exists hub_entitlements_email on public.hub_entitlements (email);
create index if not exists hub_entitlements_sub on public.hub_entitlements (stripe_subscription);
alter table public.hub_entitlements enable row level security;
drop policy if exists "Users see own purchases; admins see all" on public.hub_entitlements;
create policy "Users see own purchases; admins see all" on public.hub_entitlements for select to authenticated
  using (email = lower(coalesce((select auth.jwt()) ->> 'email', '')) or (select private.is_admin()));
-- no insert/update/delete policies: only the service role (Stripe webhook) writes purchases

create or replace function private.jwt_email() returns text language sql stable set search_path = '' as $$
  select lower(coalesce((select auth.jwt()) ->> 'email', ''));
$$;

-- An active subscription paid up to now (Stripe keeps a subscription 'active' while paid; a short grace period covers renewal timing)
create or replace function private.has_subscription() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.hub_entitlements e
    where e.email = private.jwt_email() and e.kind = 'subscription' and e.status in ('active', 'trialing', 'past_due')
      and (e.current_period_end is null or e.current_period_end > now() - interval '3 days'));
$$;

-- Can the signed-in user open this report? key = 'r:<slug>' or 'outlook'
create or replace function private.entitled(key text) returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_outlook_access() or private.has_subscription() or exists (
    select 1 from public.hub_entitlements e
    where e.email = private.jwt_email() and e.kind = 'report' and e.report_key = key and e.status = 'active');
$$;

create or replace function private.has_any_access() returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_outlook_access() or private.has_subscription() or exists (
    select 1 from public.hub_entitlements e where e.email = private.jwt_email() and e.kind = 'report' and e.status = 'active');
$$;

-- What the page needs to know about the signed-in user
create or replace function public.hub_access() returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'member', exists (select 1 from public.outlook_access a where a.email = private.jwt_email()),
    'admin', private.is_admin(),
    'subscription', (select jsonb_build_object('status', e.status, 'until', e.current_period_end, 'portal', e.stripe_customer is not null)
                     from public.hub_entitlements e where e.email = private.jwt_email() and e.kind = 'subscription'
                     order by (e.status in ('active', 'trialing', 'past_due')) desc, e.created_at desc limit 1),
    'subscribed', private.has_subscription(),
    'reports', coalesce((select jsonb_agg(distinct e.report_key) from public.hub_entitlements e
                         where e.email = private.jwt_email() and e.kind = 'report' and e.status = 'active'), '[]'::jsonb));
$$;
create or replace function public.hub_has_any_access() returns boolean language sql stable set search_path = '' as $$ select private.has_any_access(); $$;
create or replace function public.hub_entitled(key text) returns boolean language sql stable set search_path = '' as $$ select private.entitled(key); $$;
revoke all on function public.hub_access(), public.hub_has_any_access(), public.hub_entitled(text) from public, anon;
grant execute on function public.hub_access(), public.hub_has_any_access(), public.hub_entitled(text) to authenticated;

-- Reports: titles and summaries for anyone with some access; figures only for what they're entitled to
drop policy if exists "Members read published reports" on public.hub_reports;
create policy "Members read published reports" on public.hub_reports for select to authenticated
  using ((status = 'published' and (select private.has_any_access())) or (select private.is_admin()));
drop policy if exists "Members read figures of published reports" on public.hub_figures;
create policy "Members read figures of published reports" on public.hub_figures for select to authenticated
  using ((select private.is_admin()) or (not hidden and exists (
    select 1 from public.hub_reports r where r.id = hub_figures.report_id and r.status = 'published' and private.entitled('r:' || r.slug))));
drop policy if exists "Approved users read figures" on public.outlook_figures;
create policy "Approved users read figures" on public.outlook_figures for select to authenticated
  using ((select private.entitled('outlook')));

-- Public catalogue for the landing page (signed-out visitors): published reports with their summaries, no figures
create or replace function public.hub_catalog() returns table (key text, title text, series text, published_on date, summary text,
  key_findings jsonb, charts integer, sections integer, has_pdf boolean, source_url text)
language sql stable security definer set search_path = '' as $$
  select 'r:' || r.slug, r.title, r.series, r.published_on, r.summary, to_jsonb(r.key_findings),
    (select count(*)::int from public.hub_figures f where f.report_id = r.id and not f.hidden),
    coalesce(jsonb_array_length(r.sections), 0), coalesce(r.file_path, '') <> '', coalesce(r.source_url, '')
  from public.hub_reports r where r.status = 'published'
  order by r.published_on desc nulls last;
$$;
grant execute on function public.hub_catalog() to anon, authenticated;
