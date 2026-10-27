-- The parent company on the HubSpot company record (HubSpot's own company hierarchy), so Atlas can check that a merged practice is linked to its successor.
alter table public.gp_practices add column if not exists hubspot_parent_company_id text;
