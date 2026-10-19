-- "SAR only" product: cheaper list prices (annual 0.05, monthly 0.06 per patient per month). Discounts (size, term, speed) apply to annual plans only;
-- there is no price floor for SAR only. The dashboard calculates the profile card itself; these columns give the SAR-only baseline
-- (annual plan, 1-year term, size discount only) next to the All-reports ones.
insert into public.pricing_settings (key, value, description) values
 ('list_price_sar_per_patient', 0.05, 'SAR-only annual-plan list price per patient per month (GBP excl. VAT)'),
 ('monthly_list_price_sar_per_patient', 0.06, 'SAR-only monthly-plan list price per patient per month (GBP excl. VAT)')
on conflict (key) do update set value = excluded.value, description = excluded.description;

create or replace view public.practice_pricing with (security_invoker = true) as
select g.ods_code, t.tier as price_tier, 'Tier ' || t.tier || ' (' || t.label || ')' as tier_label,
       round(s.list * (1 - t.size_discount), 4) as base_price,
       round(s.list * (1 - t.size_discount - t.speed_discount), 4) as year1_price,
       round(g.total_patients * s.list * 12 * (1 - t.size_discount), 0) as est_arr,
       round(g.total_patients * s.list * 12 * (1 - t.size_discount - t.speed_discount), 0) as est_arr_year1,
       round(sar.list * (1 - t.size_discount), 4) as base_price_sar,
       round(g.total_patients * sar.list * 12 * (1 - t.size_discount), 0) as est_arr_sar
  from public.gp_practices g
  cross join (select value as list from public.pricing_settings where key = 'list_price_per_patient') s
  cross join (select value as list from public.pricing_settings where key = 'list_price_sar_per_patient') sar
  left join lateral (select * from public.pricing_tiers pt where pt.route = 'practice' and g.total_patients >= pt.threshold
                      order by pt.threshold desc limit 1) t on true;

-- Network views: append SAR-only columns (arr_single_sar, arr_network_sar and, for network_summary, arr_customers_sar).
do $$
declare v text; def text; sar text := '(select value from public.pricing_settings where key = ''list_price_sar_per_patient'')';
begin
  foreach v in array array['network_summary', 'org_pricing'] loop
    def := pg_get_viewdef(('public.' || v)::regclass, true);
    if position('arr_network_sar' in def) = 0 then
      if position('COALESCE(sum(pp.est_arr), 0::numeric) AS arr_single,' in def) = 0 or position('AS arr_network_year1' in def) = 0 then raise exception 'unexpected definition of %', v; end if;
      def := replace(def, 'COALESCE(sum(pp.est_arr), 0::numeric) AS arr_single,', 'COALESCE(sum(pp.est_arr), 0::numeric) AS arr_single, COALESCE(sum(pp.est_arr_sar), 0::numeric) AS arr_single_sar,');
      if v = 'network_summary' then
        def := replace(def, 'AS arr_customers,', 'AS arr_customers, COALESCE(sum(pp.est_arr_sar) FILTER (WHERE p.hubspot_customer), 0::numeric) AS arr_customers_sar,');
        def := replace(def, 'AS arr_network_year1', 'AS arr_network_year1, b.arr_single_sar, b.arr_customers_sar, round(b.patients::numeric * ' || sar || ' * 12::numeric * (1::numeric - t.size_discount), 0) AS arr_network_sar');
      else
        def := replace(def, 'AS arr_network_year1', 'AS arr_network_year1, b.arr_single_sar, round(b.patients::numeric * ' || sar || ' * 12::numeric * (1::numeric - t.size_discount), 0) AS arr_network_sar');
      end if;
      execute format('create or replace view public.%I with (security_invoker = true) as %s', v, def);
    end if;
  end loop;
end $$;

-- sync_pricing: the two SAR prices can be updated from the spreadsheet too.
create or replace function public.sync_pricing(p_settings jsonb, p_tiers jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text; v numeric; t jsonb; n_set int := 0; n_tier int := 0; n int;
  allowed text[] := array['list_price_per_patient','monthly_list_price_per_patient','list_price_sar_per_patient','monthly_list_price_sar_per_patient','vat_rate','price_floor_per_patient','term_discount_2yr','term_discount_3yr'];
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
comment on function public.sync_pricing(jsonb, jsonb) is 'SECURITY DEFINER by design: allowlist-checked inside; anon cannot run it. Advisor warning 0029 is expected.';
