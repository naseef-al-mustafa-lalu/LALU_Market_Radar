-- APPLIED 2026-11-12 (via execute_sql). Each Contacts tab asks for its own small summary instead of every contact:
-- contacts_settings_stats (role and rule counts, job titles with counts, disqualification and lost-deal counts), contacts_nb_queue (NeverBounce queue), contacts_review (Review counts and one tab's rows),
-- contacts_segment_stats (tracked HubSpot segments). Selection: contacts_query also accepts an "exclude" list of urns.
create or replace function public.contacts_settings_stats() returns jsonb language sql stable set search_path = '' as $f$
  select jsonb_build_object(
    'roles', coalesce((select jsonb_object_agg(role_id, n) from (select role_id, count(*) n from public.contact_status group by 1) x), '{}'::jsonb),
    'dq', coalesce((select jsonb_object_agg(k, n) from (select hs_dq_reason as k, count(*) n from public.contact_hubspot where nullif(hs_dq_reason, '') is not null group by 1) x), '{}'::jsonb),
    'lost', coalesce((select jsonb_object_agg(k, n) from (select hs_lost_reason as k, count(*) n from public.contact_hubspot where nullif(hs_lost_reason, '') is not null group by 1) x), '{}'::jsonb),
    'held', coalesce((select jsonb_object_agg(r, n) from (select r, count(*) n from public.contact_status s, unnest(s.reasons) r group by r) x), '{}'::jsonb),
    'titles', coalesce((select jsonb_agg(jsonb_build_object('t', t, 'n', n, 'role', role) order by n desc, t)
      from (select min(btrim(coalesce(nullif(c.job_title, ''), c.title))) as t, count(*) as n, min(s.role_id) as role
            from public.contacts c join public.contact_status s using (contact_urn)
            where nullif(btrim(coalesce(nullif(c.job_title, ''), c.title, '')), '') is not null
            group by lower(btrim(coalesce(nullif(c.job_title, ''), c.title)))) x), '[]'::jsonb));
$f$;
revoke all on function public.contacts_settings_stats() from public, anon;
grant execute on function public.contacts_settings_stats() to authenticated;

create or replace function public.contacts_nb_queue() returns jsonb language sql stable set search_path = '' as $f$
  select jsonb_build_object(
    'pending', (select count(*) from public.contact_nb where nb_state = 'pending'),
    'approved', (select count(*) from public.contact_nb where nb_state = 'approved'),
    'checked', (select count(*) from public.contact_nb where nb_state = 'checked'),
    'by_result', coalesce((select jsonb_object_agg(coalesce(nb_result, '?'), n) from (select nb_result, count(*) n from public.contact_nb where nb_state = 'checked' group by 1) x), '{}'::jsonb),
    'rows', coalesce((select jsonb_agg(to_jsonb(y) order by y.k, y.contact_urn) from (
      select c.*, s.status as st_status, s.section as st_section, s.excluded as st_excluded, s.reasons as st_reasons, s.role_id as st_role, (case c.nb_state when 'pending' then 0 else 1 end) as k
      from public.contacts_full c join public.contact_status s using (contact_urn) where c.nb_state in ('pending', 'approved') order by k, c.contact_urn limit 300) y), '[]'::jsonb));
$f$;
revoke all on function public.contacts_nb_queue() from public, anon;
grant execute on function public.contacts_nb_queue() to authenticated;

create or replace function public.contacts_review(p_tab text default 'partial', p_source text default '', p_limit integer default 25, p_offset integer default 0) returns jsonb language sql stable set search_path = '' as $f$
  with rules as materialized (select coalesce((select value from public.app_flags where key = 'contact_rules'), '{}'::jsonb) as r),
  e as materialized (
    select c.*, s.status as st_status, s.section as st_section, s.excluded as st_excluded, s.reasons as st_reasons, s.role_id as st_role,
      case when s.excluded like 'address only partly%' then 'partial' when s.excluded like 'address does not clearly%' then 'unclear'
           when c.held_reason is not null and c.held_reason <> 'rejected in review' and c.held_reason !~ '^shared' and s.status = 'excluded' then 'held' end as bucket,
      (nullif(p_source, '') is null or coalesce(c.source, 'oscar') = p_source) as src_ok
    from public.contacts_full c join public.contact_status s using (contact_urn)
    where s.status = 'excluded' or (s.status = 'eligible' and s.role_id = 'other')),
  t as materialized (
    select btrim(coalesce(nullif(job_title, ''), title)) as t, count(*) as n from e
    where st_status = 'eligible' and st_role = 'other' and nullif(btrim(coalesce(nullif(job_title, ''), title, '')), '') is not null
      and coalesce((select r -> 'titleModes' ->> lower(btrim(coalesce(nullif(job_title, ''), title))) from rules), '') not in ('main', 'other', 'off')
    group by 1)
  select jsonb_build_object(
    'counts', jsonb_build_object('partial', (select count(*) from e where bucket = 'partial' and src_ok), 'unclear', (select count(*) from e where bucket = 'unclear' and src_ok),
      'held', (select count(*) from e where bucket = 'held' and src_ok), 'titles', (select count(*) from t)),
    'rows', case when p_tab in ('partial', 'unclear', 'held') then coalesce((select jsonb_agg(to_jsonb(x) order by x.contact_urn) from (select * from e where bucket = p_tab and src_ok order by contact_urn limit greatest(p_limit, 0) offset greatest(p_offset, 0)) x), '[]'::jsonb) else '[]'::jsonb end,
    'titles', case when p_tab = 'titles' then coalesce((select jsonb_agg(jsonb_build_object('t', t, 'n', n) order by n desc, t) from (select * from t order by n desc, t limit greatest(p_limit, 0) offset greatest(p_offset, 0)) y), '[]'::jsonb) else '[]'::jsonb end);
$f$;
revoke all on function public.contacts_review(text, text, integer, integer) from public, anon;
grant execute on function public.contacts_review(text, text, integer, integer) to authenticated;

create or replace function public.contacts_segment_stats() returns jsonb language sql stable set search_path = '' as $f$
  select coalesce(jsonb_object_agg(list_id, jsonb_build_object('members', members, 'inAtlas', in_atlas, 'eligible', eligible, 'held', held, 'seq', seq, 'unsub', unsub)), '{}'::jsonb) from (
    select m.list_id, count(distinct m.contact_id) as members, count(distinct c.hubspot_contact_id) as in_atlas,
      count(distinct c.hubspot_contact_id) filter (where s.status = 'eligible') as eligible, count(distinct c.hubspot_contact_id) filter (where s.status = 'suppressed') as held,
      count(distinct c.hubspot_contact_id) filter (where c.hs_in_sequence) as seq, count(distinct c.hubspot_contact_id) filter (where c.email_opt_out or c.hs_optout_all or c.hs_mkt_optout) as unsub
    from public.hubspot_segment_members m
    join public.hubspot_segments g on g.list_id = m.list_id and g.tracked
    left join public.contacts_full c on c.hubspot_contact_id = m.contact_id
    left join public.contact_status s on s.contact_urn = c.contact_urn
    group by m.list_id) x;
$f$;
revoke all on function public.contacts_segment_stats() from public, anon;
grant execute on function public.contacts_segment_stats() to authenticated;
