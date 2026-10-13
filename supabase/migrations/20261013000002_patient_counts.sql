create table public.patient_counts (
  ods_code   varchar(6) primary key check (ods_code ~ '^[A-Z][0-9]{5}$'),
  patients   integer not null check (patients >= 0),
  data_month text,
  updated_at timestamptz not null default now()
);
alter table public.patient_counts enable row level security;  -- service role only (no policies)
revoke all on public.patient_counts from anon, authenticated;
grant all on public.patient_counts to service_role;

alter table public.gp_practices add column pcn_checked_at timestamptz;
