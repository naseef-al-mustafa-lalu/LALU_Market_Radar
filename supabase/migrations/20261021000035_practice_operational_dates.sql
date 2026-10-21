-- Operational period from the ODS API (the practice's open / close dates), fetched in capped daily batches.
alter table public.gp_practices
  add column if not exists operational_start_date date,
  add column if not exists operational_end_date date,
  add column if not exists ods_dates_checked_at timestamptz;
