-- Final versions of two functions changed after migration 13 / 7. (Apply order: after 15.)
-- 1. load_devolved gains p_create: the Wales cluster file lists branch sites, so it may only update practices already held.
--    The old 3-argument overload is superseded; drop it once convenient:  drop function if exists public.load_devolved(text, text, jsonb);
-- 2. refresh_org_graph only builds nodes and links for ACTIVE practices.

create or replace function public.load_devolved(p_country text, p_month text, p_rows jsonb, p_create boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n_in int; n_new int; n_upd int; refreshed jsonb;
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  if p_country not in ('Wales','Scotland') then raise exception 'country must be Wales or Scotland'; end if;
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
     where upper(btrim(r ->> 'code')) ~ case p_country when 'Wales' then '^W[0-9]{5}$' else '^S[0-9]{5}$' end
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
end $$;
revoke all on function public.load_devolved(text, text, jsonb, boolean) from public, anon;
grant execute on function public.load_devolved(text, text, jsonb, boolean) to authenticated;

create or replace function public.refresh_org_graph() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n_org int; n_rel int;
begin
  insert into public.organisations (kind, source_key, name, ods_code)
  select 'practice', 'ods:' || ods_code, practice_name, ods_code from public.gp_practices where status = 'Active'
  on conflict (source_key) do update set name = excluded.name, updated_at = now();

  insert into public.organisations (kind, source_key, name, ods_code)
  select 'pcn', 'ods:' || pcn_code, max(pcn_name), pcn_code from public.gp_practices
   where pcn_code is not null and status = 'Active' group by pcn_code
  on conflict (source_key) do update set name = excluded.name, updated_at = now();

  insert into public.organisations (kind, source_key, name)
  select 'icb', 'icb:' || lower(icb_name), max(icb_name) from public.gp_practices
   where icb_name <> 'Unallocated ICB' and status = 'Active' group by lower(icb_name)
  on conflict (source_key) do update set name = excluded.name, updated_at = now();

  insert into public.organisations (kind, source_key, name)
  select 'group', 'cqc:provider:' || cqc_provider_id, coalesce(max(group_name), 'Unnamed group') from public.gp_practices
   where group_size > 1 and cqc_provider_id is not null and status = 'Active' group by cqc_provider_id
  on conflict (source_key) do update set name = excluded.name, updated_at = now();

  insert into public.organisations (kind, source_key, name)
  select 'federation', 'fed:' || lower(gp_federation), max(gp_federation) from public.gp_practices
   where gp_federation is not null and status = 'Active' group by lower(gp_federation)
  on conflict (source_key) do update set name = excluded.name, updated_at = now();

  insert into public.org_relationships (from_org, to_org, rel_type, source, confidence, confirmed)
  select p.id, o.id, 'MEMBER_OF_PCN', 'ods', 1, true
    from public.gp_practices g
    join public.organisations p on p.source_key = 'ods:' || g.ods_code
    join public.organisations o on o.source_key = 'ods:' || g.pcn_code
   where g.pcn_code is not null and g.status = 'Active'
  on conflict (from_org, to_org, rel_type) do update set updated_at = now();

  insert into public.org_relationships (from_org, to_org, rel_type, source, confidence, confirmed)
  select p.id, o.id, 'IN_ICB', case when g.pcn_code is not null then 'ods' else 'oscar' end,
         case when g.pcn_code is not null then 1 else 0.7 end, g.pcn_code is not null
    from public.gp_practices g
    join public.organisations p on p.source_key = 'ods:' || g.ods_code
    join public.organisations o on o.source_key = 'icb:' || lower(g.icb_name)
   where g.status = 'Active'
  on conflict (from_org, to_org, rel_type) do update set updated_at = now();

  insert into public.org_relationships (from_org, to_org, rel_type, source, confidence, confirmed)
  select p.id, o.id, 'OPERATED_BY', 'cqc', 1, true
    from public.gp_practices g
    join public.organisations p on p.source_key = 'ods:' || g.ods_code
    join public.organisations o on o.source_key = 'cqc:provider:' || g.cqc_provider_id
   where g.group_size > 1 and g.status = 'Active'
  on conflict (from_org, to_org, rel_type) do update set updated_at = now();

  insert into public.org_relationships (from_org, to_org, rel_type, source, confidence, confirmed)
  select p.id, o.id, 'MEMBER_OF_FEDERATION', 'oscar', 0.7, false
    from public.gp_practices g
    join public.organisations p on p.source_key = 'ods:' || g.ods_code
    join public.organisations o on o.source_key = 'fed:' || lower(g.gp_federation)
   where g.gp_federation is not null and g.status = 'Active'
  on conflict (from_org, to_org, rel_type) do update set updated_at = now();

  perform public.prune_org_links();

  select count(*) into n_org from public.organisations;
  select count(*) into n_rel from public.org_relationships;
  return jsonb_build_object('organisations', n_org, 'relationships', n_rel);
end $$;
