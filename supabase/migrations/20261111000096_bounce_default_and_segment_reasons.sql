-- APPLIED 2026-11-12 (via execute_sql). 1) The default for which bounces hold a contact back is now UNKNOWN_USER and OTHER only (HubSpot keeps emailing policy and soft bounces); a saved contact_rules.bounceHold overrides it. In private.contact_status_calc the default after the bounceHold lookup is
--    private.bounce_type(m.hs_bounced, m.hs_last_sent, m.hs_bounce_reason) in ('UNKNOWN_USER', 'OTHER')
-- 2) contacts_segment_stats also returns, per tracked segment, how many held-back members there are for each reason ('reasons'), after applying the segment's own lifecycle and bounce criteria.
create or replace function public.contacts_segment_stats() returns jsonb language sql stable set search_path = '' as $f$
  with mm as (
    select m.list_id, m.contact_id, c.hubspot_contact_id as hid, s.status, c.hs_in_sequence as seq, (c.email_opt_out or c.hs_optout_all or c.hs_mkt_optout) as unsub,
      array_remove(array_remove(s.reasons, case when g.criteria -> 'lifecycle' ? c.hs_lifecycle then 'lifecycle' end), case when g.criteria -> 'bounces' ? private.bounce_type(c.hs_bounced, c.hs_last_sent, c.hs_bounce_reason) then 'bounced' end) as eff
    from public.hubspot_segment_members m
    join public.hubspot_segments g on g.list_id = m.list_id and g.tracked
    left join public.contacts_full c on c.hubspot_contact_id = m.contact_id
    left join public.contact_status s on s.contact_urn = c.contact_urn)
  select coalesce(jsonb_object_agg(x.list_id, jsonb_build_object('members', x.members, 'inAtlas', x.in_atlas, 'eligible', x.eligible, 'held', x.held, 'seq', x.seq, 'unsub', x.unsub,
    'reasons', coalesce((select jsonb_object_agg(q.r, q.n) from (select r, count(distinct m2.hid) as n from mm m2, unnest(m2.eff) r where m2.list_id = x.list_id and m2.status <> 'excluded' group by r) q), '{}'::jsonb))), '{}'::jsonb)
  from (select list_id, count(distinct contact_id) as members, count(distinct hid) as in_atlas,
      count(distinct hid) filter (where status <> 'excluded' and cardinality(eff) = 0) as eligible, count(distinct hid) filter (where status <> 'excluded' and cardinality(eff) > 0) as held,
      count(distinct hid) filter (where seq) as seq, count(distinct hid) filter (where unsub) as unsub from mm group by list_id) x;
$f$;
