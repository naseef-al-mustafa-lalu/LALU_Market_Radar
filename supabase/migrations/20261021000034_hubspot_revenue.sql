-- HubSpot's real money per practice: contracted ARR (live Service ACV, else closed-won deals, flagged) and open deal pipeline.
alter table public.gp_practices
  add column if not exists hubspot_contracted_arr numeric,
  add column if not exists hubspot_contracted_src text,          -- 'service' | 'deal' (deal = unverified fallback)
  add column if not exists hubspot_pipeline numeric,             -- open Sales + Conversion deal amounts
  add column if not exists hubspot_renewal_pipeline numeric;     -- open Renewals deal amounts
