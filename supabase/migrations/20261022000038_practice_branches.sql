-- Branch surgeries (ODS role RO96). A branch is a site of its parent: list size, ARR and HubSpot all stay on the parent practice.
create table if not exists public.practice_branches (
  branch_code text primary key,
  branch_name text not null,
  address     text,
  town        text,
  county      text,
  postcode    text,
  phone       text,
  opened      date,
  status      text not null default 'Active' check (status in ('Active','Closed')),
  parent_code text,
  parent_name text,
  parent_role text,                    -- ODS role id of the parent, e.g. RO177
  parent_role_name text,               -- its name, e.g. Prescribing Cost Centre
  kind        text not null default 'gp_practice' check (kind in ('gp_practice','gp_not_held','non_gp')),   -- parent is a practice we hold | a GP practice we do not hold (closed, non-England) | not a GP practice
  checked_at  timestamptz
);
create index if not exists practice_branches_parent on public.practice_branches (parent_code);
alter table public.practice_branches enable row level security;
create policy read_practice_branches on public.practice_branches for select to authenticated using ((select private.is_allowed()));
grant select on public.practice_branches to authenticated;
