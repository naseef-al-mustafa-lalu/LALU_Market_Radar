-- Deals the tool created in HubSpot for a whole network (federation, provider group, PCN, ICB), so the network profile can say a deal is linked.
create table if not exists public.hubspot_network_deals (
  deal_id text primary key,
  org_id uuid not null references public.organisations(id) on delete cascade,
  company_id text not null,
  deal_name text,
  created_by text,
  created_at timestamptz not null default now());
create index if not exists hubspot_network_deals_org on public.hubspot_network_deals (org_id);
alter table public.hubspot_network_deals enable row level security;
create policy read_hubspot_network_deals on public.hubspot_network_deals for select to authenticated using ((select private.is_allowed()));
