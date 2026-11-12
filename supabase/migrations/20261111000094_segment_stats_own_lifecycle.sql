-- APPLIED 2026-11-12 (via execute_sql). A tracked HubSpot segment is judged by its own lifecycle criteria: a contact whose stage the segment includes (for example Prospecting in ICP | Nov-Jan Sprint) is no longer held back for its stage in that segment's numbers.
create or replace function public.contacts_segment_stats() returns jsonb language sql stable set search_path = '' as $f$
  select coalesce(jsonb_object_agg(list_id, jsonb_build_object('members', members, 'inAtlas', in_atlas, 'eligible', eligible, 'held', held, 'seq', seq, 'unsub', unsub)), '{}'::jsonb) from (
    select m.list_id, count(distinct m.contact_id) as members, count(distinct c.hubspot_contact_id) as in_atlas,
      count(distinct c.hubspot_contact_id) filter (where s.status <> 'excluded' and cardinality(case when g.criteria -> 'lifecycle' ? c.hs_lifecycle then array_remove(s.reasons, 'lifecycle') else s.reasons end) = 0) as eligible,
      count(distinct c.hubspot_contact_id) filter (where s.status <> 'excluded' and cardinality(case when g.criteria -> 'lifecycle' ? c.hs_lifecycle then array_remove(s.reasons, 'lifecycle') else s.reasons end) > 0) as held,
      count(distinct c.hubspot_contact_id) filter (where c.hs_in_sequence) as seq, count(distinct c.hubspot_contact_id) filter (where c.email_opt_out or c.hs_optout_all or c.hs_mkt_optout) as unsub
    from public.hubspot_segment_members m
    join public.hubspot_segments g on g.list_id = m.list_id and g.tracked
    left join public.contacts_full c on c.hubspot_contact_id = m.contact_id
    left join public.contact_status s on s.contact_urn = c.contact_urn
    group by m.list_id) x;
$f$;
