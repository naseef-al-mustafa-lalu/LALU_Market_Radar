-- Everything applied to the live database after migration 14 (signal_settings), recorded here so a fresh database matches production.
-- Written idempotently where possible. Functions are the final versions in production.

-- ---------- signals: actions, links, status workflow, network / unlinked targets ----------
alter table public.sales_triggers alter column ods_code drop not null;
alter table public.sales_triggers
  add column if not exists org_id uuid references public.organisations(id) on delete set null,
  add column if not exists employer_code text,
  add column if not exists action text,
  add column if not exists url text,
  add column if not exists status text not null default 'new',
  add column if not exists note text,
  add column if not exists handled_at timestamptz;
alter table public.sales_triggers drop constraint if exists sales_triggers_trigger_type_check;
alter table public.sales_triggers add constraint sales_triggers_trigger_type_check check (trigger_type = any (array[
  'MERGER_DETECTED','MANAGER_TURNOVER','RAPID_GROWTH','NEW_PRACTICE','PCN_CHANGE','CQC_DEREGISTERED','CQC_RATING_CHANGE',
  'CQC_INSPECTION','CQC_MANAGER_ABSENT','CQC_PROVIDER_CHANGE','JOB_REPORT_ROLE']));
alter table public.sales_triggers drop constraint if exists sales_triggers_has_target;
alter table public.sales_triggers add constraint sales_triggers_has_target check (ods_code is not null or org_id is not null or employer_code is not null);
alter table public.sales_triggers drop constraint if exists sales_triggers_status_check;
alter table public.sales_triggers add constraint sales_triggers_status_check check (status in ('new','in_progress','done','dismissed'));
create index if not exists sales_triggers_org_idx on public.sales_triggers (org_id);
create index if not exists sales_triggers_employer_idx on public.sales_triggers (employer_code);
create index if not exists sales_triggers_status_idx on public.sales_triggers (status);
drop policy if exists update_signal_status on public.sales_triggers;
create policy update_signal_status on public.sales_triggers for update to authenticated using (private.is_allowed()) with check (private.is_allowed());
grant update (status, note, handled_at) on public.sales_triggers to authenticated;

-- CQC operator names, used to say who took over from whom
alter table public.gp_practices add column if not exists cqc_provider_name text, add column if not exists cqc_prev_provider_name text;

