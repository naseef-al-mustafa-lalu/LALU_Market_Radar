-- City filter for the Contacts tab: a contact's city is its practice's town (gp_practices.town), matched exactly but ignoring case. Contacts with no practice have none.
create or replace function public.contacts_query(p_f jsonb default '{}'::jsonb, p_mode text default 'standard'::text, p_what text default 'rows'::text, p_limit integer default 100, p_offset integer default 0)
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
  with rules as materialized (select coalesce((select value from public.app_flags where key = 'contact_rules'), '{}'::jsonb) as r),
  cand as materialized (
    select c.*, p.practice_name as p_name, p.postcode as p_post, p.country as p_country, p.town as p_town,
      s.section as st_section, s.excluded as st_excluded, s.role_id as st_role,
      case when p_mode = 'reengage' then array_remove(s.reasons, 'lifecycle') else s.reasons end as st_reasons,
      case when p_mode = 'reengage' and s.status = 'suppressed' and cardinality(array_remove(s.reasons, 'lifecycle')) = 0 then 'eligible' else s.status end as st_status
    from public.contacts_full c
    join public.contact_status s using (contact_urn)
    left join public.gp_practices p on p.ods_code = c.ods_code
    where p_mode <> 'reengage' or (
      (((nullif(c.hs_dq_reason, '') is not null and private.ct_dq_on((select r from rules), c.hs_dq_reason)) or (nullif(c.hs_lost_reason, '') is not null and private.ct_dq_on((select r from rules), 'lost:' || c.hs_lost_reason)))
       and not coalesce(p.hubspot_customer, false)))),
  base as materialized (
    select * from cand
    where (nullif(p_f ->> 'section', '') is null or st_section = p_f ->> 'section')
      and (nullif(p_f ->> 'status', '') is null or st_status = p_f ->> 'status')
      and (nullif(p_f ->> 'role', '') is null or st_role = p_f ->> 'role')
      and (nullif(p_f ->> 'country', '') is null or p_country = p_f ->> 'country')
      and (nullif(btrim(coalesce(p_f ->> 'city', '')), '') is null or lower(btrim(p_town)) = lower(btrim(p_f ->> 'city')))
      and (nullif(p_f ->> 'source', '') is null or coalesce(source, 'oscar') = p_f ->> 'source')
      and (nullif(p_f ->> 'reason', '') is null or (p_f ->> 'reason') = any(st_reasons))
      and (nullif(p_f ->> 'lifecycle', '') is null or hs_lifecycle = p_f ->> 'lifecycle')
      and (nullif(p_f ->> 'dq', '') is null or (case when p_f ->> 'dq' = 'any' then (nullif(hs_dq_reason, '') is not null or nullif(hs_lost_reason, '') is not null)
           else (hs_dq_reason = p_f ->> 'dq' or hs_lost_reason = p_f ->> 'dq' or 'lost:' || hs_lost_reason = p_f ->> 'dq') end))
      and (p_f -> 'exclude' is null or contact_urn not in (select jsonb_array_elements_text(p_f -> 'exclude')::bigint))
      and (p_f -> 'urns' is null or contact_urn in (select jsonb_array_elements_text(p_f -> 'urns')::bigint))
      and (nullif(btrim(coalesce(p_f ->> 'q', '')), '') is null or concat_ws(' ', first_name, last_name, full_name, email, job_title, title, ods_code, p_name, p_post) ilike '%' || replace(replace(btrim(p_f ->> 'q'), '%', '\%'), '_', '\_') || '%'))
  select jsonb_build_object(
    'total', (select count(*) from base),
    'eligible', (select count(*) from base where st_status = 'eligible'),
    'suppressed', (select count(*) from base where st_status = 'suppressed'),
    'due', (select count(*) from base where hs_reengage_date is not null and hs_reengage_date <= current_date),
    'reasons', case when p_mode = 'reengage' then coalesce((select jsonb_agg(distinct v) from (select unnest(array[nullif(hs_dq_reason, ''), nullif(hs_lost_reason, '')]) v from cand) z where v is not null), '[]'::jsonb) else '[]'::jsonb end,
    'urns', case when p_what = 'ids' then coalesce((select jsonb_agg(contact_urn order by contact_urn) from base), '[]'::jsonb) else '[]'::jsonb end,
    'hubspot_ids', case when p_what = 'ids' then coalesce((select jsonb_agg(distinct hubspot_contact_id) from base where st_status = 'eligible' and hubspot_contact_id is not null), '[]'::jsonb) else '[]'::jsonb end,
    'ods', case when p_what = 'ids' then coalesce((select jsonb_agg(distinct ods_code) from base where st_status = 'eligible' and hubspot_contact_id is not null and ods_code is not null), '[]'::jsonb) else '[]'::jsonb end,
    'rows', case when p_what = 'rows' then coalesce((select jsonb_agg(to_jsonb(x) order by x.k, x.contact_urn)
      from (select b.*, (case when p_mode = 'reengage' then (case when b.hs_reengage_date is not null and b.hs_reengage_date <= current_date then -2 else -1 end) else 0 end
        + case b.st_status when 'eligible' then 0 when 'suppressed' then 1 else 2 end + case when b.st_section = 'main' then 0 else 0.5 end) as k
        from base b order by k, b.contact_urn limit least(greatest(p_limit, 0), case when private.can_download() then 100000 else 2000 end) offset greatest(p_offset, 0)) x), '[]'::jsonb) else '[]'::jsonb end);
$function$;
