-- Pricing model update (sheet "LALU Care - Pricing & Discount Model", Multi-Year-Matrix / Pricing-Discount-Model tabs):
--  * a term-length discount for 2 and 3 year commitments
--  * an absolute price floor per patient
--  * speed discount (Year 1 only) is now 5% practices, 2.5% PCNs (and PCN-like routes), 0% ICBs
insert into public.pricing_settings (key, value, description) values
 ('term_discount_2yr', 0.025, 'Extra discount for a 2-year commitment (added to size and speed discounts)'),
 ('term_discount_3yr', 0.05, 'Extra discount for a 3-year commitment (added to size and speed discounts)'),
 ('price_floor_per_patient', 0.05, 'Lowest price per patient after all discounts (GBP, excl. VAT)')
on conflict (key) do update set value = excluded.value, description = excluded.description;

update public.pricing_tiers set speed_discount = 0.05  where route = 'practice';
update public.pricing_tiers set speed_discount = 0.025 where route in ('pcn', 'group', 'federation');
update public.pricing_tiers set speed_discount = 0     where route = 'icb';
