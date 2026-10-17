-- Confirmed closures. ODS only marks a practice Closed some time after it really shuts, and a closed practice often shows no list size and a
-- CQC "Deregistered" status first. Likely closures are suggested for review; a person confirms. Confirming raises one PRACTICE_CLOSED signal
-- on the practice's PCN listing the nearest practices that will pick up its patients.
alter table public.gp_practices add column if not exists closure_confirmed_at timestamptz;
alter table public.gp_practices add column if not exists closure_note text;
alter table public.gp_practices add column if not exists closed_by text;

do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.sales_triggers'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%trigger_type = any%' loop
    execute format('alter table public.sales_triggers drop constraint %I', c);
  end loop;
  alter table public.sales_triggers add constraint sales_triggers_trigger_type_check check (trigger_type in (
    'MERGER_DETECTED','MANAGER_TURNOVER','RAPID_GROWTH','NEW_PRACTICE','PCN_CHANGE','CQC_DEREGISTERED','CQC_RATING_CHANGE','CQC_INSPECTION',
    'CQC_MANAGER_ABSENT','CQC_PROVIDER_CHANGE','JOB_REPORT_ROLE','PRACTICE_CLOSED'));
end $$;

insert into public.signal_settings (trigger_type, label, source, rule, why, sort_order, enabled) values
 ('PRACTICE_CLOSED', 'Practice closed: area impact', 'NHS directory + CQC + NHS patient file (you confirm)',
  'You confirm a practice has closed; the signal lands on its PCN and lists the nearest practices.',
  'A closure sends its patients to neighbouring practices, which brings more registrations and more report requests.', 12, true)
on conflict (trigger_type) do nothing;

-- A practice confirmed closed no longer appears as a merger suggestion.
create or replace view public.practice_merge_suggestions with (security_invoker = true) as
select z.ods_code, c.ods_code as into_code, c.practice_name as into_name, c.total_patients as into_patients, c.n_candidates,
       case when z.ods_code like 'Y%' then 'low' when c.n_candidates = 1 then 'high' else 'medium' end as confidence
  from public.gp_practices z
  cross join lateral (
    select a.ods_code, a.practice_name, a.total_patients, count(*) over () as n_candidates
      from public.gp_practices a
     where a.country = z.country and a.status = 'Active' and a.total_patients > 0 and a.merged_into is null and a.closure_confirmed_at is null
       and upper(replace(a.postcode, ' ', '')) = upper(replace(z.postcode, ' ', ''))
     order by a.total_patients desc, a.ods_code limit 1) c
 where z.status = 'Active' and z.total_patients = 0 and z.merged_into is null and z.closure_confirmed_at is null and not z.merge_dismissed
   and z.country = 'England' and z.postcode is not null;

-- Likely closures: Active on ODS, no list size, deregistered from CQC, not a Y-code site and nothing at its postcode that looks like it absorbed it.
create or replace view public.practice_closure_candidates with (security_invoker = true) as
select g.ods_code, g.cqc_last_inspection
  from public.gp_practices g
 where g.country = 'England' and g.status = 'Active' and g.total_patients = 0 and g.cqc_status = 'Deregistered' and g.ods_code not like 'Y%'
   and g.merged_into is null and g.closure_confirmed_at is null and not g.merge_dismissed
   and not exists (select 1 from public.practice_merge_suggestions s where s.ods_code = g.ods_code);
grant select on public.practice_closure_candidates to authenticated;

create or replace function public.set_practice_closed(p_ods text, p_closed boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.gp_practices; pcn uuid; near text; sig boolean := false;
begin
  if not private.is_allowed() then raise exception 'not authorised'; end if;
  select * into a from public.gp_practices where ods_code = p_ods;
  if not found then raise exception 'unknown practice %', p_ods; end if;
  if not p_closed then
    update public.gp_practices set closure_confirmed_at = null, closure_note = null, closed_by = null where ods_code = p_ods;
    return jsonb_build_object('ods', p_ods, 'closed', false);
  end if;
  if a.merged_into is not null then raise exception '% is recorded as merged: undo that first', p_ods; end if;
  if exists (select 1 from public.gp_practices where merged_into = p_ods) then raise exception '% has other practices merged into it', p_ods; end if;
  update public.gp_practices set closure_confirmed_at = now(), closure_note = nullif(btrim(coalesce(p_note, '')), ''),
         closed_by = coalesce(auth.jwt() ->> 'email', ''), merge_dismissed = false where ods_code = p_ods;

  if a.pcn_code is not null then select id into pcn from public.organisations where kind = 'pcn' and source_key = 'ods:' || a.pcn_code limit 1; end if;
  select string_agg(x.practice_name || ' (' || x.total_patients || ')', ', ' order by x.total_patients desc) into near from (
    select n.practice_name, n.total_patients from public.gp_practices n
     where n.ods_code <> a.ods_code and n.status = 'Active' and n.merged_into is null and n.closure_confirmed_at is null and n.total_patients > 0
       and ((a.pcn_code is not null and n.pcn_code = a.pcn_code) or (a.pcn_code is null and split_part(n.postcode, ' ', 1) = split_part(a.postcode, ' ', 1)))
     order by n.total_patients desc limit 5) x;
  if not exists (select 1 from public.sales_triggers where trigger_type = 'PRACTICE_CLOSED' and headline = 'Practice closed: ' || a.practice_name and detected_at > now() - interval '90 days') then
    insert into public.sales_triggers (ods_code, org_id, trigger_type, headline, description, action)
    values (case when pcn is null then a.ods_code end, pcn, 'PRACTICE_CLOSED', 'Practice closed: ' || a.practice_name,
      a.practice_name || ' (' || a.ods_code || ', ' || coalesce(nullif(a.postcode, ''), 'no postcode') || ') has closed. Its patients are re-registering at nearby practices'
        || case when near is not null then ': ' || near || '.' else '.' end,
      'Contact the practice managers in ' || coalesce(a.pcn_name, 'the area') || ' about the extra registrations and the medical-report and records requests that come with them.');
    sig := true;
  end if;
  return jsonb_build_object('ods', p_ods, 'closed', true, 'signal', sig);
end $$;
revoke all on function public.set_practice_closed(text, boolean, text) from public, anon;
grant execute on function public.set_practice_closed(text, boolean, text) to authenticated;
comment on function public.set_practice_closed(text, boolean, text) is 'SECURITY DEFINER by design: allowlist-checked inside; anon cannot run it. Advisor warning 0029 is expected.';

-- CQC "Deregistered" is common for practices that still have patients (location re-registrations), so it only raises a signal when there is no list size.
do $$
declare def text;
begin
  def := pg_get_functiondef('public.log_sales_triggers()'::regprocedure);
  if position('old.cqc_status = ''Registered'' and new.cqc_status = ''Deregistered''' in def) > 0 and position('coalesce(new.total_patients, 0) = 0' in def) = 0 then
    def := replace(def, 'old.cqc_status = ''Registered'' and new.cqc_status = ''Deregistered''', 'old.cqc_status = ''Registered'' and new.cqc_status = ''Deregistered'' and coalesce(new.total_patients, 0) = 0');
    execute def;
  end if;
end $$;
