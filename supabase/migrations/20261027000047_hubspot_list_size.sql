-- The Patient List Size on the HubSpot company. For a customer it is the contract basis and only changes at renewal, so Atlas shows it beside the latest NHS figure.
alter table public.gp_practices add column if not exists hubspot_list_size integer;
