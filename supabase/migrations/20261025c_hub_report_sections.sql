-- Report sections (like chapters): [{key, name, blurb}] in reading order. Each figure's payload.section holds a key.
alter table public.hub_reports add column sections jsonb not null default '[]'::jsonb;
