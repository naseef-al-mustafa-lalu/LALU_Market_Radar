-- New practice manager signals fired for 1,251 practices in two weeks: most were the primary contact switching between HubSpot-chosen and Oscar-chosen when Oscar was connected, or a
-- re-ranking among a practice's own contacts. A signal now needs the same source on both sides, a practice / business / general / operations manager title, and a different surname.
do $mig$
declare d text;
begin
  select pg_get_functiondef('public.log_sales_triggers()'::regprocedure) into d;
  d := replace(d, 'and lower(old.manager_name) <> lower(new.manager_name) then',
    $r$and lower(old.manager_name) <> lower(new.manager_name)
     and old.manager_source is not distinct from new.manager_source
     and coalesce(new.manager_title, '') ~* 'practice\s*(/\s*business\s*)?manager|business\s*manager|general\s*manager|operations?\s*manager'
     and lower(regexp_replace(old.manager_name, '^.*\s', '')) <> lower(regexp_replace(new.manager_name, '^.*\s', '')) then$r$);
  execute d;
end $mig$;
