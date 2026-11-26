-- Two more rules that hold a contact back from campaigns (both on by default, switchable in Contacts > Settings like the others), matching HubSpot's "Campaign Exclusion List":
--   disqualified: the contact has a lead that was disqualified (hs_dq_reason, from the sync);   closed_lost: the contact's latest deal was closed lost and none is still open (hs_lost_reason).
-- The Re-engagement view exists to work these very people, so it does not hold them back (like it already does for the lifecycle rule).
-- The three functions are patched in place from their live definitions, so nothing else in them can drift.
do $m$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'contact_status_calc';
  if d not like '%closed_lost%' then
    d := replace(d, $a$case when coalesce((select r -> 'suppression' ->> 'neverbounce' from cfg)$a$,
      $b$case when coalesce((select r -> 'suppression' ->> 'disqualified' from cfg), 'true') = 'true' and nullif(m.hs_dq_reason, '') is not null then 'disqualified' end,
      case when coalesce((select r -> 'suppression' ->> 'closed_lost' from cfg), 'true') = 'true' and nullif(m.hs_lost_reason, '') is not null then 'closed_lost' end,
      case when coalesce((select r -> 'suppression' ->> 'neverbounce' from cfg)$b$);
    execute d;
  end if;
  for d in select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('contacts_query', 'contacts_page') loop
    if d not like '%closed_lost%' then
      execute replace(d, $a$array_remove(s.reasons, 'lifecycle')$a$, $b$array_remove(array_remove(array_remove(s.reasons, 'lifecycle'), 'disqualified'), 'closed_lost')$b$);
    end if;
  end loop;
end
$m$;
