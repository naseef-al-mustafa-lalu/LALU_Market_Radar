-- Provider groups (e.g. Modality) from CQC provider IDs, and a takeover signal when a practice changes operator.
alter table public.gp_practices
  add column cqc_brand_name text, add column group_name text, add column group_size integer;

alter table public.sales_triggers drop constraint sales_triggers_trigger_type_check;
alter table public.sales_triggers add constraint sales_triggers_trigger_type_check check (trigger_type in
  ('MERGER_DETECTED','MANAGER_TURNOVER','RAPID_GROWTH','NEW_PRACTICE','PCN_CHANGE',
   'CQC_DEREGISTERED','CQC_RATING_CHANGE','CQC_INSPECTION','CQC_MANAGER_ABSENT','CQC_PROVIDER_CHANGE'));

create or replace function public.log_sales_triggers() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  diff integer;
begin
  if not exists (select 1 from public.ingest_runs where status = 'success') then
    return null;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'Active' then
      insert into public.sales_triggers (ods_code, trigger_type, headline, description)
      values (new.ods_code, 'NEW_PRACTICE', 'New practice registered',
        new.practice_name || ' (' || new.sales_segment || ', ' || new.total_patients || ' patients) has appeared in NHS data.');
    end if;
    return null;
  end if;

  if old.status = 'Active' and new.status = 'Closed' then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description)
    values (new.ods_code, 'MERGER_DETECTED', 'Practice closed: possible merger or absorption',
      old.practice_name || ' (' || old.total_patients || ' patients) is now closed. Its patients are likely moving to a neighbouring practice, so check nearby practices in ' || old.pcn_name || '.');
  end if;

  if new.status = 'Active' and old.total_patients > 0 then
    diff := new.total_patients - old.total_patients;
    if new.total_patients >= old.total_patients * 1.20 and diff >= 500 then
      insert into public.sales_triggers (ods_code, trigger_type, headline, description)
      values (new.ods_code, 'RAPID_GROWTH', 'Rapid list growth',
        'List grew by ' || diff || ' patients (' || old.total_patients || ' to ' || new.total_patients || '), likely an absorbed practice or large intake.');
    end if;
  end if;

  if old.pcn_code is not null and new.pcn_code is not null and old.pcn_code <> new.pcn_code then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description)
    values (new.ods_code, 'PCN_CHANGE', 'Moved Primary Care Network',
      'Moved from ' || old.pcn_name || ' to ' || new.pcn_name || '.');
  end if;

  if old.manager_name is not null and new.manager_name is not null
     and lower(old.manager_name) <> lower(new.manager_name) then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description)
    values (new.ods_code, 'MANAGER_TURNOVER', 'New practice manager',
      'Key contact changed from ' || old.manager_name || ' to ' || new.manager_name || '. New managers often review suppliers.');
  end if;

  -- CQC signals only fire when we already held a previous CQC value, so the first CQC load is silent.
  if old.cqc_status = 'Registered' and new.cqc_status = 'Deregistered' then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description)
    values (new.ods_code, 'CQC_DEREGISTERED', 'CQC registration ended',
      new.practice_name || ' is no longer registered with CQC: a strong sign of a merger, takeover or closure.');
  end if;

  if old.cqc_rating is not null and new.cqc_rating is not null and old.cqc_rating <> new.cqc_rating then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description)
    values (new.ods_code, 'CQC_RATING_CHANGE', 'CQC rating changed',
      'Overall CQC rating moved from ' || old.cqc_rating || ' to ' || new.cqc_rating || '. Practices under pressure often look for better systems and reporting.');
  end if;

  if old.cqc_last_inspection is not null and new.cqc_last_inspection is not null
     and new.cqc_last_inspection > old.cqc_last_inspection then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description)
    values (new.ods_code, 'CQC_INSPECTION', 'New CQC inspection',
      'Inspected on ' || new.cqc_last_inspection || '. Current rating: ' || coalesce(new.cqc_rating, 'not published') || '.');
  end if;

  if old.cqc_location_id is not null and old.cqc_manager_absent_date is null and new.cqc_manager_absent_date is not null then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description)
    values (new.ods_code, 'CQC_MANAGER_ABSENT', 'No CQC registered manager',
      'The registered manager has been absent since ' || new.cqc_manager_absent_date || '. Leadership gap and a possible buying window.');
  end if;
  if old.cqc_provider_id is not null and new.cqc_provider_id is not null and old.cqc_provider_id <> new.cqc_provider_id then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description)
    values (new.ods_code, 'CQC_PROVIDER_CHANGE', 'Practice changed operator: likely takeover',
      new.practice_name || ' is now registered with ' || coalesce(new.group_name, new.cqc_provider_id) ||
      ' (previously ' || coalesce(old.group_name, old.cqc_provider_id) || '). Group takeovers often bring system consolidation.');
  end if;
  return null;
end $$;
revoke all on function public.log_sales_triggers() from public, anon, authenticated;
