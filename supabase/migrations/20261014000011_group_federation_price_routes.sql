-- Provider groups and federations are multi-practice contracts: ARR is the aggregate of their linked practices' patients,
-- priced here with the PCN schedule as a starting point. Edit these rows in pricing_tiers to change it.
insert into public.pricing_tiers (route, tier, label, threshold, size_discount, speed_discount)
select r.route, t.tier, t.label, t.threshold, t.size_discount, t.speed_discount
  from public.pricing_tiers t cross join (values ('group'), ('federation')) as r(route)
 where t.route = 'pcn'
on conflict (route, tier) do nothing;
