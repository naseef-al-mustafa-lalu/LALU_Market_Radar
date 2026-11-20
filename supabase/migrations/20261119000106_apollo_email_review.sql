-- Review list, second kind: Apollo returned an address for someone Atlas or HubSpot already holds at that practice under a different address. Nothing is created or changed until someone chooses.
alter table public.apollo_queue drop constraint if exists apollo_queue_state_check;
alter table public.apollo_queue add constraint apollo_queue_state_check check (state in ('pending', 'approved', 'found', 'not_found', 'error', 'review', 'accepted'));
alter table public.apollo_queue add column if not exists review_reason text check (review_reason in ('different_practice', 'different_email'));
alter table public.apollo_queue add column if not exists existing_email text;
alter table public.apollo_queue add column if not exists existing_where text;       -- 'Atlas' or 'HubSpot'
alter table public.apollo_queue add column if not exists existing_urn bigint;       -- the Atlas contact that already holds the person, when there is one
update public.apollo_queue set review_reason = 'different_practice' where state = 'review' and review_reason is null;
create or replace function public.apollo_resolve_email_review(p_urn bigint, p_use_apollo boolean) returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not private.is_allowed() then raise exception 'not allowed'; end if;
  update public.apollo_queue set state = case when p_use_apollo then 'accepted' else 'not_found' end,
         note = case when p_use_apollo then 'same person: Apollo address chosen in review' else 'same person: existing address kept in review' end, checked_at = now()
    where contact_urn = p_urn and state = 'review' and review_reason = 'different_email'; get diagnostics n = row_count; return n;
end $$;
revoke all on function public.apollo_resolve_email_review(bigint, boolean) from public, anon;
grant execute on function public.apollo_resolve_email_review(bigint, boolean) to authenticated;
