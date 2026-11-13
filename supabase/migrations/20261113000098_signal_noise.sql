-- APPLIED 2026-11-13. 345 + 883 bulk-load manager-turnover signals and 5 re-registrations were dismissed (not deleted).
-- Fewer, truer signals.
-- 1. A CQC re-registration under the same operator name is not a signal (it is a partnership change or restructure, not a takeover).
-- 2. Manager turnover is a circuit breaker: bulk contact loads write through the API so they cannot set lalu.bulk_load; when 40 or more turnover signals
--    were raised in the last 2 hours it is a load, not turnover (normal is about 10 a day), so no more are raised.
do $mig$
declare d text;
begin
  select pg_get_functiondef('public.log_sales_triggers()'::regprocedure) into d;
  if position('if same_op then return null; end if;' in d) = 0 then
    d := replace(d, $a$    same_op := prov_new is not null and lower(prov_new) = lower(coalesce(prov_old, ''));$a$, $a$    same_op := prov_new is not null and lower(prov_new) = lower(coalesce(prov_old, ''));
    if same_op then return null; end if;$a$);
  end if;
  if position('detected_at > now() - interval ''2 hours''' in d) = 0 then
    d := replace(d, $a$     and old.manager_source is not distinct from new.manager_source$a$, $a$     and old.manager_source is not distinct from new.manager_source
     and (select count(*) from public.sales_triggers where trigger_type = 'MANAGER_TURNOVER' and detected_at > now() - interval '2 hours') < 40$a$);
  end if;
  execute d;
end $mig$;

update public.sales_triggers set status = 'dismissed'
 where trigger_type = 'CQC_PROVIDER_CHANGE' and headline like '%: new CQC provider record' and coalesce(status, 'new') = 'new';
