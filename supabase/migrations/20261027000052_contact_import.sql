-- Contacts from the HubSpot export: staged, quality-checked, then promoted into public.contacts. Oscar (when connected) updates the same rows by email and adds new contacts only after the same check.
create sequence if not exists public.contact_local_urn increment by -1 start with -1 minvalue -9000000000000000000 maxvalue -1;   -- URNs for contacts that did not come from Oscar are negative, so they never collide with Oscar's
alter table public.contacts alter column contact_urn set default nextval('public.contact_local_urn');
alter table public.contacts add column if not exists source text not null default 'oscar' check (source in ('oscar', 'hubspot'));
alter table public.contacts add column if not exists email_quality text check (email_quality in ('direct', 'likely_direct', 'check', 'shared'));
alter table public.contacts add column if not exists role_tier text check (role_tier in ('A', 'B', '?', 'x'));
create index if not exists contacts_email_lower on public.contacts (lower(email));

create table if not exists public.contact_candidates (
  hubspot_contact_id text primary key,
  email text, ods_code varchar(6) references public.gp_practices(ods_code) on delete cascade,
  hubspot_company_id text, first_name text, last_name text, job_title text, job_role text, phone text,
  email_quality text, role_tier text,
  status text not null check (status in ('approved', 'review', 'generic', 'rejected', 'suppressed')),
  reason text, opted_out boolean not null default false, bounced boolean not null default false,
  row_hash text, in_latest boolean not null default true, change_note text, changed_at timestamptz,
  contact_urn bigint references public.contacts(contact_urn) on delete set null,
  first_seen timestamptz not null default now(), last_seen timestamptz not null default now(),
  reviewed_by text, reviewed_at timestamptz
);
create index if not exists contact_candidates_status on public.contact_candidates (status);
create index if not exists contact_candidates_email on public.contact_candidates (lower(email));
create index if not exists contact_candidates_ods on public.contact_candidates (ods_code);

create table if not exists public.practice_generic_emails (
  ods_code varchar(6) primary key references public.gp_practices(ods_code) on delete cascade,
  email text not null, source text not null check (source in ('oscar', 'hubspot')), hubspot_contact_id text, added_at timestamptz not null default now()
);

alter table public.contact_candidates enable row level security;
alter table public.practice_generic_emails enable row level security;
create policy read_contact_candidates on public.contact_candidates for select to authenticated using ((select private.is_allowed()));
create policy read_practice_generic_emails on public.practice_generic_emails for select to authenticated using ((select private.is_allowed()));
