-- Saved links between a practice and its HubSpot company and deal, so the pricing push does not need re-linking.
-- Written only by the hubspot-push edge function (service role); signed-in allowlisted users can read.
create table if not exists public.hubspot_links (
  ods_code text primary key references public.gp_practices(ods_code) on delete cascade,
  company_id text not null, company_name text, deal_id text not null, deal_name text,
  linked_by text, linked_at timestamptz not null default now(), last_pushed_at timestamptz);
create table if not exists public.hubspot_push_log (
  id bigint generated always as identity primary key,
  ods_code text not null, company_id text, deal_id text, pushed_by text, pushed_at timestamptz not null default now(),
  before_values jsonb, written_values jsonb, validation jsonb);
alter table public.hubspot_links enable row level security;
alter table public.hubspot_push_log enable row level security;
create policy read_hubspot_links on public.hubspot_links for select to authenticated using ((select private.is_allowed()));
create policy read_hubspot_push_log on public.hubspot_push_log for select to authenticated using ((select private.is_allowed()));
