-- Switches the signed-in team can flip from the dashboard and the daily sync reads. list_size_sync: write the NHS list size to non-customer HubSpot companies after each patient-count load (off by default).
create table if not exists public.app_flags (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);
alter table public.app_flags enable row level security;
create policy app_flags_all on public.app_flags for all to authenticated using ((select private.is_allowed())) with check ((select private.is_allowed()));
insert into public.app_flags (key, value) values ('list_size_sync', '{"enabled": false}') on conflict do nothing;
