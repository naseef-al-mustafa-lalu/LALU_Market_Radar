-- APPLIED 2026-11-13 (run through execute_sql in parts). One signal for a customer merger or closure, a new CQC registration signal; src/cqc.py reads registrationDate.
-- One signal for a customer that merges or closes (replaces CUSTOMER_MERGER), and a new signal for a practice newly registered with CQC.
alter table public.gp_practices add column if not exists cqc_registered_date date;

alter table public.sales_triggers drop constraint if exists sales_triggers_trigger_type_check;
update public.sales_triggers set trigger_type = 'CUSTOMER_MERGER_CLOSURE' where trigger_type = 'CUSTOMER_MERGER';
alter table public.sales_triggers add constraint sales_triggers_trigger_type_check check (trigger_type = any (array['MERGER_DETECTED','MANAGER_TURNOVER','RAPID_GROWTH','NEW_PRACTICE','PCN_CHANGE','CQC_DEREGISTERED','CQC_RATING_CHANGE','CQC_INSPECTION','CQC_MANAGER_ABSENT','CQC_PROVIDER_CHANGE','JOB_REPORT_ROLE','PRACTICE_CLOSED','CUSTOMER_MERGER_CLOSURE','CQC_NEW_REGISTRATION']));

update public.audiences set signal_type = 'CUSTOMER_MERGER_CLOSURE' where signal_type = 'CUSTOMER_MERGER';
delete from public.signal_settings where trigger_type = 'CUSTOMER_MERGER';
insert into public.signal_settings (trigger_type, label, source, rule, why, sort_order, enabled)
select 'CUSTOMER_MERGER_CLOSURE', 'Customer merger or closure', 'Atlas (a merger you confirm) + NHS directory / a closure you confirm',
       'A paying or Freemium customer is recorded as merged with another practice, or closes',
       'A merged customer may need re-signing at the combined list size; a closed one is a churn risk and its patients move elsewhere.', coalesce(max(sort_order), 0) + 1, true
from public.signal_settings on conflict (trigger_type) do nothing;
insert into public.signal_settings (trigger_type, label, source, rule, why, sort_order, enabled)
select 'CQC_NEW_REGISTRATION', 'New CQC registration', 'CQC register',
       'A practice we hold shows a CQC registration date in the last 90 days',
       'A newly registered practice or provider is setting up its systems and suppliers.', coalesce(max(sort_order), 0) + 1, true
from public.signal_settings on conflict (trigger_type) do nothing;

do $mig$
declare d text;
begin
  -- merger path: same signal, new name
  select pg_get_functiondef('public.set_practice_merge(text,text,text)'::regprocedure) into d;
  d := replace(d, $a$'CUSTOMER_MERGER'$a$, $a$'CUSTOMER_MERGER_CLOSURE'$a$);
  execute d;

  -- confirmed closure path: a customer's closure also raises the combined signal
  select pg_get_functiondef('public.set_practice_closed(text,boolean,text)'::regprocedure) into d;
  if position('CUSTOMER_MERGER_CLOSURE' in d) = 0 then
    d := replace(d, $a$  return jsonb_build_object('ods', p_ods, 'closed', true, 'signal', sig);$a$, $a$  if coalesce(a.hubspot_customer, false) and not exists (select 1 from public.sales_triggers where trigger_type = 'CUSTOMER_MERGER_CLOSURE' and ods_code = a.ods_code and headline like 'Customer closed:%' and detected_at > now() - interval '90 days') then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (a.ods_code, 'CUSTOMER_MERGER_CLOSURE', 'Customer closed: ' || a.practice_name,
      a.practice_name || ' (' || a.ods_code || ') is a customer and has closed.',
      'Check the contract and any freemium or paid services, plan the churn or transfer, and speak to the neighbouring practices taking its patients.');
    sig := true;
  end if;
  return jsonb_build_object('ods', p_ods, 'closed', true, 'signal', sig);$a$);
    execute d;
  end if;

  -- NHS directory sees a customer close, and CQC shows a new registration
  select pg_get_functiondef('public.log_sales_triggers()'::regprocedure) into d;
  if position('CQC_NEW_REGISTRATION' in d) = 0 then
    d := replace(d, $a$  if new.status = 'Active' and old.total_patients > 0 then$a$, $a$  if old.status = 'Active' and new.status = 'Closed' and coalesce(old.hubspot_customer, false)
     and not exists (select 1 from public.sales_triggers where trigger_type = 'CUSTOMER_MERGER_CLOSURE' and ods_code = new.ods_code and headline like 'Customer closed:%' and detected_at > now() - interval '90 days') then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (new.ods_code, 'CUSTOMER_MERGER_CLOSURE', 'Customer closed: ' || old.practice_name,
      old.practice_name || ' (' || old.ods_code || ') is a customer and is now closed in the NHS directory.',
      'Check the contract and any freemium or paid services, plan the churn or transfer, and speak to the neighbouring practices taking its patients.');
  end if;

  if new.cqc_registered_date is not null and old.cqc_registered_date is distinct from new.cqc_registered_date
     and new.cqc_registered_date >= current_date - 90
     and not exists (select 1 from public.sales_triggers where trigger_type = 'CQC_NEW_REGISTRATION' and ods_code = new.ods_code and detected_at > now() - interval '90 days') then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (new.ods_code, 'CQC_NEW_REGISTRATION', 'New CQC registration: ' || new.practice_name,
      new.practice_name || ' (' || new.ods_code || ') was registered with CQC on ' || new.cqc_registered_date || '.',
      'A newly registered practice is choosing its systems and suppliers. Introduce Lalu to the practice manager early.');
  end if;

  if new.status = 'Active' and old.total_patients > 0 then$a$);
    execute d;
  end if;
end $mig$;
