-- One log of everything the tool does to HubSpot: user pushes, companies created, PCN records created / repaired / closed, daily sync runs.
-- Written by the hubspot-push edge function and the daily sync (service role); signed-in allowlisted users can read.
create table if not exists public.hubspot_activity (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,                       -- a user's email, or 'daily sync' / 'manual sync'
  kind text not null,                        -- push, push_check, create_company, link_company, pcn_created, pcn_repaired, pcn_inactivated, associations, sync_run
  ok boolean not null default true,
  ods_code text, target text,                -- practice code, and the HubSpot record's name
  hubspot_type text, hubspot_id text,        -- 'company' | 'deal' | 'pcn' ...
  summary text not null,
  detail jsonb);                             -- before / after values, stats, validation result
create index if not exists hubspot_activity_at on public.hubspot_activity (at desc);
create index if not exists hubspot_activity_ods on public.hubspot_activity (ods_code);
alter table public.hubspot_activity enable row level security;
create policy read_hubspot_activity on public.hubspot_activity for select to authenticated using ((select private.is_allowed()));
