-- Rates are quoted per patient per MONTH (annual plan 0.08, monthly plan 0.10), as in the pricing spreadsheet. Annual revenue = patients x rate x 12.
-- Replaces the short-lived monthly_plan_rate_per_patient_year setting: the monthly plan rate goes back to monthly_list_price_per_patient (read from the sheet's monthly price cell).
update public.pricing_settings set value = 0.08, description = 'Annual-plan list price per patient per month (GBP excl. VAT)' where key = 'list_price_per_patient';
update public.pricing_settings set value = 0.10, description = 'Monthly-plan list price per patient per month (GBP excl. VAT)' where key = 'monthly_list_price_per_patient';
update public.pricing_settings set description = 'Lowest price per patient per month after all discounts (GBP, excl. VAT)' where key = 'price_floor_per_patient';
update public.pricing_settings set description = 'Superseded by monthly_list_price_per_patient (not used)' where key = 'monthly_plan_rate_per_patient_year';

create or replace view public.practice_pricing with (security_invoker = true) as
select g.ods_code, t.tier as price_tier, 'Tier ' || t.tier || ' (' || t.label || ')' as tier_label,
       round(s.list * (1 - t.size_discount), 4) as base_price,
       round(s.list * (1 - t.size_discount - t.speed_discount), 4) as year1_price,
       round(g.total_patients * s.list * 12 * (1 - t.size_discount), 0) as est_arr,
       round(g.total_patients * s.list * 12 * (1 - t.size_discount - t.speed_discount), 0) as est_arr_year1
  from public.gp_practices g
  cross join (select value as list from public.pricing_settings where key = 'list_price_per_patient') s
  left join lateral (select * from public.pricing_tiers pt where pt.route = 'practice' and g.total_patients >= pt.threshold
                      order by pt.threshold desc limit 1) t on true;

-- Network revenue columns: patients x rate x 12 (everything else in these views is unchanged).
do $$
declare v text; def text;
begin
  foreach v in array array['network_summary', 'org_pricing'] loop
    def := pg_get_viewdef(('public.' || v)::regclass, true);
    if position('s.list * 12::numeric' in def) = 0 then
      def := replace(def, 'b.patients::numeric * s.list', 'b.patients::numeric * s.list * 12::numeric');
      execute format('create or replace view public.%I with (security_invoker = true) as %s', v, def);
    end if;
  end loop;
end $$;

-- sync_pricing: allowed keys back to the sheet's monthly price cell.
create or replace function public.sync_pricing(p_settings jsonb, p_tiers jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text; v numeric; t jsonb; n_set int := 0; n_tier int := 0; n int;
  allowed text[] := array['list_price_per_patient','monthly_list_price_per_patient','vat_rate','price_floor_per_patient','term_discount_2yr','term_discount_3yr'];
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  if jsonb_typeof(p_settings) <> 'object' or jsonb_typeof(p_tiers) <> 'array' or jsonb_array_length(p_tiers) > 30 then raise exception 'bad input'; end if;

  for k in select jsonb_object_keys(p_settings) loop
    if not (k = any(allowed)) then raise exception 'unknown setting %', k; end if;
    v := (p_settings ->> k)::numeric;
    if v < 0 or v > 1 then raise exception 'setting % out of range: %', k, v; end if;
    update public.pricing_settings set value = v where key = k and value is distinct from v;
    get diagnostics n = row_count; n_set := n_set + n;
  end loop;

  for t in select * from jsonb_array_elements(p_tiers) loop
    if (t ->> 'route') not in ('practice','pcn','icb') then raise exception 'unknown route %', t ->> 'route'; end if;
    if (t ->> 'size_discount')::numeric not between 0 and 0.6 or (t ->> 'speed_discount')::numeric not between 0 and 0.3
       or (t ->> 'threshold')::bigint < 0 then raise exception 'tier out of range: %', t; end if;
    update public.pricing_tiers set size_discount = (t ->> 'size_discount')::numeric, speed_discount = (t ->> 'speed_discount')::numeric, threshold = (t ->> 'threshold')::bigint
     where route = t ->> 'route' and tier = (t ->> 'tier')::int
       and (size_discount, speed_discount, threshold) is distinct from ((t ->> 'size_discount')::numeric, (t ->> 'speed_discount')::numeric, (t ->> 'threshold')::bigint);
    get diagnostics n = row_count; n_tier := n_tier + n;
  end loop;
  return jsonb_build_object('settings_changed', n_set, 'tiers_changed', n_tier);
end $$;
revoke all on function public.sync_pricing(jsonb, jsonb) from public, anon;
grant execute on function public.sync_pricing(jsonb, jsonb) to authenticated;
