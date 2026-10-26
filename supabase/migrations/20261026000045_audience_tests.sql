-- A/B tests on an audience: two HubSpot sequences, contacts split between them at enrolment, results read from HubSpot's contact fields.
create table if not exists public.audience_tests (
  id uuid primary key default gen_random_uuid(),
  audience_id uuid not null references public.audiences (id) on delete cascade,
  name text not null,
  hypothesis text,
  variable text,
  seq_a_id text, seq_a_name text,
  seq_b_id text, seq_b_name text,
  sequence_sender text,
  split_a int not null default 50 check (split_a between 10 and 90),
  min_per_arm int not null default 20 check (min_per_arm >= 1),
  status text not null default 'running' check (status in ('running', 'ended')),
  winner text check (winner in ('a', 'b')),
  conclusion text,
  created_by text,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index if not exists audience_tests_one_running on public.audience_tests (audience_id) where status = 'running';
alter table public.audience_members add column if not exists test_id uuid references public.audience_tests (id) on delete set null;
alter table public.audience_members add column if not exists arm text check (arm in ('a', 'b'));
alter table public.audience_tests enable row level security;
create policy audience_tests_all on public.audience_tests for all to authenticated using ((select private.is_allowed())) with check ((select private.is_allowed()));
