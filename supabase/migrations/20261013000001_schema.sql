-- Lalu Market Radar: schema, change-detection triggers, RLS (email login, allowlist)

create schema if not exists private;

-- ---------- access control ----------
create table public.allowed_users (email text primary key check (email = lower(email)));
alter table public.allowed_users enable row level security;  -- no policies: service role / SQL editor only
insert into public.allowed_users values ('naseef.al-mustafa@lalu.co.uk');

create function private.is_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.allowed_users
                 where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke all on function private.is_allowed() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_allowed() to authenticated;

-- ---------- tables ----------
create table public.gp_practices (
  ods_code       varchar(6) primary key check (ods_code ~ '^[A-Z][0-9]{5}$'),
  practice_name  text not null,
  postcode       text,
  website        text,
  pcn_code       text,
  pcn_name       text not null default 'Unallocated PCN',
  icb_name       text not null default 'Unallocated ICB',
  total_patients integer not null default 0 check (total_patients >= 0),
  status         text not null default 'Active' check (status in ('Active','Closed')),
  clinical_software text not null default 'Unknown'
                 check (clinical_software in ('EMIS Web','SystmOne','Vision','Unknown')),
  software_source text,
  software_checked_at timestamptz,
  manager_name   text,
  manager_title  text,
  manager_email  text,
  manager_phone  text,
  manager_email_opt_out boolean not null default false,
  lead_status    text not null default 'Cold'
                 check (lead_status in ('Cold','In-Progress','Contacted','Do-Not-Contact')),
  data_month     text,
  first_seen     timestamptz not null default now(),
  last_updated   timestamptz not null default now(),
  sales_segment  text generated always as (
    case when total_patients > 15000 then 'Tier 1 (Enterprise / Super-Partnership)'
         when total_patients >= 7000 then 'Tier 2 (Mid-Market)'
         else 'Tier 3 (Small Practice)' end) stored
);
create index on public.gp_practices (icb_name);
create index on public.gp_practices (total_patients desc);

create table public.contacts (
  contact_urn bigint primary key,
  ods_code    varchar(6) not null references public.gp_practices(ods_code) on delete cascade,
  full_name   text,
  job_title   text,
  seniority   text,
  email       text,
  phone       text,
  email_opt_out boolean not null default false,
  is_primary  boolean not null default false,
  updated_at  timestamptz not null default now()
);
create index on public.contacts (ods_code);

create table public.sales_triggers (
  id uuid primary key default gen_random_uuid(),
  ods_code varchar(6) not null references public.gp_practices(ods_code) on delete cascade,
  trigger_type text not null check (trigger_type in
    ('MERGER_DETECTED','MANAGER_TURNOVER','RAPID_GROWTH','NEW_PRACTICE','PCN_CHANGE')),
  headline text not null,
  description text,
  email_dispatched boolean not null default false,
  detected_at timestamptz not null default now()
);
create index on public.sales_triggers (detected_at desc);
create index on public.sales_triggers (ods_code);
create index on public.sales_triggers (id) where not email_dispatched;

create table public.ingest_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','success','failed')),
  stats jsonb not null default '{}'::jsonb,
  error text
);
create table public.ingest_rejects (
  id bigint generated always as identity primary key,
  run_id bigint references public.ingest_runs(id) on delete cascade,
  source text not null, key text, reason text not null,
  created_at timestamptz not null default now()
);
create index on public.ingest_rejects (run_id);

-- ---------- cleaning (BEFORE) ----------
create function public.clean_practice() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.practice_name := btrim(new.practice_name);
  new.pcn_name := coalesce(nullif(btrim(new.pcn_name), ''), 'Unallocated PCN');
  new.icb_name := coalesce(nullif(btrim(new.icb_name), ''), 'Unallocated ICB');
  new.manager_email := nullif(lower(btrim(new.manager_email)), '');
  new.manager_phone := nullif(btrim(new.manager_phone), '');
  new.manager_name  := nullif(regexp_replace(btrim(new.manager_name), '\s+', ' ', 'g'), '');
  new.last_updated := now();
  return new;
end $$;
create trigger tr_clean before insert or update on public.gp_practices
  for each row execute function public.clean_practice();

-- ---------- change detection (AFTER; FK-safe, sees generated columns) ----------
-- Suppressed until one ingest run has succeeded, so the first load is a silent baseline.
create function public.log_sales_triggers() returns trigger
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
  return null;
end $$;
revoke all on function public.log_sales_triggers() from public, anon, authenticated;

create trigger tr_log_insert after insert on public.gp_practices
  for each row execute function public.log_sales_triggers();
create trigger tr_log_update after update on public.gp_practices
  for each row when (old.* is distinct from new.*) execute function public.log_sales_triggers();

-- ---------- row-level security ----------
alter table public.gp_practices  enable row level security;
alter table public.contacts      enable row level security;
alter table public.sales_triggers enable row level security;
alter table public.ingest_runs   enable row level security;
alter table public.ingest_rejects enable row level security;  -- service role only

create policy read_practices on public.gp_practices for select to authenticated using (private.is_allowed());
create policy update_lead_status on public.gp_practices for update to authenticated
  using (private.is_allowed()) with check (private.is_allowed());
create policy read_contacts on public.contacts for select to authenticated using (private.is_allowed());
create policy read_triggers on public.sales_triggers for select to authenticated using (private.is_allowed());
create policy read_runs on public.ingest_runs for select to authenticated using (private.is_allowed());

-- least privilege: nothing for anon; signed-in users read, and may only edit lead_status
revoke all on all tables in schema public from anon, authenticated;
grant select on public.gp_practices, public.contacts, public.sales_triggers, public.ingest_runs to authenticated;
grant update (lead_status) on public.gp_practices to authenticated;
grant all on all tables in schema public to service_role;
grant usage on all sequences in schema public to service_role;

alter publication supabase_realtime add table public.sales_triggers;
