-- Central enriched database: more Oscar CRM fields + CQC fields + new CQC signal types.
alter table public.gp_practices
  add column oscar_org_urn bigint, add column oscar_site_urn bigint, add column kk_org_urn text,
  add column address text, add column town text, add column county text, add column region text,
  add column main_phone text, add column main_email text, add column main_email_opt_out boolean not null default false,
  add column num_employees text, add column annual_spend text, add column org_notes text,
  add column nhs_num_gp text, add column gp_federation text, add column oscar_categories text,
  add column cqc_location_id text, add column cqc_provider_id text, add column cqc_status text, add column cqc_rating text,
  add column cqc_last_inspection date, add column cqc_manager_absent_date date, add column cqc_checked_at timestamptz;

alter table public.contacts
  add column org_urn bigint, add column title text, add column first_name text, add column last_name text,
  add column quals text, add column dept text, add column categories text, add column data_types text, add column main_site boolean;

create table public.kv_state (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
alter table public.kv_state enable row level security;  -- service role only
revoke all on public.kv_state from anon, authenticated;
grant all on public.kv_state to service_role;

alter table public.sales_triggers drop constraint sales_triggers_trigger_type_check;
alter table public.sales_triggers add constraint sales_triggers_trigger_type_check check (trigger_type in
  ('MERGER_DETECTED','MANAGER_TURNOVER','RAPID_GROWTH','NEW_PRACTICE','PCN_CHANGE',
   'CQC_DEREGISTERED','CQC_RATING_CHANGE','CQC_INSPECTION','CQC_MANAGER_ABSENT'));

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
  return null;
end $$;
revoke all on function public.log_sales_triggers() from public, anon, authenticated;
