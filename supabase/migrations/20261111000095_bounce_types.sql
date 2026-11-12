-- APPLIED 2026-11-12 (via execute_sql). Bounce types: private.bounce_type() names a contact's bounce (UNKNOWN_USER, OTHER, POLICY, or NO_REASON for a bounce after a send with no reason); the "bounced" suppression rule holds only the types in contact_rules.bounceHold (default all four, so nothing changed: a full recalculation changed 0 rows);
-- a tracked segment accepts more types through criteria.bounces (set with set_segment_bounces; Atlas only, nothing is sent to HubSpot); contacts_segment_stats applies both the segment's lifecycle and bounce criteria.
create or replace function private.bounce_type(p_bounced boolean, p_last_sent timestamptz, p_reason text) returns text language sql immutable set search_path = '' as $f$
  select case when lower(coalesce(p_reason, '')) in ('unknown_user', 'unknown user') then 'UNKNOWN_USER' when lower(coalesce(p_reason, '')) = 'other' then 'OTHER' when lower(coalesce(p_reason, '')) = 'policy' then 'POLICY'
              when coalesce(p_bounced, false) and p_last_sent is not null then 'NO_REASON' end;
$f$;
-- In private.contact_status_calc the bounced condition ((hs_bounced and hs_last_sent) or reason in (...)) became:
--   private.bounce_type(m.hs_bounced, m.hs_last_sent, m.hs_bounce_reason) is not null and coalesce((select r -> 'bounceHold' from cfg) ? private.bounce_type(m.hs_bounced, m.hs_last_sent, m.hs_bounce_reason), true)
create or replace function public.contacts_segment_stats() returns jsonb language sql stable set search_path = '' as $f$
  select coalesce(jsonb_object_agg(list_id, jsonb_build_object('members', members, 'inAtlas', in_atlas, 'eligible', eligible, 'held', held, 'seq', seq, 'unsub', unsub)), '{}'::jsonb) from (
    select m.list_id, count(distinct m.contact_id) as members, count(distinct c.hubspot_contact_id) as in_atlas,
      count(distinct c.hubspot_contact_id) filter (where s.status <> 'excluded' and cardinality(array_remove(array_remove(s.reasons, case when g.criteria -> 'lifecycle' ? c.hs_lifecycle then 'lifecycle' end), case when g.criteria -> 'bounces' ? private.bounce_type(c.hs_bounced, c.hs_last_sent, c.hs_bounce_reason) then 'bounced' end)) = 0) as eligible,
      count(distinct c.hubspot_contact_id) filter (where s.status <> 'excluded' and cardinality(array_remove(array_remove(s.reasons, case when g.criteria -> 'lifecycle' ? c.hs_lifecycle then 'lifecycle' end), case when g.criteria -> 'bounces' ? private.bounce_type(c.hs_bounced, c.hs_last_sent, c.hs_bounce_reason) then 'bounced' end)) > 0) as held,
      count(distinct c.hubspot_contact_id) filter (where c.hs_in_sequence) as seq, count(distinct c.hubspot_contact_id) filter (where c.email_opt_out or c.hs_optout_all or c.hs_mkt_optout) as unsub
    from public.hubspot_segment_members m
    join public.hubspot_segments g on g.list_id = m.list_id and g.tracked
    left join public.contacts_full c on c.hubspot_contact_id = m.contact_id
    left join public.contact_status s on s.contact_urn = c.contact_urn
    group by m.list_id) x;
$f$;
create or replace function public.set_segment_bounces(p_list text, p_types text[]) returns void language plpgsql security definer set search_path = '' as $f$
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  update public.hubspot_segments set criteria = jsonb_set(coalesce(criteria, '{}'::jsonb), '{bounces}', to_jsonb(coalesce(p_types, '{}'::text[]))) where list_id = p_list and tracked;
end $f$;
revoke all on function public.set_segment_bounces(text, text[]) from public, anon;
grant execute on function public.set_segment_bounces(text, text[]) to authenticated;
