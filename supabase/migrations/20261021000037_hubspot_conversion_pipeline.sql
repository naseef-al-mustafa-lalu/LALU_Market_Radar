-- Freemium was discontinued: the Conversion pipeline moves Freemium customers to ReportSure. Kept apart from new-business (Sales) pipeline.
alter table public.gp_practices add column if not exists hubspot_conversion_pipeline numeric;   -- open Conversion deal amounts; hubspot_pipeline is now Sales only
