-- Pricing model (from the sheet "Single Practice/PCN/ICB Patient Size Threshold Analysis For Discounts") as editable data.
-- Non-destructive: nothing existing is altered. ARR is calculated by the views below, so editing a rate updates everything.
create table public.pricing_settings (
  key text primary key,
  value numeric not null,
  description text
);
insert into public.pricing_settings values
 ('list_price_per_patient', 0.08, 'Annual list price per patient (GBP, excl. VAT)'),
 ('monthly_list_price_per_patient', 0.01, 'Monthly list price per patient (GBP, excl. VAT)'),
 ('vat_rate', 0.20, 'UK VAT rate'),
 ('discount_cap_practice', 0.15, 'Max combined discount, single practice (size + speed + prepayment)'),
 ('discount_cap_pcn', 0.275, 'Max combined discount, PCN'),
 ('discount_cap_icb', 0.40, 'Max combined discount, ICB'),
 ('prepayment_discount_min', 0.02, 'Annual prepayment discount, low end'),
 ('prepayment_discount_max', 0.03, 'Annual prepayment discount, high end'),
 ('indexation_min', 0.02, 'Annual indexation from year 2, low end'),
 ('indexation_max', 0.04, 'Annual indexation from year 2, high end'),
 ('gross_margin_floor', 0.82, 'Minimum gross margin'),
 ('min_commitment_months', 36, 'Minimum term for network and system contracts');

create table public.pricing_tiers (
  route text not null check (route in ('practice','pcn','icb','group','federation')),
  tier int not null check (tier between 1 and 9),
  label text not null,
  threshold bigint not null,            -- patients under management >=
  size_discount numeric not null,       -- recurring size discount
  speed_discount numeric not null,      -- year 1 only
  primary key (route, tier)
);
insert into public.pricing_tiers values
 ('practice',1,'Very Large / Enterprise',20000,0.100,0.05),
 ('practice',2,'Large',15000,0.075,0.05),
 ('practice',3,'Medium-Large',10000,0.050,0.05),
 ('practice',4,'Medium',5000,0.000,0.05),
 ('practice',5,'Solo / Small',0,0.000,0.05),
 ('pcn',1,'Very Large / Enterprise',80000,0.225,0.05),
 ('pcn',2,'Large',60000,0.200,0.05),
 ('pcn',3,'Medium-Large',45000,0.175,0.05),
 ('pcn',4,'Medium',30000,0.150,0.05),
 ('pcn',5,'Solo / Small',0,0.125,0.05),
 ('icb',1,'Very Large / Enterprise',3500000,0.375,0.025),
 ('icb',2,'Large',2500000,0.350,0.025),
 ('icb',3,'Medium-Large',1750000,0.325,0.025),
 ('icb',4,'Medium',1000000,0.300,0.025),
 ('icb',5,'Solo / Small',0,0.275,0.025);

alter table public.pricing_settings enable row level security;
alter table public.pricing_tiers enable row level security;
create policy read_pricing_settings on public.pricing_settings for select to authenticated using (private.is_allowed());
create policy read_pricing_tiers on public.pricing_tiers for select to authenticated using (private.is_allowed());
grant select on public.pricing_settings, public.pricing_tiers to authenticated;
grant all on public.pricing_settings, public.pricing_tiers to service_role;

-- Per-practice tier and estimated ARR (single-practice route).
create view public.practice_pricing with (security_invoker = true) as
select g.ods_code, t.tier as price_tier, 'Tier ' || t.tier || ' (' || t.label || ')' as tier_label,
       round(s.list * (1 - t.size_discount), 4) as base_price,
       round(s.list * (1 - t.size_discount - t.speed_discount), 4) as year1_price,
       round(g.total_patients * s.list * (1 - t.size_discount), 0) as est_arr,
       round(g.total_patients * s.list * (1 - t.size_discount - t.speed_discount), 0) as est_arr_year1
  from public.gp_practices g
  cross join (select value as list from public.pricing_settings where key = 'list_price_per_patient') s
  left join lateral (select * from public.pricing_tiers pt where pt.route = 'practice' and g.total_patients >= pt.threshold
                      order by pt.threshold desc limit 1) t on true;

-- Per-network (PCN / ICB / group / federation) practice counts, tier mix and ARR under each route.
create view public.org_pricing with (security_invoker = true) as
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
         count(*) filter (where p.lead_status in ('In-Progress','Contacted')) as engaged,
         count(*) filter (where p.lead_status = 'Do-Not-Contact') as do_not_contact,
         coalesce(sum(pp.est_arr), 0) as arr_single,
         bool_and(r.confirmed) as confirmed
    from public.organisations o
    join public.org_relationships r on r.to_org = o.id
    join public.organisations pr on pr.id = r.from_org and pr.kind = 'practice'
    join public.gp_practices p on p.ods_code = pr.ods_code and p.status = 'Active'
    join public.practice_pricing pp on pp.ods_code = p.ods_code
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

grant select on public.practice_pricing, public.org_pricing to authenticated;