-- ---------- NHS Jobs: employers (linked once, never guessed) and role adverts ----------
create table if not exists public.job_employers (
  employer_code text primary key,
  employer_name text not null,
  postcodes text[] not null default '{}',
  match_status text not null default 'review' check (match_status in ('auto','confirmed','rejected','review','network')),
  ods_code varchar(6) references public.gp_practices(ods_code) on delete set null,
  org_id uuid references public.organisations(id) on delete set null,
  candidates jsonb not null default '[]',
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists job_employers_match_status_idx on public.job_employers (match_status);
create index if not exists job_employers_ods_code_idx on public.job_employers (ods_code);
create index if not exists job_employers_org_idx on public.job_employers (org_id);

create table if not exists public.job_adverts (
  advert_id text primary key,
  employer_code text not null references public.job_employers(employer_code) on delete cascade,
  ods_code varchar(6) references public.gp_practices(ods_code) on delete set null,
  org_id uuid references public.organisations(id) on delete set null,
  reference text,
  title text not null,
  matched_role text not null,
  post_date date,
  close_date date,
  url text,
  locations text[] not null default '{}',
  signalled boolean not null default false,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists job_adverts_ods_code_idx on public.job_adverts (ods_code);
create index if not exists job_adverts_employer_code_idx on public.job_adverts (employer_code);
create index if not exists job_adverts_post_date_idx on public.job_adverts (post_date desc);
create index if not exists job_adverts_org_idx on public.job_adverts (org_id);

alter table public.job_employers enable row level security;
alter table public.job_adverts enable row level security;
drop policy if exists read_job_employers on public.job_employers;
drop policy if exists read_job_adverts on public.job_adverts;
create policy read_job_employers on public.job_employers for select to authenticated using (private.is_allowed());
create policy read_job_adverts on public.job_adverts for select to authenticated using (private.is_allowed());
grant select on public.job_employers, public.job_adverts to authenticated;

create or replace function public.link_job_employer(p_code text, p_ods text, p_org uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  if p_action = 'confirm' then
    if (p_ods is null) = (p_org is null) then raise exception 'choose either a practice or a network'; end if;
    if p_ods is not null and not exists (select 1 from public.gp_practices where ods_code = upper(p_ods)) then raise exception 'unknown practice %', p_ods; end if;
    if p_org is not null and not exists (select 1 from public.organisations where id = p_org) then raise exception 'unknown network'; end if;
    update public.job_employers set match_status = 'confirmed', ods_code = upper(p_ods), org_id = p_org, reviewed_at = now() where employer_code = p_code;
    update public.job_adverts set ods_code = upper(p_ods), org_id = p_org where employer_code = p_code;
    update public.sales_triggers set ods_code = upper(p_ods), org_id = p_org where employer_code = p_code;
  elsif p_action in ('reject', 'reopen') then
    update public.job_employers set match_status = case when p_action = 'reject' then 'rejected' else 'review' end, ods_code = null, org_id = null,
           reviewed_at = case when p_action = 'reject' then now() end where employer_code = p_code;
    update public.job_adverts set ods_code = null, org_id = null where employer_code = p_code;
    update public.sales_triggers set ods_code = null, org_id = null where employer_code = p_code;
  else raise exception 'action must be confirm, reject or reopen'; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.link_job_employer(text, text, uuid, text) from public, anon;
grant execute on function public.link_job_employer(text, text, uuid, text) to authenticated;

-- ---------- signal types: catalogue and switches (see also migration 14) ----------
create or replace function public.skip_disabled_signal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.signal_settings where trigger_type = new.trigger_type and not enabled) then return null; end if;
  return new;
end $$;
revoke all on function public.skip_disabled_signal() from public, anon, authenticated;
drop trigger if exists tr_skip_disabled on public.sales_triggers;
create trigger tr_skip_disabled before insert on public.sales_triggers for each row execute function public.skip_disabled_signal();
insert into public.signal_settings (trigger_type, label, source, rule, why, sort_order) values
 ('JOB_REPORT_ROLE','Hiring for report / records role','NHS Jobs vacancy feed (daily, jobs.nhs.uk search_xml)',
  'A practice (or PCN / federation / group) advertises a role on NHS Jobs whose TITLE mentions medical secretary, records, summariser, workflow, document management, medico-legal, SAR / subject access or information governance. Adverts from employers not yet linked appear as unlinked signals. First load only signals adverts from the last 7 days.',
  'A practice hiring for reports and records work is feeling the workload Lalu removes.', 11)
on conflict (trigger_type) do nothing;

-- ---------- signal wording: facts and a next step for every type (final version) ----------
create or replace function public.log_sales_triggers() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  diff integer;
  ratings text[] := array['Inadequate','Requires improvement','Good','Outstanding'];
  net text;
  prov_new text;
  prov_old text;
  same_op boolean;
begin
  if current_setting('lalu.bulk_load', true) = '1' then return null; end if;
  if not exists (select 1 from public.ingest_runs where status = 'success') then
    return null;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'Active' then
      net := nullif(new.pcn_name, 'Unallocated PCN');
      insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
      values (new.ods_code, 'NEW_PRACTICE', 'New practice: ' || new.practice_name,
        new.practice_name || ' (' || new.ods_code || ') has appeared in the NHS GP list' ||
          case when new.total_patients > 0 then ' with ' || to_char(new.total_patients, 'FM999,999') || ' patients' else ' (list size not published yet)' end ||
          coalesce(' in ' || net, '') || '.',
        'A new contract has no records or reports process yet. Introduce Lalu to the practice manager before they choose suppliers.');
    end if;
    return null;
  end if;

  net := nullif(old.pcn_name, 'Unallocated PCN');

  if old.status = 'Active' and new.status = 'Closed' then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (new.ods_code, 'MERGER_DETECTED', 'Practice closed: ' || old.practice_name,
      old.practice_name || ' (' || old.ods_code || ', ' || to_char(old.total_patients, 'FM999,999') || ' patients) has closed' || coalesce(' in ' || net, '') || '.',
      'Its patients and records will move to neighbouring practices, which means a spike in record transfers and reports. Contact the other practices' || coalesce(' in ' || net, ' nearby') || '.');
  end if;

  if new.status = 'Active' and old.total_patients > 0 then
    diff := new.total_patients - old.total_patients;
    if new.total_patients >= old.total_patients * 1.20 and diff >= 500 then
      insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
      values (new.ods_code, 'RAPID_GROWTH', 'List up ' || round(diff * 100.0 / old.total_patients) || '%: ' || new.practice_name,
        new.practice_name || '''s list grew by ' || to_char(diff, 'FM999,999') || ' patients, from ' || to_char(old.total_patients, 'FM999,999') || ' to ' || to_char(new.total_patients, 'FM999,999') || ', in the latest NHS data.',
        'Usually an absorbed practice or a large new intake: more records to merge and more report requests. A good moment to offer extra capacity.');
    end if;
  end if;

  if old.pcn_code is not null and new.pcn_code is not null and old.pcn_code <> new.pcn_code then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (new.ods_code, 'PCN_CHANGE', 'Changed PCN: ' || new.practice_name,
      new.practice_name || ' moved from ' || old.pcn_name || ' to ' || new.pcn_name || '.',
      'Network ownership has changed, so the buying decision-maker may have too. Check the contacts at both PCNs.');
  end if;

  if old.manager_name is not null and new.manager_name is not null
     and lower(old.manager_name) <> lower(new.manager_name) then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (new.ods_code, 'MANAGER_TURNOVER', 'New practice manager: ' || new.practice_name,
      new.practice_name || '''s key contact changed from ' || old.manager_name || ' to ' || new.manager_name || coalesce(' (' || new.manager_title || ')', '') || '.',
      'New managers often review suppliers in their first months. Introduce Lalu to ' || new.manager_name || '.');
  end if;

  if old.cqc_status = 'Registered' and new.cqc_status = 'Deregistered' then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (new.ods_code, 'CQC_DEREGISTERED', 'No longer CQC registered: ' || new.practice_name,
      new.practice_name || '''s CQC registration has ended.',
      'A strong sign of a merger, takeover or closure. Check who now holds its patients and contact them.');
  end if;

  if old.cqc_rating is not null and new.cqc_rating is not null and old.cqc_rating <> new.cqc_rating then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (new.ods_code, 'CQC_RATING_CHANGE', new.practice_name || ': CQC rating ' || old.cqc_rating || ' to ' || new.cqc_rating,
      new.practice_name || '''s overall CQC rating moved from ' || old.cqc_rating || ' to ' || new.cqc_rating || coalesce(' (inspected ' || new.cqc_last_inspection || ')', '') || '.',
      case when array_position(ratings, new.cqc_rating) < array_position(ratings, old.cqc_rating)
        then 'Rating dropped: practices under inspection pressure look for better systems and reporting. Offer help with records and reports.'
        else 'Rating improved: a positive reason to get in touch and ask how they are managing records and reports.' end);
  end if;

  if old.cqc_last_inspection is not null and new.cqc_last_inspection is not null
     and new.cqc_last_inspection > old.cqc_last_inspection then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (new.ods_code, 'CQC_INSPECTION', new.practice_name || ': CQC inspected ' || new.cqc_last_inspection,
      new.practice_name || ' was inspected on ' || new.cqc_last_inspection || ' (previous inspection ' || old.cqc_last_inspection || '). Current rating: ' || coalesce(new.cqc_rating, 'not published') || '.',
      'Inspections often prompt process changes. Ask how ready their records and reporting are.');
  end if;

  if old.cqc_location_id is not null and old.cqc_manager_absent_date is null and new.cqc_manager_absent_date is not null then
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (new.ods_code, 'CQC_MANAGER_ABSENT', 'No CQC registered manager: ' || new.practice_name,
      new.practice_name || ' has had no CQC registered manager since ' || new.cqc_manager_absent_date || '.',
      'A leadership gap the practice must fill: a possible buying window. Ask who is covering.');
  end if;

  if old.cqc_provider_id is not null and new.cqc_provider_id is not null and old.cqc_provider_id <> new.cqc_provider_id then
    prov_new := coalesce(new.cqc_provider_name, new.group_name);
    prov_old := coalesce(new.cqc_prev_provider_name, old.cqc_provider_name, old.group_name);
    same_op := prov_new is not null and lower(prov_new) = lower(coalesce(prov_old, ''));
    insert into public.sales_triggers (ods_code, trigger_type, headline, description, action)
    values (new.ods_code, 'CQC_PROVIDER_CHANGE',
      case when same_op then new.practice_name || ': new CQC provider record' else new.practice_name || ' changed owner' || coalesce(' to ' || prov_new, '') end,
      case when same_op then new.practice_name || ' has re-registered with CQC under a new provider record, still named ' || prov_new || '.'
        else new.practice_name || ' is now run by ' || coalesce(prov_new, 'a different CQC provider') || case when prov_old is not null then ' (previously ' || prov_old || ')' else '' end || '.' end,
      case when same_op then 'Same operator name, new legal entity: usually a partnership change or restructure, not a takeover. Ask the practice manager what changed; partner changes can reset supplier decisions.'
        else 'A takeover usually brings the new owner''s systems and processes. Find the new owner''s decision-maker and make contact before the practice is consolidated.' end);
  end if;
  return null;
end $$;
