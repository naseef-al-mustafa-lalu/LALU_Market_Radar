-- Contract start and renewal dates from the live HubSpot Service(s) behind a practice's contracted ARR.
alter table public.gp_practices
  add column if not exists hubspot_contract_start date,
  add column if not exists hubspot_contract_end date;
