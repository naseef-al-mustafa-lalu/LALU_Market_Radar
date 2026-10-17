-- Lets the Data > Pricing tab apply rates read from the pricing spreadsheet (CSV export).
-- Only known setting keys and existing (route, tier) rows are updated; nothing is created or deleted.
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
comment on function public.sync_pricing(jsonb, jsonb) is 'SECURITY DEFINER by design: allowlist-checked inside; anon cannot run it. Advisor warning 0029 is expected.';
