-- APPLIED 2026-11-12 (via execute_sql). The NeverBounce queue is shown 100 rows at a time: contacts_nb_rows(limit, offset) returns a page; contacts_nb_queue now returns only the counts (its rows list is empty).
create or replace function public.contacts_nb_rows(p_limit integer default 100, p_offset integer default 0) returns jsonb language sql stable set search_path = '' as $f$
  select coalesce(jsonb_agg(to_jsonb(y) order by y.k, y.contact_urn), '[]'::jsonb) from (
    select c.*, s.status as st_status, s.section as st_section, s.excluded as st_excluded, s.reasons as st_reasons, s.role_id as st_role, (case c.nb_state when 'pending' then 0 else 1 end) as k
    from public.contacts_full c join public.contact_status s using (contact_urn) where c.nb_state in ('pending', 'approved') order by k, c.contact_urn limit greatest(p_limit, 0) offset greatest(p_offset, 0)) y;
$f$;
revoke all on function public.contacts_nb_rows(integer, integer) from public, anon;
grant execute on function public.contacts_nb_rows(integer, integer) to authenticated;
-- contacts_nb_queue(): the rows subquery's "limit 300" became "limit 0" (counts only).
