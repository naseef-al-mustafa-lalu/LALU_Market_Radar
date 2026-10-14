-- HubSpot tracking for the future HubSpot integration. Additive only: nothing existing is dropped or rewritten.
-- Contacts: has the contact been imported into HubSpot, and when.
alter table public.contacts
  add column hubspot_status text not null default 'Not imported' check (hubspot_status in ('Not imported', 'Imported')),
  add column hubspot_imported_at timestamptz,
  add column hubspot_contact_id text;

-- Practices (= HubSpot companies): import date and the engagement / customer status that will come from HubSpot.
alter table public.gp_practices
  add column hubspot_company_id text,
  add column hubspot_company_imported_at timestamptz,
  add column hubspot_stage text,                                   -- raw HubSpot lifecycle stage, for reference
  add column hubspot_engaged boolean not null default false,       -- in an active sales conversation (set by the integration)
  add column hubspot_customer boolean not null default false,      -- is a customer (set by the integration)
  add column hubspot_synced_at timestamptz;

-- Per-practice contact import roll-up.
create view public.practice_hubspot with (security_invoker = true) as
select g.ods_code,
       count(c.contact_urn) as hs_contacts,
       count(c.contact_urn) filter (where c.hubspot_status = 'Imported') as hs_imported,
       coalesce(bool_or(c.is_primary and c.hubspot_status = 'Imported'), false) as hs_primary_imported,
       max(c.hubspot_imported_at) as hs_last_imported_at,
       max(c.hubspot_imported_at) filter (where c.is_primary) as hs_primary_imported_at
  from public.gp_practices g
  left join public.contacts c on c.ods_code = g.ods_code
 group by g.ods_code;

-- Networks (PCN / ICB / group / federation): linked practices, tier mix, ARR under each route, and HubSpot engagement / customers.
create view public.network_summary with (security_invoker = true) as
with base as (
  select o.id, o.kind, o.name, o.source_key,
         count(*) as practices,
         coalesce(sum(p.total_patients), 0)::bigint as patients,
         count(*) filter (where pp.price_tier = 1) as tier1, count(*) filter (where pp.price_tier = 2) as tier2,
         count(*) filter (where pp.price_tier = 3) as tier3, count(*) filter (where pp.price_tier = 4) as tier4,
         count(*) filter (where pp.price_tier = 5) as tier5,
         count(*) filter (where p.clinical_software = 'EMIS Web') as emis,
         count(*) filter (where p.clinical_software = 'SystmOne') as systmone,
         count(*) filter (where p.cqc_rating in ('Requires improvement','Inadequate')) as cqc_concern,
         count(*) filter (where p.hubspot_engaged or p.hubspot_customer) as engaged,
         count(*) filter (where p.hubspot_customer) as customers,
         count(*) filter (where ph.hs_imported > 0) as hs_imported,
         coalesce(sum(pp.est_arr), 0) as arr_single,
         coalesce(sum(pp.est_arr) filter (where p.hubspot_customer), 0) as arr_customers,
         bool_and(r.confirmed) as confirmed
    from public.organisations o
    join public.org_relationships r on r.to_org = o.id
    join public.organisations pr on pr.id = r.from_org and pr.kind = 'practice'
    join public.gp_practices p on p.ods_code = pr.ods_code and p.status = 'Active'
    join public.practice_pricing pp on pp.ods_code = p.ods_code
    join public.practice_hubspot ph on ph.ods_code = p.ods_code
   where o.kind in ('pcn','icb','group','federation')
   group by o.id, o.kind, o.name, o.source_key)
select b.*, t.tier as network_tier, t.label as network_tier_label,
       round(s.list * (1 - t.size_discount), 4) as network_base_price,
       round(b.patients * s.list * (1 - t.size_discount), 0) as arr_network,
       round(b.patients * s.list * (1 - t.size_discount - t.speed_discount), 0) as arr_network_year1
  from base b
  cross join (select value as list from public.pricing_settings where key = 'list_price_per_patient') s
  left join lateral (select * from public.pricing_tiers pt where pt.route = b.kind and b.patients >= pt.threshold
                      order by pt.threshold desc limit 1) t on true;

grant select on public.practice_hubspot, public.network_summary to authenticated;
