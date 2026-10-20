-- The discount caps were never used by any calculation and no longer match how discounts stack: remove them.
delete from public.pricing_settings where key in ('discount_cap_practice', 'discount_cap_pcn', 'discount_cap_icb');

-- Group and federation routes are documented as "starts from the PCN schedule". They had drifted (older size and speed values),
-- so bring them back in line with the PCN tiers. Edit them in pricing_tiers if they should differ.
update public.pricing_tiers g
   set threshold = p.threshold, size_discount = p.size_discount, speed_discount = p.speed_discount
  from public.pricing_tiers p
 where p.route = 'pcn' and g.route in ('group', 'federation') and g.tier = p.tier;
