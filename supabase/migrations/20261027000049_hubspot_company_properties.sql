-- HubSpot company properties kept beside the NHS-derived values so the two databases can be compared: Org Type, Operating status and Website URL.
alter table public.gp_practices add column if not exists hubspot_org_type text;
alter table public.gp_practices add column if not exists hubspot_operating_status text;
alter table public.gp_practices add column if not exists hubspot_website text;
