-- Scotland and Wales: manual uploads like the NHS England patient file.
-- country records where a practice comes from; network_locked stops the daily ODS sync overwriting the cluster/health-board
-- grouping that came from an upload (ODS has no PCN for Wales and nothing at all for Scotland).
alter table public.gp_practices add column if not exists country text not null default 'England' check (country in ('England','Wales','Scotland'));
alter table public.gp_practices add column if not exists network_locked boolean not null default false;
update public.gp_practices set country = 'Wales' where ods_code like 'W%' and country = 'England';

-- New-practice alert no longer quotes the legacy 3-tier label (tiers now come from pricing_tiers).
create or replace function public.log_sales_triggers() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  diff integer;
begin
  if current_setting('lalu.bulk_load', true) = '1' then return null; end if;   -- devolved-nation uploads load silently
  if not exists (select 1 from public.ingest_runs where status = 'success') then
    return null;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'Active' then
      insert into public.sales_triggers (ods_code, trigger_type, headline, description)
      values (new.ods_code, 'NEW_PRACTICE', 'New practice registered',
        new.practice_name || ' (' || new.total_patients || ' patients) has appeared in NHS data.');
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

-- Rows: {code, name, postcode, town, patients, net_code, net_name, icb}. Scotland codes arrive as 'S' + the 5-digit practice code.
create or replace function public.load_devolved(p_country text, p_month text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n_in int; n_new int; n_upd int; refreshed jsonb;
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  if p_country not in ('Wales','Scotland') then raise exception 'country must be Wales or Scotland'; end if;
  if p_month !~ '^[0-9]{4}-[0-9]{2}$' then raise exception 'month must look like 2026-07'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'send at most 2000 rows per call'; end if;
  perform set_config('lalu.bulk_load', '1', true);

  with src as (
    select distinct on (upper(btrim(r ->> 'code')))
           upper(btrim(r ->> 'code')) as code, nullif(btrim(r ->> 'name'), '') as name, nullif(btrim(r ->> 'postcode'), '') as postcode,
           nullif(btrim(r ->> 'town'), '') as town,
           case when (r ->> 'patients') ~ '^[0-9]{1,7}$' then (r ->> 'patients')::int end as patients,
           nullif(btrim(r ->> 'net_code'), '') as net_code, nullif(btrim(r ->> 'net_name'), '') as net_name,
           nullif(btrim(r ->> 'icb'), '') as icb
      from jsonb_array_elements(p_rows) r
     where upper(btrim(r ->> 'code')) ~ case p_country when 'Wales' then '^W[0-9]{5}$' else '^S[0-9]{5}$' end
       and nullif(btrim(r ->> 'name'), '') is not null
     order by upper(btrim(r ->> 'code'))
  ), up as (
    insert into public.gp_practices as g (ods_code, practice_name, postcode, town, total_patients, status, data_month, country,
                                          pcn_code, pcn_name, icb_name, network_locked)
    select code, name, postcode, town, coalesce(patients, 0), 'Active', case when patients is not null then p_month end, p_country,
           net_code, coalesce(net_name, 'Unallocated PCN'), coalesce(icb, 'Unallocated ICB'), net_code is not null
      from src
    on conflict (ods_code) do update set
      practice_name  = case when g.country = 'Scotland' then excluded.practice_name else g.practice_name end,
      postcode       = coalesce(excluded.postcode, g.postcode),
      town           = coalesce(g.town, excluded.town),
      total_patients = coalesce(nullif(excluded.total_patients, 0), g.total_patients),
      data_month     = case when excluded.total_patients > 0 then excluded.data_month else g.data_month end,
      status         = 'Active',
      pcn_code       = coalesce(excluded.pcn_code, g.pcn_code),
      pcn_name       = case when excluded.pcn_code is not null then excluded.pcn_name else g.pcn_name end,
      icb_name       = case when excluded.icb_name <> 'Unallocated ICB' then excluded.icb_name else g.icb_name end,
      network_locked = g.network_locked or excluded.network_locked
     where g.country = p_country
    returning (xmax = 0) as inserted)
  select count(*), count(*) filter (where inserted), count(*) filter (where not inserted) into n_in, n_new, n_upd from up;

  refreshed := public.refresh_org_graph();
  return jsonb_build_object('stored', n_in, 'new', n_new, 'updated', n_upd, 'graph', refreshed);
end $$;
revoke all on function public.load_devolved(text, text, jsonb) from public, anon;
grant execute on function public.load_devolved(text, text, jsonb) to authenticated;
