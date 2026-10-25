-- Northern Ireland (ODS Z codes, role RO315) and the Isle of Man (ODS Y codes): same shape as Scotland and Wales.
-- load_devolved (browser uploads of list sizes) now accepts both; ingest_other_uk is the daily ODS refresh, callable by the pipeline's service role only.
create or replace function public.load_devolved(p_country text, p_month text, p_rows jsonb, p_create boolean)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  n_in int; n_new int; n_upd int; refreshed jsonb;
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  if p_country not in ('Wales','Scotland','Northern Ireland','Isle of Man') then raise exception 'country must be Wales, Scotland, Northern Ireland or Isle of Man'; end if;
  if p_month !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'month must look like 2026-07'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'send at most 2000 rows per call'; end if;
  perform set_config('lalu.bulk_load', '1', true);

  with src as (
    select distinct on (upper(btrim(r ->> 'code')))
           upper(btrim(r ->> 'code')) as code, nullif(btrim(r ->> 'name'), '') as name, nullif(btrim(r ->> 'postcode'), '') as postcode,
           nullif(btrim(r ->> 'town'), '') as town,
           case when (r ->> 'patients') ~ '^[0-9]{1,7}$' then (r ->> 'patients')::int end as patients,
           nullif(btrim(r ->> 'net_code'), '') as net_code, nullif(btrim(r ->> 'net_name'), '') as net_name,
           nullif(btrim(r ->> 'icb'), '') as icb
      from jsonb_array_elements(p_rows) r
     where upper(btrim(r ->> 'code')) ~ case p_country when 'Wales' then '^W[0-9]{5}$' when 'Northern Ireland' then '^Z[0-9]{5}$' when 'Isle of Man' then '^Y[0-9]{5}$' else '^S[0-9]{5}$' end
       and nullif(btrim(r ->> 'name'), '') is not null
       and (p_create or exists (select 1 from public.gp_practices x where x.ods_code = upper(btrim(r ->> 'code'))))
     order by upper(btrim(r ->> 'code'))
  ), up as (
    insert into public.gp_practices as g (ods_code, practice_name, postcode, town, total_patients, status, data_month, country,
                                          pcn_code, pcn_name, icb_name, network_locked)
    select code, name, postcode, town, coalesce(patients, 0), 'Active', case when patients is not null then p_month end, p_country,
           net_code, coalesce(net_name, 'Unallocated PCN'), coalesce(icb, 'Unallocated ICB'), net_code is not null
      from src
    on conflict (ods_code) do update set
      practice_name  = case when g.country = 'Scotland' then excluded.practice_name else g.practice_name end,
      postcode       = coalesce(excluded.postcode, g.postcode),
      town           = coalesce(g.town, excluded.town),
      total_patients = coalesce(nullif(excluded.total_patients, 0), g.total_patients),
      data_month     = case when excluded.total_patients > 0 then excluded.data_month else g.data_month end,
      status         = 'Active',
      pcn_code       = coalesce(excluded.pcn_code, g.pcn_code),
      pcn_name       = case when excluded.pcn_code is not null then excluded.pcn_name else g.pcn_name end,
      icb_name       = case when excluded.icb_name <> 'Unallocated ICB' then excluded.icb_name else g.icb_name end,
      network_locked = g.network_locked or excluded.network_locked
     where g.country = p_country
    returning (xmax = 0) as inserted)
  select count(*), count(*) filter (where inserted), count(*) filter (where not inserted) into n_in, n_new, n_upd from up;

  refreshed := public.refresh_org_graph();
  return jsonb_build_object('stored', n_in, 'new', n_new, 'updated', n_upd, 'graph', refreshed);
end $function$;

create or replace function public.ingest_other_uk(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare n_in int; n_new int;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'send at most 2000 rows per call'; end if;
  perform set_config('lalu.bulk_load', '1', true);
  with src as (
    select distinct on (upper(btrim(r ->> 'code')))
           upper(btrim(r ->> 'code')) as code, nullif(btrim(r ->> 'name'), '') as name, nullif(btrim(r ->> 'postcode'), '') as postcode,
           nullif(btrim(r ->> 'address'), '') as address, nullif(btrim(r ->> 'town'), '') as town, nullif(btrim(r ->> 'county'), '') as county, r ->> 'country' as country
      from jsonb_array_elements(p_rows) r
     where r ->> 'country' in ('Northern Ireland', 'Isle of Man')
       and upper(btrim(r ->> 'code')) ~ case r ->> 'country' when 'Northern Ireland' then '^Z[0-9]{5}$' else '^Y[0-9]{5}$' end
       and nullif(btrim(r ->> 'name'), '') is not null
     order by upper(btrim(r ->> 'code'))
  ), up as (
    insert into public.gp_practices as g (ods_code, practice_name, postcode, address, town, county, country, status, total_patients, pcn_name, icb_name)
    select code, name, postcode, address, town, county, country, 'Active', 0, 'Unallocated PCN', country from src
    on conflict (ods_code) do update set
      practice_name = excluded.practice_name, postcode = coalesce(excluded.postcode, g.postcode), address = coalesce(excluded.address, g.address),
      town = coalesce(excluded.town, g.town), county = coalesce(excluded.county, g.county), status = 'Active'
     where g.country = excluded.country
    returning (xmax = 0) as inserted)
  select count(*), count(*) filter (where inserted) into n_in, n_new from up;
  return jsonb_build_object('stored', n_in, 'new', n_new, 'graph', public.refresh_org_graph());
end $function$;
revoke all on function public.ingest_other_uk(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_other_uk(jsonb) to service_role;

alter table public.gp_practices drop constraint if exists gp_practices_country_check;
alter table public.gp_practices add constraint gp_practices_country_check check (country in ('England', 'Wales', 'Scotland', 'Northern Ireland', 'Isle of Man'));
