-- A group or federation deal covers certain practices, and one deal can sit on both the provider group and the federation: the key is (deal, organisation) and each row keeps the practices it covers.
alter table public.hubspot_network_deals add column if not exists covers text[] not null default '{}';
alter table public.hubspot_network_deals drop constraint if exists hubspot_network_deals_pkey;
alter table public.hubspot_network_deals add primary key (deal_id, org_id);
