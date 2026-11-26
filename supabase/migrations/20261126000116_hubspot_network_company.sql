-- APPLIED 2026-11-26. Which HubSpot company belongs to a network (PCN, ICB, group or federation). Matched once by name (or chosen, or created) and remembered, so the wizard never asks again.
-- Separate from hubspot_org_companies, which the daily sync rewrites.
create table if not exists public.hubspot_network_company (
  org_id text primary key,
  company_id text not null,
  company_name text,
  matched_by text not null default 'auto' check (matched_by in ('auto', 'chosen', 'created')),
  linked_by text,
  linked_at timestamptz not null default now());
alter table public.hubspot_network_company enable row level security;
create policy read_hubspot_network_company on public.hubspot_network_company for select to authenticated using ((select private.is_allowed()));
create policy write_hubspot_network_company on public.hubspot_network_company for insert to authenticated with check ((select private.is_allowed()));
create policy update_hubspot_network_company on public.hubspot_network_company for update to authenticated using ((select private.is_allowed())) with check ((select private.is_allowed()));
create policy delete_hubspot_network_company on public.hubspot_network_company for delete to authenticated using ((select private.is_allowed()));
