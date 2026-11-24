-- Member directory snapshot: keep each organisation's "Sales Volume" range from Insightly (filled by outlook-member-sync),
-- so admins can count members by size (for example for the Founding 250 program).
alter table public.outlook_member_orgs add column if not exists sales_volume text not null default '';
