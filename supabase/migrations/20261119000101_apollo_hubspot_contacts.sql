-- Apollo also covers people HubSpot holds (name and job role) without an email address: they carry the HubSpot id and get a local URN from the same sequence HubSpot-sourced contacts use.
alter table public.apollo_queue add column if not exists source text not null default 'oscar' check (source in ('oscar', 'hubspot'));
alter table public.apollo_queue add column if not exists hubspot_contact_id text;
alter table public.apollo_queue alter column contact_urn set default nextval('public.contact_local_urn');
create unique index if not exists apollo_queue_hubspot_contact_idx on public.apollo_queue (hubspot_contact_id) where hubspot_contact_id is not null;
