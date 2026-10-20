-- Links between the tool's PCN / ICB networks and HubSpot's PCN and ICB custom objects, filled by the daily HubSpot sync.
create table if not exists public.hubspot_network_links (
  org_id uuid primary key references public.organisations(id) on delete cascade,
  object_type text not null check (object_type in ('p145802630_pcns', 'p145802630_icbs')),
  object_id text not null,
  matched_on text,
  open_deals_amount numeric, won_deals_amount numeric, active_emr_practices int, associated_practices int,
  synced_at timestamptz not null default now());
alter table public.hubspot_network_links enable row level security;
create policy read_hubspot_network_links on public.hubspot_network_links for select to authenticated using ((select private.is_allowed()));
