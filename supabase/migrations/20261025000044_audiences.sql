-- Audiences: one automatic audience per signal type (custom ones later). A contact in an audience is only ever a person a salesperson approved or skipped;
-- suggestions are read live from HubSpot. Approved contacts go on to a HubSpot list and sequence (later steps), one sequence at a time per contact.
create table if not exists public.audiences (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('signal', 'custom')),
  signal_type text,
  name text not null,
  sequence_id text,
  sequence_name text,
  hubspot_list_id text,
  filters jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  archived boolean not null default false
);
create unique index if not exists audiences_signal_type on public.audiences (signal_type) where signal_type is not null;

create table if not exists public.audience_members (
  id uuid primary key default gen_random_uuid(),
  audience_id uuid not null references public.audiences (id) on delete cascade,
  contact_id text not null,
  ods_code text not null,
  company_id text,
  contact_name text,
  job_title text,
  email text,
  state text not null check (state in ('approved', 'skipped', 'enrolled', 'removed')),
  state_by text,
  state_at timestamptz not null default now(),
  unique (audience_id, contact_id)
);
create index if not exists audience_members_contact on public.audience_members (contact_id);
create index if not exists audience_members_ods on public.audience_members (ods_code);

alter table public.audiences enable row level security;
alter table public.audience_members enable row level security;
create policy audiences_all on public.audiences for all to authenticated using ((select private.is_allowed())) with check ((select private.is_allowed()));
create policy audience_members_all on public.audience_members for all to authenticated using ((select private.is_allowed())) with check ((select private.is_allowed()));

insert into public.audiences (kind, signal_type, name) select 'signal', trigger_type, label from public.signal_settings on conflict do nothing;
