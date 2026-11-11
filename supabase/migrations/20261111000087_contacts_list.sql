-- APPLIED 2026-11-11 (via execute_sql). Step 4 of docs/contacts-rethink.md: the default Contacts view is filtered, sorted, counted and paged by the database. Unfiltered first page about 1.6 s; a search about 0.6 s.
create or replace function public.contacts_list(p_f jsonb default '{}'::jsonb, p_limit integer default 100, p_offset integer default 0) returns jsonb
language sql stable set search_path = '' as $f$
  with base as materialized (
    select c.*, s.status as st_status, s.section as st_section, s.excluded as st_excluded, s.reasons as st_reasons, s.role_id as st_role
    from public.contacts_full c
    join public.contact_status s using (contact_urn)
    left join public.gp_practices p on p.ods_code = c.ods_code
    where (nullif(p_f ->> 'section', '') is null or s.section = p_f ->> 'section')
      and (nullif(p_f ->> 'status', '') is null or s.status = p_f ->> 'status')
      and (nullif(p_f ->> 'role', '') is null or s.role_id = p_f ->> 'role')
      and (nullif(p_f ->> 'source', '') is null or coalesce(c.source, 'oscar') = p_f ->> 'source')
      and (nullif(p_f ->> 'reason', '') is null or (p_f ->> 'reason') = any(s.reasons))
      and (nullif(p_f ->> 'lifecycle', '') is null or c.hs_lifecycle = p_f ->> 'lifecycle')
      and (nullif(btrim(coalesce(p_f ->> 'q', '')), '') is null or concat_ws(' ', c.first_name, c.last_name, c.full_name, c.email, c.job_title, c.title, c.ods_code, p.practice_name, p.postcode) ilike '%' || replace(replace(btrim(p_f ->> 'q'), '%', '\%'), '_', '\_') || '%'))
  select jsonb_build_object(
    'total', (select count(*) from base),
    'eligible', (select count(*) from base where st_status = 'eligible'),
    'rows', coalesce((select jsonb_agg(to_jsonb(x) order by x.k, x.contact_urn)
      from (select b.*, (case b.st_status when 'eligible' then 0 when 'suppressed' then 1 else 2 end + case when b.st_section = 'main' then 0 else 0.5 end) as k from base b order by k, b.contact_urn limit greatest(p_limit, 0) offset greatest(p_offset, 0)) x), '[]'::jsonb));
$f$;
revoke all on function public.contacts_list(jsonb, integer, integer) from public, anon;
grant execute on function public.contacts_list(jsonb, integer, integer) to authenticated;

create or replace function public.contacts_counts() returns jsonb language sql stable set search_path = '' as $f$
  select jsonb_build_object('total', count(*), 'eligible', count(*) filter (where status = 'eligible'), 'main', count(*) filter (where status = 'eligible' and section = 'main'),
    'other', count(*) filter (where status = 'eligible' and section = 'other'), 'suppressed', count(*) filter (where status = 'suppressed'), 'excluded', count(*) filter (where status = 'excluded'))
  from public.contact_status;
$f$;
revoke all on function public.contacts_counts() from public, anon;
grant execute on function public.contacts_counts() to authenticated;
