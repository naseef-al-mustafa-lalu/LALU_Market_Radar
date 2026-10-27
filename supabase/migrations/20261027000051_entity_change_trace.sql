-- Traceability for merged practices and sites that continue as branches: the branch's own HubSpot company, and a one-line note on the practice saying what was done in HubSpot and by whom.
alter table public.practice_branches add column if not exists hubspot_company_id text;
alter table public.gp_practices add column if not exists hubspot_change_note text;
