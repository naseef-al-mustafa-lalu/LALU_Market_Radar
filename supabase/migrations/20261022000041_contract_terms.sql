-- Pricing of the latest closed-won deal (discount fractions, £ per patient per month), synced from HubSpot for the profile's Contract section.
alter table public.gp_practices add column if not exists hubspot_contract_terms jsonb;
