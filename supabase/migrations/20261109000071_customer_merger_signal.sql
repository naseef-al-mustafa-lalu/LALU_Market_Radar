-- A customer (ReportSure or Freemium) that merges with another practice is its own signal: the contract, list size and pricing need a decision. Engaged-only mergers keep MERGER_DETECTED.
alter table public.sales_triggers drop constraint if exists sales_triggers_trigger_type_check;
alter table public.sales_triggers add constraint sales_triggers_trigger_type_check check (trigger_type = any (array['MERGER_DETECTED','MANAGER_TURNOVER','RAPID_GROWTH','NEW_PRACTICE','PCN_CHANGE','CQC_DEREGISTERED','CQC_RATING_CHANGE','CQC_INSPECTION','CQC_MANAGER_ABSENT','CQC_PROVIDER_CHANGE','JOB_REPORT_ROLE','PRACTICE_CLOSED','CUSTOMER_MERGER']));
insert into public.signal_settings (trigger_type, label, source, rule, why, sort_order, enabled)
select 'CUSTOMER_MERGER', 'Customer merger', 'Atlas (a merger you confirm)', 'A paying or Freemium customer is recorded as merged with another practice',
       'The surviving practice may need re-signing at the verified combined list size, and a signed agreement may already cover it.', coalesce(max(sort_order), 0) + 1, true
from public.signal_settings on conflict (trigger_type) do nothing;
do $mig$
declare d text;
begin
  select pg_get_functiondef('public.set_practice_merge(text,text,text)'::regprocedure) into d;
  d := replace(d, '  if involved then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (p_into, ''MERGER_DETECTED'',', '  if coalesce(a.hubspot_customer, false) or coalesce(b.hubspot_customer, false) then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (p_into, ''CUSTOMER_MERGER'', ''Customer merger: '' || a.practice_name || '' and '' || b.practice_name,
            a.practice_name || '' ('' || a.ods_code || '') has merged into '' || b.practice_name || '' ('' || b.ods_code || ''); '' || case when coalesce(a.hubspot_customer, false) and coalesce(b.hubspot_customer, false) then ''both are customers'' when coalesce(a.hubspot_customer, false) then a.practice_name || '' is a customer'' else b.practice_name || '' is a customer'' end || ''. Combined list now '' || coalesce(b.total_patients, 0) || '' patients at the surviving practice.'',
            ''Check which signed agreement covers the combined population, re-sign the surviving practice at its verified list size if needed, avoid counting patients twice, and review churn or freemium services of the absorbed practice.'');
  elsif involved then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (p_into, ''MERGER_DETECTED'',');
  execute d;
end $mig$;
