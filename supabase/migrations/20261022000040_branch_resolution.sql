-- What each ODS branch record really is, and which GP practice it belongs to (src/branches.py).
alter table public.practice_branches
  add column if not exists practice_code text,                 -- the GP practice it belongs to / repeats / is hosted by (null for shared buildings and other sites)
  add column if not exists resolution text check (resolution in ('branch','duplicate_branch','duplicate_practice','hosted','shared','other')),
  add column if not exists matched_branch_code text,           -- for duplicate_branch: the real branch record it repeats
  add column if not exists match_status text not null default 'auto' check (match_status in ('auto','probable','review','confirmed','rejected')),
  add column if not exists match_note text;
create index if not exists practice_branches_practice on public.practice_branches (practice_code);
-- the dashboard lets an allowed user confirm or reject a match; nothing else on the row is editable from the browser
create policy update_branch_review on public.practice_branches for update to authenticated using ((select private.is_allowed())) with check ((select private.is_allowed()));
grant update (match_status) on public.practice_branches to authenticated;
