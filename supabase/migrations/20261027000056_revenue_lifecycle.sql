-- What the Revenue > Patients under management page needs from HubSpot, per practice: company status, the (primary) Service's name and product, Product / Service from the won deal
-- (eMR = Self service, eMR+ = Managed service), when the first Service started, when it churned (Service "Date Churned"), and the size signed for.
alter table public.gp_practices
  add column if not exists hubspot_company_status text,
  add column if not exists hubspot_service_name text,
  add column if not exists hubspot_product text check (hubspot_product in ('all', 'sar', 'self', 'payg', 'freemium')),
  add column if not exists hubspot_product_service text,
  add column if not exists hubspot_first_start date,
  add column if not exists hubspot_churned_date date,
  add column if not exists hubspot_signed_size integer,
  add column if not exists hubspot_size_history jsonb;   -- [[won deal close date, patients in that contract], ...]: what the contracts said, so the chart follows renewals
